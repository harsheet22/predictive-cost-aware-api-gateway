#!/usr/bin/env python3
"""
Train cost prediction model from generated dataset.
Supports LinearRegression and RandomForestRegressor.
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
from features import get_feature_columns, dataframe_to_features, prepare_target


MODEL_TYPES = {
    "linear": LinearRegression,
    "random_forest": RandomForestRegressor,
}


def main():
    parser = argparse.ArgumentParser(description="Train cost prediction model")
    parser.add_argument("--input", type=str, default="data/requests.csv", help="Input CSV dataset")
    parser.add_argument("--output", type=str, default="models/model.pkl", help="Output model path")
    parser.add_argument("--meta", type=str, default="models/model_meta.json", help="Output metadata path")
    parser.add_argument("--model-type", type=str, choices=["linear", "random_forest"], default="random_forest")
    parser.add_argument("--test-split", type=float, default=0.2, help="Test split ratio")
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--n-estimators", type=int, default=100, help="RandomForest n_estimators")
    parser.add_argument("--max-depth", type=int, default=10, help="RandomForest max_depth")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    meta_path = Path(args.meta)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        print(f"[train] Error: Input file {input_path} not found")
        sys.exit(1)

    print(f"[train] Loading data from {input_path}")
    df = pd.read_csv(input_path)
    print(f"[train] Loaded {len(df)} samples")

    if len(df) < 50:
        print("[train] Error: Insufficient data (need >= 50 samples)")
        sys.exit(1)

    # Prepare features and target
    feature_cols = get_feature_columns()
    X = dataframe_to_features(df)

    # Ensure all feature columns exist
    for col in feature_cols:
        if col not in X.columns:
            X[col] = 0.0
    X = X[feature_cols]

    y = prepare_target(df, "actualWallMs")

    print(f"[train] Features: {list(X.columns)}")
    print(f"[train] Target range: {y.min():.1f} - {y.max():.1f} ms")

    # Split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_split, random_state=args.random_state
    )

    print(f"[train] Train: {len(X_train)}, Test: {len(X_test)}")

    # Train
    ModelClass = MODEL_TYPES[args.model_type]
    if args.model_type == "random_forest":
        model = ModelClass(
            n_estimators=args.n_estimators,
            max_depth=args.max_depth,
            random_state=args.random_state,
            n_jobs=-1,
        )
    else:
        model = ModelClass()

    print(f"[train] Training {args.model_type}...")
    model.fit(X_train, y_train)

    # Evaluate
    train_pred = model.predict(X_train)
    test_pred = model.predict(X_test)

    train_metrics = {
        "mae": float(mean_absolute_error(y_train, train_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_train, train_pred))),
        "r2": float(r2_score(y_train, train_pred)),
    }
    test_metrics = {
        "mae": float(mean_absolute_error(y_test, test_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_test, test_pred))),
        "r2": float(r2_score(y_test, test_pred)),
    }

    print(f"[train] Train MAE={train_metrics['mae']:.2f} RMSE={train_metrics['rmse']:.2f} R²={train_metrics['r2']:.3f}")
    print(f"[train] Test  MAE={test_metrics['mae']:.2f} RMSE={test_metrics['rmse']:.2f} R²={test_metrics['r2']:.3f}")

    # Feature importance (for RandomForest)
    feature_importance = {}
    if hasattr(model, "feature_importances_"):
        for col, imp in zip(feature_cols, model.feature_importances_):
            feature_importance[col] = float(imp)
        print("[train] Feature importance:")
        for col, imp in sorted(feature_importance.items(), key=lambda x: -x[1])[:10]:
            print(f"  {col}: {imp:.4f}")

    # Save model
    joblib.dump(model, output_path)
    print(f"[train] Model saved to {output_path}")

    # Save metadata
    meta = {
        "modelVersion": f"{args.model_type}-v{datetime.now().strftime('%Y%m%d%H%M%S')}",
        "modelType": args.model_type,
        "trainedAt": datetime.now().isoformat(),
        "featureColumns": feature_cols,
        "trainMetrics": train_metrics,
        "testMetrics": test_metrics,
        "featureImportance": feature_importance,
        "hyperparameters": {
            "test_split": args.test_split,
            "random_state": args.random_state,
            "n_estimators": args.n_estimators if args.model_type == "random_forest" else None,
            "max_depth": args.max_depth if args.model_type == "random_forest" else None,
        },
        "dataStats": {
            "n_samples": int(len(df)),
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
            "target_min": float(y.min()),
            "target_max": float(y.max()),
            "target_mean": float(y.mean()),
        },
    }

    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[train] Metadata saved to {meta_path}")


if __name__ == "__main__":
    main()