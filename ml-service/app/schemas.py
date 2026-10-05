from typing import Optional, Literal, Dict, Any
from pydantic import BaseModel, Field


class PredictionRequest(BaseModel):
    """Input features for cost prediction."""
    type: Literal["image_resize", "hash_compute", "db_query", "report_generate", "ml_inference"]
    payloadSize: int = Field(ge=0)
    iterations: int = Field(ge=0)
    priority: Literal["low", "normal", "high"] = "normal"
    precision: Literal["full", "reduced"] = "full"
    systemState: Optional[Dict[str, Any]] = None
    # Optional echo for tracing
    requestId: Optional[str] = None


class PredictionResponse(BaseModel):
    """Cost prediction output."""
    requestId: Optional[str] = None
    predictedCostMs: float = Field(ge=0)
    predictedCloudCostUsd: float = Field(ge=0)
    costTier: Literal["cheap", "medium", "expensive"]
    confidence: float = Field(ge=0, le=1)
    modelVersion: str


class ModelInfo(BaseModel):
    """Model metadata."""
    modelVersion: str
    modelType: str
    trainedAt: str
    featureColumns: list[str]
    metrics: Dict[str, float] = {}


class TrainRequest(BaseModel):
    """Training trigger."""
    modelType: Literal["linear", "random_forest"] = "random_forest"
    testSplit: float = Field(ge=0.1, le=0.5, default=0.2)
    randomState: int = 42


class TrainResponse(BaseModel):
    """Training result."""
    modelVersion: str
    modelType: str
    trainMetrics: Dict[str, float]
    testMetrics: Dict[str, float]
    trainedAt: str


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "ml-cost-predictor"
    modelLoaded: bool
    modelVersion: Optional[str] = None