import pandas as pd
import numpy as np
import joblib
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error

import sys
sys.path.insert(0, 'app')
from features import get_feature_columns, dataframe_to_features, prepare_target, extract_features

df = pd.read_csv('data/requests.csv')
feature_cols = get_feature_columns()
X = dataframe_to_features(df)
for col in feature_cols:
    if col not in X.columns:
        X[col] = 0.0
X = X[feature_cols]
y = df['actualWallMs'].astype(float)

_, X_test, _, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = joblib.load('models/model.pkl')

pred = model.predict(X_test)
mae = mean_absolute_error(y_test, pred)
print(f'Offline test MAE: {mae:.2f}')

errors = np.abs(pred - y_test)
print(f'Error stats:')
print(f'  Mean: {errors.mean():.2f}')
print(f'  Median: {np.median(errors):.2f}')
print(f'  Std: {errors.std():.2f}')
print(f'  95th percentile: {np.percentile(errors, 95):.2f}')
print(f'  Max: {errors.max():.2f}')

print()
print('Per-type MAE on test set:')
for rtype in df['type'].unique():
    mask = df.loc[y_test.index, 'type'] == rtype
    if mask.sum() > 0:
        ml_mae_t = mean_absolute_error(y_test[mask], pred[mask])
        print(f'  {rtype:16s}: MAE={ml_mae_t:.1f}  (n={mask.sum()})')

print()
print('Outliers (error > 20ms):')
outlier_mask = errors > 20
if outlier_mask.sum() > 0:
    outlier_indices = errors[outlier_mask].index
    for idx in outlier_indices[:10]:
        row = df.loc[idx]
        pred_idx = list(y_test.index).index(idx)
        print(f'  idx={idx}, type={row["type"]}, pred={pred[pred_idx]:.1f}, actual={y_test.loc[idx]:.1f}, error={errors.iloc[pred_idx]:.1f}')

print()
print('Feature importance from model:')
for col, imp in zip(get_feature_columns(), model.feature_importances_):
    if imp > 0.001:
        print(f'  {col}: {imp:.4f}')