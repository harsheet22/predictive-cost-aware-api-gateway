# ML Service for Predictive Cost-Aware API Gateway

FastAPI service providing cost prediction for the gateway. Uses scikit-learn with heuristic fallback.

## Quick Start

```bash
cd ml-service
pip install -r requirements.txt

# Generate training data
python -m training.generate_dataset --samples 5000 --output data/requests.csv

# Train models
python -m training.train --input data/requests.csv --output models/model.pkl

# Run API server
uvicorn app.main:app --port 8000 --reload
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/predict` | Predict cost for a request |
| GET | `/model/info` | Current model metadata |
| POST | `/train` | Retrain from current dataset |
| GET | `/health` | Liveness |

## Request/Response

### POST /predict
```json
// Request
{
  "type": "hash_compute",
  "payloadSize": 4096,
  "iterations": 16000,
  "priority": "normal",
  "precision": "full",
  "systemState": { "cpuPct": 45, "queueDepth": 2, "concurrent": 3 }
}

// Response
{
  "requestId": "optional-echo",
  "predictedCostMs": 38.2,
  "predictedCloudCostUsd": 0.0000321,
  "costTier": "medium",
  "confidence": 0.87,
  "modelVersion": "rf-v1"
}
```

## Architecture

```
ml-service/
├─ app/
│  ├─ main.py           # FastAPI app + routes
│  ├─ schemas.py        # Pydantic models
│  ├─ features.py       # Feature engineering
│  ├─ predictor.py      # Model loading + inference
│  └─ model_registry.py # Model persistence
├─ training/
│  ├─ generate_dataset.py  # Drives executor, logs features + actual cost
│  ├─ train.py             # LinearRegression → RandomForest
│  └─ evaluate.py          # MAE/RMSE/R²/MAPE
├─ models/
│  └─ model.pkl           # Serialized model
├─ data/
│  └─ requests.csv        # Training data
├─ notebooks/
│  └─ exploration.ipynb   # EDA
└─ requirements.txt
```