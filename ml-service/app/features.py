import pandas as pd
import numpy as np
from typing import Dict, Any, List


# Request type encoding
TYPE_MAP = {
    "db_query": 0,
    "image_resize": 1,
    "hash_compute": 2,
    "ml_inference": 3,
    "report_generate": 4,
}

PRIORITY_MAP = {"low": 0, "normal": 1, "high": 2}
PRECISION_MAP = {"reduced": 0, "full": 1}

# ioMs is deterministic per request type (known before execution)
IO_MS_MAP = {
    "db_query": 30,
    "image_resize": 8,
    "hash_compute": 4,
    "ml_inference": 12,
    "report_generate": 20,
}

# Feature columns in exact order used by the model
FEATURE_COLUMNS = [
    "type_encoded",
    "iterations",
    "type_x_iter",
    "type_x_payload",
    "iterations_k",
    "payload_kb",
    "payloadSize",
    "priority_encoded",
    "precision_encoded",
    "ioMs",
]


def extract_features(request: Dict[str, Any]) -> Dict[str, float]:
    """Extract ML features from a request dict. Uses exact same schema for training and production."""
    features = {}

    # Categorical encodings
    features["type_encoded"] = TYPE_MAP.get(request.get("type", "hash_compute"), 2)
    features["priority_encoded"] = PRIORITY_MAP.get(request.get("priority", "normal"), 1)
    features["precision_encoded"] = PRECISION_MAP.get(request.get("precision", "full"), 1)

    # Numerical features
    features["payloadSize"] = float(request.get("payloadSize", 0))
    features["iterations"] = float(request.get("iterations", 0))

    # Derived features
    features["payload_kb"] = features["payloadSize"] / 1024.0
    features["iterations_k"] = features["iterations"] / 1000.0

    # ioMs is known before execution (deterministic per request type)
    features["ioMs"] = float(IO_MS_MAP.get(request.get("type", ""), 0))

    # Interaction features
    features["type_x_payload"] = features["type_encoded"] * features["payload_kb"]
    features["type_x_iter"] = features["type_encoded"] * features["iterations_k"]

    return features


def dataframe_to_features(df: pd.DataFrame) -> pd.DataFrame:
    """Convert request dataframe to feature matrix using exact same schema."""
    feature_rows = []
    for _, row in df.iterrows():
        feature_rows.append(extract_features(row))
    return pd.DataFrame(feature_rows, columns=FEATURE_COLUMNS)


def get_feature_columns() -> List[str]:
    """Return ordered list of feature column names - MUST match model training order."""
    return FEATURE_COLUMNS.copy()


def prepare_target(df: pd.DataFrame, target_col: str = "actualWallMs") -> pd.Series:
    """Extract target variable."""
    return df[target_col].astype(float)


# Heuristic fallback predictions (per-type medians)
HEURISTIC_MEDIANS = {
    "db_query": 55.0,
    "image_resize": 35.0,
    "hash_compute": 30.0,
    "ml_inference": 35.0,
    "report_generate": 70.0,
}

HEURISTIC_CONFIDENCE = {
    "db_query": 0.55,
    "image_resize": 0.65,
    "hash_compute": 0.70,
    "ml_inference": 0.65,
    "report_generate": 0.60,
}


def heuristic_predict(request: Dict[str, Any]) -> Dict[str, Any]:
    """Heuristic prediction using per-type medians."""
    rtype = request.get("type", "hash_compute")
    predicted_ms = HEURISTIC_MEDIANS.get(rtype, 40.0)
    confidence = HEURISTIC_CONFIDENCE.get(rtype, 0.6)

    # Adjust for precision
    if request.get("precision") == "reduced":
        predicted_ms *= 0.25

    # Adjust for priority (high priority might get more resources)
    if request.get("priority") == "high":
        predicted_ms *= 0.9

    return {
        "predictedCostMs": predicted_ms,
        "confidence": confidence,
        "modelVersion": "heuristic-v1",
    }


def cost_tier(ms: float) -> str:
    """Classify cost tier from predicted milliseconds."""
    if ms < 20:
        return "cheap"
    elif ms > 50:
        return "expensive"
    return "medium"


def estimate_cloud_cost_usd(ms: float, payload_size: int) -> float:
    """Shared cost model (matches backend)."""
    billed_ms = max(1.0, ms)
    sec = billed_ms / 1000.0
    vcpu = 1
    mem_mb = 512
    price_vcpu_sec = 0.0000166667
    price_gb_sec = 0.0000166667
    price_inv = 0.0000002
    price_gb_egress = 0.09

    compute = sec * vcpu * price_vcpu_sec
    memory = sec * (mem_mb / 1024) * price_gb_sec
    invocation = price_inv
    egress = (payload_size / 1e9) * price_gb_egress

    return round(compute + memory + invocation + egress, 9)