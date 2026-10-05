#!/usr/bin/env python3
"""
Evaluate trained model on test data and compare with heuristic baseline.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import joblib
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, mean_absolute_percentage_error

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
from features import get_feature_columns, dataframe_to_features, prepare_target, heuristic_predict, cost_tier


def main():
    parser = argparse.ArgumentParser(description="Evaluate cost prediction model")
    parser.add_argument("--input", type=str, default="data/requests.csv", help="Input CSV dataset")
    parser.add_argument("--model", type=str, default="models/model.pkl", help="Model pickle path")
    parser.add_argument("--meta", type=str, default="models/model_meta.json", help="Model metadata path")
    parser.add_argument("--test-split", type=float, default=0.2, help="Test split ratio (must match training)")
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()

    input_path = Path(args.input)
    model_path = Path(args.model)
    meta_path = Path(args.meta)

    if not input_path.exists():
        print(f"[evaluate] Error: Input file {input_path} not found")
        sys.exit(1)
    if not model_path.exists():
        print(f"[evaluate] Error: Model file {model_path} not found")
        sys.exit(1)

    print(f"[evaluate] Loading data from {input_path}")
    df = pd.read_csv(input_path)
    print(f"[evaluate] Loaded {len(df)} samples")

    # Same split as training
    feature_cols = get_feature_columns()
    X = dataframe_to_features(df)
    for col in feature_cols:
        if col not in X.columns:
            X[col] = 0.0
    X = X[feature_cols]
    y = prepare_target(df, "actualWallMs")

    # Split with same random state
    _, X_test, _, y_test = train_test_split(X, y, test_size=args.test_split, random_state=args.random_state)
    print(f"[evaluate] Test set: {len(X_test)} samples")

    # Load model
    model = joblib.load(model_path)
    print(f"[evaluate] Loaded model from {model_path}")

    # Load metadata if available
    meta = {}
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
        print(f"[evaluate] Model version: {meta.get('modelVersion', 'unknown')}")

    # ML predictions
    ml_pred = model.predict(X_test)
    ml_mae = mean_absolute_error(y_test, ml_pred)
    ml_rmse = np.sqrt(mean_squared_error(y_test, ml_pred))
    ml_r2 = r2_score(y_test, ml_pred)
    ml_mape = mean_absolute_percentage_error(y_test, ml_pred)

    # Heuristic predictions (per-row)
    heuristic_preds = []
    for _, row in df.loc[y_test.index].iterrows():
        req = row.to_dict()
        h = heuristic_predict(req)
        heuristic_preds.append(h["predictedCostMs"])

    h_mae = mean_absolute_error(y_test, heuristic_preds)
    h_rmse = np.sqrt(mean_squared_error(y_test, heuristic_preds))
    h_r2 = r2_score(y_test, heuristic_preds)
    h_mape = mean_absolute_percentage_error(y_test, heuristic_preds)

    # Results
    print("\n=== ML Model ===")
    print(f"  MAE:  {ml_mae:.2f} ms")
    print(f"  RMSE: {ml_rmse:.2f} ms")
    print(f"  R²:   {ml_r2:.3f}")
    print(f"  MAPE: {ml_mape:.2%}")

    print("\n=== Heuristic Baseline ===")
    print(f"  MAE:  {h_mae:.2f} ms")
    print(f"  RMSE: {h_rmse:.2f} ms")
    print(f"  R²:   {h_r2:.3f}")
    print(f"  MAPE: {h_mape:.2%}")

    print("\n=== Improvement (ML vs Heuristic) ===")
    print(f"  MAE reduction:  {h_mae - ml_mae:.2f} ms ({(h_mae - ml_mae) / h_mae * 100:.1f}%)")
    print(f"  RMSE reduction: {h_rmse - ml_rmse:.2f} ms ({(h_rmse - ml_rmse) / h_rmse * 100:.1f}%)")
    print(f"  R² gain:        {ml_r2 - h_r2:.3f}")

    # Cost tier accuracy
    print("\n=== Cost Tier Classification ===")
    y_tier = y_test.apply(cost_tier).reset_index(drop=True)
    ml_tier = pd.Series(ml_pred).apply(cost_tier).reset_index(drop=True)
    h_tier = pd.Series(heuristic_preds).apply(cost_tier).reset_index(drop=True)

    ml_tier_acc = (ml_tier == y_tier).mean()
    h_tier_acc = (h_tier == y_tier).mean()
    print(f"  ML tier accuracy:       {ml_tier_acc:.1%}")
    print(f"  Heuristic tier accuracy: {h_tier_acc:.1%}")

    # Per-type breakdown
    print("\n=== Per-Type MAE (ms) ===")
    for rtype in df["type"].unique():
        mask = df.loc[y_test.index, "type"] == rtype
        if mask.sum() > 0:
            ml_mae_t = mean_absolute_error(y_test[mask], ml_pred[mask])
            h_mae_t = mean_absolute_error(y_test[mask], np.array(heuristic_preds)[mask])
            print(f"  {rtype:16s}: ML={ml_mae_t:.1f}  Heuristic={h_mae_t:.1f}  (n={mask.sum()})")


if __name__ == "__main__":
    from sklearn.model_selection import train_test_split
    main()