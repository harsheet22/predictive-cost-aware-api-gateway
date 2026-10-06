import asyncio
import os
import threading
import time
import unittest
from unittest.mock import patch, Mock

import httpx
import joblib
import numpy as np

from app import predictor, main
from app.features import extract_features, get_feature_columns
from app.model_registry import MODEL_PATH


REQUEST = {
    "type": "image_resize", "payloadSize": 8602, "iterations": 6520,
    "priority": "low", "precision": "full", "requestId": "test",
}
PREDICTION = {
    "requestId": "test", "predictedCostMs": 30, "predictedCloudCostUsd": 0.000002,
    "costTier": "medium", "confidence": 0.7, "modelVersion": "rf-test",
}


def timings(response):
    return dict((name, float(duration)) for name, duration in (
        part.strip().split(";dur=") for part in response.headers["server-timing"].split(",")
    ))


class PredictorTests(unittest.TestCase):
    def test_inference_timer_excludes_feature_extraction_and_response_cost(self):
        model = Mock()
        model.predict.return_value = np.array([30.0])
        with patch.object(predictor, "_model", model), \
             patch.object(predictor, "_model_meta", {"modelVersion": "rf-test"}), \
             patch.object(predictor, "perf_counter", side_effect=[10, 10.025]):
            timing = {}
            result = predictor.predict(REQUEST, timing)
        self.assertAlmostEqual(timing["inferenceMs"], 25)
        self.assertEqual(result["predictedCostMs"], 30)
        self.assertNotIn("timings", result)
        self.assertNotIn("fallback", timing)

    def test_inference_failure_retains_existing_heuristic_and_marks_reason(self):
        model = Mock()
        model.predict.side_effect = RuntimeError("broken")
        with patch.object(predictor, "_model", model), patch.object(predictor, "_model_meta", {}):
            timing = {}
            result = predictor.predict(REQUEST, timing)
        self.assertEqual(result["modelVersion"], "heuristic-v1")
        self.assertEqual(timing["fallback"], "inference_failed")
        self.assertGreaterEqual(timing["inferenceMs"], 0)

    def test_missing_model_fallback_is_explicit(self):
        with patch.object(predictor, "_model", None), patch.object(predictor, "_model_meta", {}):
            timing = {}
            result = predictor.predict(REQUEST, timing)
        self.assertEqual(result["modelVersion"], "heuristic-v1")
        self.assertEqual(timing["fallback"], "model_unavailable")

    def test_runtime_parallelism_does_not_change_saved_forest_or_predictions(self):
        model = joblib.load(MODEL_PATH)
        stored_jobs = model.n_jobs
        features = extract_features(REQUEST)
        matrix = np.array([features[col] for col in get_feature_columns()]).reshape(1, -1)
        model.n_jobs = -1
        expected = model.predict(matrix)
        model.n_jobs = 1
        np.testing.assert_allclose(model.predict(matrix), expected, rtol=1e-12, atol=1e-12)
        self.assertEqual(model.n_estimators, 100)
        self.assertEqual(model.max_depth, 10)
        self.assertEqual(joblib.load(MODEL_PATH).n_jobs, stored_jobs)

    def test_serving_configuration_is_applied_when_loading(self):
        model = Mock()
        with patch.object(predictor, "_model", None), patch.object(predictor, "_model_meta", None), \
             patch.object(predictor, "load_model", return_value=(model, {})), \
             patch.dict(os.environ, {"ML_RF_N_JOBS": "1"}):
            predictor._load()
            self.assertEqual(model.n_jobs, 1)


class FastapiTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_timings_include_processing_and_actual_inference_without_changing_json(self):
        def predict(_request, timing):
            timing["inferenceMs"] = 0.125
            return PREDICTION.copy()

        with patch.object(main, "predict", side_effect=predict):
            async with main.lifespan(main.app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
                    response = await client.post("/predict", json=REQUEST)
                    invalid = await client.post("/predict", json={"type": "invalid"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), PREDICTION)
        durations = timings(response)
        self.assertGreater(durations["fastapi"], 0)
        self.assertEqual(durations["rf"], 0.125)
        self.assertGreaterEqual(durations["worker_queue"], 0)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(timings(invalid)["rf"], 0)

    async def test_fallback_reason_is_exposed_in_header(self):
        def predict(_request, timing):
            timing["fallback"] = "inference_failed"
            return {**PREDICTION, "modelVersion": "heuristic-v1"}

        with patch.object(main, "predict", side_effect=predict):
            async with main.lifespan(main.app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
                    response = await client.post("/predict", json=REQUEST)
        self.assertEqual(response.headers["x-prediction-fallback"], "inference_failed")
        self.assertEqual(response.json()["modelVersion"], "heuristic-v1")

    async def test_fastapi_workers_remain_bounded_under_parallel_http_requests(self):
        active = peak = 0
        lock = threading.Lock()

        def predict(_request, timing):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            timing["inferenceMs"] = 10
            return PREDICTION.copy()

        with patch.object(main, "predict", side_effect=predict):
            async with main.lifespan(main.app):
                workers = main.app.state.executor._max_workers
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
                    tasks = [asyncio.create_task(client.post("/predict", json=REQUEST)) for _ in range(12)]
                    responses = [await task for task in tasks]
        self.assertLessEqual(peak, workers)
        self.assertEqual(active, 0)
        self.assertTrue(all(response.status_code == 200 for response in responses))


if __name__ == "__main__":
    unittest.main()
