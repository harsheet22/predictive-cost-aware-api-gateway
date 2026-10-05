import joblib
import json
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, Optional
import numpy as np
from sklearn.base import BaseEstimator


MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)

MODEL_PATH = MODEL_DIR / "model.pkl"
META_PATH = MODEL_DIR / "model_meta.json"


def save_model(
    model: BaseEstimator,
    model_type: str,
    feature_columns: list,
    metrics: Dict[str, float],
    version: Optional[str] = None,
) -> str:
    """Save model and metadata."""
    if version is None:
        version = f"{model_type}-v{datetime.now().strftime('%Y%m%d%H%M%S')}"

    # Save model
    joblib.dump(model, MODEL_PATH)

    # Save metadata
    meta = {
        "modelVersion": version,
        "modelType": model_type,
        "trainedAt": datetime.now().isoformat(),
        "featureColumns": feature_columns,
        "metrics": metrics,
    }
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    return version


def load_model() -> tuple[Optional[BaseEstimator], Dict[str, Any]]:
    """Load model and metadata. Returns (model, meta) or (None, {})."""
    if not MODEL_PATH.exists():
        return None, {}

    try:
        model = joblib.load(MODEL_PATH)
        meta = {}
        if META_PATH.exists():
            with open(META_PATH) as f:
                meta = json.load(f)
        return model, meta
    except Exception:
        return None, {}


def get_model_info() -> Dict[str, Any]:
    """Get model metadata for /model/info endpoint."""
    _, meta = load_model()
    if not meta:
        return {
            "modelVersion": "heuristic-v1",
            "modelType": "heuristic",
            "trainedAt": datetime.now().isoformat(),
            "featureColumns": [],
            "metrics": {},
        }
    return meta


def predict_with_model(model: BaseEstimator, X: np.ndarray) -> np.ndarray:
    """Safe prediction with shape handling."""
    if X.ndim == 1:
        X = X.reshape(1, -1)
    return model.predict(X)