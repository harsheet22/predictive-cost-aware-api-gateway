import numpy as np
import os
from time import perf_counter
import pandas as pd
from typing import Dict, Any, Optional
from app.features import (
    extract_features,
    get_feature_columns,
    heuristic_predict,
    cost_tier,
    estimate_cloud_cost_usd,
)
from app.model_registry import load_model, get_model_info


_model = None
_model_meta = None
_feature_columns = get_feature_columns()


def _load():
    """Lazy load model."""
    global _model, _model_meta
    if _model is None and _model_meta is None:
        _model, _model_meta = load_model()
        if _model is not None and hasattr(_model, "n_jobs"):
            # Serving-only setting; never rewrite the saved estimator or retrain it.
            _model.n_jobs = int(os.environ.get("ML_RF_N_JOBS", "1"))


def predict(request: Dict[str, Any], timing: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Predict cost for a single request.
    Returns prediction with fallback to heuristic.
    """
    _load()

    # Try ML model first
    if _model is not None:
        try:
            features = extract_features(request)
            X = np.array([features[col] for col in _feature_columns]).reshape(1, -1)
            inference_started = perf_counter()
            try:
                predicted_ms = float(_model.predict(X)[0])
            finally:
                if timing is not None:
                    timing["inferenceMs"] = (perf_counter() - inference_started) * 1000
            predicted_ms = max(1.0, predicted_ms)  # floor at 1ms

            # Confidence from model metadata or default
            confidence = _model_meta.get("metrics", {}).get("test_r2", 0.7)
            confidence = max(0.5, min(0.95, confidence))

            model_version = _model_meta.get("modelVersion", "ml-v1")
            return _build_response(request, predicted_ms, confidence, model_version)
        except Exception:
            # Fall through to heuristic
            if timing is not None:
                timing["fallback"] = "inference_failed"

    elif timing is not None:
        timing["fallback"] = "model_unavailable"

    # Heuristic fallback
    return heuristic_fallback(request)


def heuristic_fallback(request: Dict[str, Any]) -> Dict[str, Any]:
    """Heuristic prediction with cost model."""
    h = heuristic_predict(request)
    predicted_ms = h["predictedCostMs"]
    confidence = h["confidence"]
    model_version = h["modelVersion"]

    return _build_response(request, predicted_ms, confidence, model_version)


def _build_response(request: Dict[str, Any], predicted_ms: float, confidence: float, model_version: str) -> Dict[str, Any]:
    payload_size = request.get("payloadSize", 0)
    predicted_usd = estimate_cloud_cost_usd(predicted_ms, payload_size)

    return {
        "requestId": request.get("requestId"),
        "predictedCostMs": round(predicted_ms, 2),
        "predictedCloudCostUsd": predicted_usd,
        "costTier": cost_tier(predicted_ms),
        "confidence": round(confidence, 2),
        "modelVersion": model_version,
    }


def observe(request: Dict[str, Any], actual_wall_ms: float) -> None:
    """
    Called after execution to update online learning (future enhancement).
    Currently a no-op; could append to a retraining buffer.
    """
    pass


def model_info() -> Dict[str, Any]:
    """Get model metadata."""
    return get_model_info()


def is_ml_model_loaded() -> bool:
    _load()
    return _model is not None
