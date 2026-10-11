import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import joblib
import numpy as np
import pandas as pd
from app.inference import predict_exact
from app.features import dataframe_to_features, get_feature_columns
from app import model_registry


class ExactInferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = joblib.load(model_registry.MODEL_PATH)
        cls.model.n_jobs = 1
        dataset = Path(__file__).resolve().parents[1] / 'data' / 'requests.csv'
        cls.matrix = dataframe_to_features(pd.read_csv(dataset))[get_feature_columns()].to_numpy()

    def test_full_dataset_predictions_match_original_forest(self):
        artifact_before = hashlib.sha256(model_registry.MODEL_PATH.read_bytes()).digest()
        expected = self.model.predict(self.matrix)
        actual = predict_exact(self.model, self.matrix)
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)
        self.assertEqual(artifact_before, hashlib.sha256(model_registry.MODEL_PATH.read_bytes()).digest())

    def test_single_requests_and_concurrent_calls_are_identical(self):
        rows = self.matrix[:24]
        expected = self.model.predict(rows)
        with ThreadPoolExecutor(max_workers=4) as pool:
            actual = list(pool.map(lambda row: predict_exact(self.model, row.reshape(1, -1))[0], rows))
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)

    def test_boundary_inputs_preserve_float32_tree_routing(self):
        rows = np.vstack([np.zeros((1, self.model.n_features_in_)), self.matrix[:50], self.matrix[:50] + 1e-8])
        np.testing.assert_allclose(predict_exact(self.model, rows), self.model.predict(rows), rtol=0, atol=1e-12)

    def test_other_models_use_original_prediction(self):
        model = Mock()
        model.predict.return_value = np.array([42.0])
        np.testing.assert_array_equal(predict_exact(model, self.matrix[:1]), [42.0])
        model.predict.assert_called_once()

    def test_status_metadata_does_not_deserialize_model(self):
        with patch.object(model_registry.joblib, 'load', side_effect=AssertionError('unexpected model reload')):
            info = model_registry.get_model_info()
        self.assertIn('modelVersion', info)
        self.assertEqual(info['featureColumns'], get_feature_columns())


if __name__ == '__main__':
    unittest.main()
