"""Exact dense RandomForest serving: same trees, order and arithmetic.

Avoid per-request joblib dispatch. Unsupported inputs/models use sklearn's
original predict path. Never modify the fitted estimator or model artifact.
"""
import numpy as np
from sklearn.ensemble import RandomForestRegressor


def predict_exact(model, matrix):
    if not isinstance(model, RandomForestRegressor) or model.n_outputs_ != 1:
        return model.predict(matrix)
    matrix = np.asarray(matrix, dtype=np.float32, order="C")
    if (matrix.ndim != 2 or matrix.shape[1] != model.n_features_in_
            or not matrix.shape[0] or not np.isfinite(matrix).all()):
        return model.predict(matrix)
    result = np.zeros(matrix.shape[0], dtype=np.float64)
    for tree in model.estimators_:
        result += tree.predict(matrix, check_input=False)
    return result / len(model.estimators_)
