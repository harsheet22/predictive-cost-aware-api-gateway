from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from time import perf_counter
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from typing import Optional
import uvicorn
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import asyncio

from app.schemas import (
    PredictionRequest,
    PredictionResponse,
    ModelInfo,
    TrainRequest,
    TrainResponse,
    HealthResponse,
)
from app.predictor import predict, model_info, is_ml_model_loaded
from app.timing import PredictionTimingMiddleware
from app.features import cost_tier, estimate_cloud_cost_usd
from app.model_registry import save_model
from app.features import get_feature_columns, dataframe_to_features, prepare_target

# Training imports (lazy loaded)
import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from datetime import datetime
import joblib


# ---- Lifespan ----
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: try to load existing model
    print("[ML Service] Starting up...")
    if is_ml_model_loaded():
        print("[ML Service] ML model loaded successfully")
    else:
        print("[ML Service] No ML model found, using heuristic fallback")
    
    # Create thread pool for ML predictions
    app.state.executor = ThreadPoolExecutor(max_workers=4)
    
    yield
    
    print("[ML Service] Shutting down...")
    app.state.executor.shutdown(wait=True)


app = FastAPI(
    title="ML Cost Predictor",
    description="Predicts computational cost of API requests for the Predictive Gateway",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.add_middleware(PredictionTimingMiddleware)


# ---- Routes ----
@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        service="ml-cost-predictor",
        modelLoaded=is_ml_model_loaded(),
        modelVersion=model_info().get("modelVersion"),
    )


@app.get("/v1/models")
async def list_models():
    """OpenAI-compatible model listing endpoint."""
    info = model_info()
    return {
        "object": "list",
        "data": [{
            "id": info.get("modelVersion", "heuristic-v1"),
            "object": "model",
            "created": int(datetime.now().timestamp()),
            "owned_by": "predictive-gateway"
        }]
    }


@app.get("/model/info", response_model=ModelInfo)
async def get_model_info():
    info = model_info()
    return ModelInfo(**info)


@app.post("/predict", response_model=PredictionResponse)
async def predict_endpoint(req: PredictionRequest, request: Request):
    """Predict cost for a single request (runs in thread pool to avoid blocking)."""
    loop = asyncio.get_event_loop()
    request_dict = req.model_dump()
    timing = {}
    request.state.prediction_timing = timing
    submitted = perf_counter()

    def predict_in_worker():
        timing["workerQueueMs"] = (perf_counter() - submitted) * 1000
        return predict(request_dict, timing)
    # Run prediction in thread pool to avoid blocking event loop
    result = await loop.run_in_executor(
        app.state.executor,
        predict_in_worker,
    )
    return PredictionResponse(**result)


@app.post("/train", response_model=TrainResponse)
async def train_endpoint(req: TrainRequest, background_tasks: BackgroundTasks):
    """Trigger model retraining from current dataset."""
    # Run training in background to avoid blocking
    background_tasks.add_task(_train_model, req.modelType, req.testSplit, req.randomState)
    return TrainResponse(
        modelVersion="training-started",
        modelType=req.modelType,
        trainMetrics={},
        testMetrics={},
        trainedAt=datetime.now().isoformat(),
    )


# ---- Training ----
DATA_PATH = "data/requests.csv"
MODEL_TYPES = {"linear": LinearRegression, "random_forest": RandomForestRegressor}


def _train_model(model_type: str, test_split: float, random_state: int) -> None:
    """Background training task."""
    print(f"[ML Service] Starting training: {model_type}")

    try:
        # Load data
        df = pd.read_csv(DATA_PATH)
        print(f"[ML Service] Loaded {len(df)} samples from {DATA_PATH}")

        if len(df) < 50:
            print("[ML Service] Insufficient data for training (need >= 50)")
            return

        # Features and target
        X = dataframe_to_features(df)
        y = prepare_target(df, "actualWallMs")

        # Ensure feature columns match
        feature_cols = get_feature_columns()
        for col in feature_cols:
            if col not in X.columns:
                X[col] = 0.0
        X = X[feature_cols]

        # Split
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_split, random_state=random_state
        )

        # Train
        ModelClass = MODEL_TYPES[model_type]
        if model_type == "random_forest":
            model = ModelClass(n_estimators=100, max_depth=10, random_state=random_state, n_jobs=-1)
        else:
            model = ModelClass()

        model.fit(X_train, y_train)

        # Evaluate
        train_pred = model.predict(X_train)
        test_pred = model.predict(X_test)

        train_metrics = {
            "mae": float(mean_absolute_error(y_train, train_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_train, train_pred))),
            "r2": float(r2_score(y_train, train_pred)),
        }
        test_metrics = {
            "mae": float(mean_absolute_error(y_test, test_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_test, test_pred))),
            "r2": float(r2_score(y_test, test_pred)),
        }

        print(f"[ML Service] Train: MAE={train_metrics['mae']:.2f}, RMSE={train_metrics['rmse']:.2f}, R²={train_metrics['r2']:.3f}")
        print(f"[ML Service] Test:  MAE={test_metrics['mae']:.2f}, RMSE={test_metrics['rmse']:.2f}, R²={test_metrics['r2']:.3f}")

        # Save
        version = save_model(
            model=model,
            model_type=model_type,
            feature_columns=feature_cols,
            metrics={**train_metrics, **{f"test_{k}": v for k, v in test_metrics.items()}},
        )
        print(f"[ML Service] Model saved as {version}")

    except Exception as e:
        print(f"[ML Service] Training failed: {e}")


# ---- CLI entry point ----
if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
