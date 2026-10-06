"""Compare serving parallelism without changing the saved model or dataset.

Run from ml-service: python -B benchmarks/benchmark_inference.py
Each setting uses three bounded-worker trials; throughput is the median.
"""
import json
import statistics
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.features import extract_features, get_feature_columns
from app.model_registry import MODEL_PATH


def main():
    warnings.filterwarnings("ignore", category=UserWarning)
    model = joblib.load(MODEL_PATH)
    features = extract_features({"type": "image_resize", "payloadSize": 8602,
                                "iterations": 6520, "priority": "low", "precision": "full"})
    matrix = np.array([features[col] for col in get_feature_columns()]).reshape(1, -1)
    expected = model.predict(matrix)[0]
    results = []

    def infer(_):
        started = time.perf_counter()
        value = model.predict(matrix)[0]
        if abs(value - expected) > 1e-10:
            raise AssertionError("serving configuration changed model predictions")
        return (time.perf_counter() - started) * 1000

    for jobs in (-1, 1):
        model.n_jobs = jobs
        for workers in (1, 2, 4, 8):
            measurements, elapsed = [], []
            for _ in range(3):
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    started = time.perf_counter()
                    # A fixed calibration sample count; active work is bounded.
                    measurements.extend(pool.map(infer, range(100)))
                    elapsed.append(time.perf_counter() - started)
            result = {"n_jobs": jobs, "workers": workers,
                      "predictions_per_sec": round(100 / statistics.median(elapsed), 2),
                      "mean_inference_ms": round(statistics.mean(measurements), 3)}
            results.append(result)
            print(json.dumps(result), flush=True)
    output = Path(__file__).resolve().parents[2] / "backend/experiments/ml-pipeline/rf-concurrency.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
