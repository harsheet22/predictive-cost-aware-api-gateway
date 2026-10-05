import pandas as pd
import numpy as np
import joblib
import sys
sys.path.insert(0, 'app')
from features import get_feature_columns, dataframe_to_features, prepare_target
from sklearn.model_selection import train_test_split

df = pd.read_csv('data/requests.csv')
feature_cols = get_feature_columns()
X = dataframe_to_features(df)
for col in feature_cols:
    if col not in X.columns:
        X[col] = 0.0
X = X[feature_cols]
y = df['actualWallMs'].astype(float)

# Same split as training
_, X_test, _, y_test = train_test_split(X, df['actualWallMs'].astype(float), test_size=0.2, random_state=42)

print('=== OFFLINE TEST SET (200 samples) ===')
print(f'Samples: {len(X_test)}')
print()

feature_cols = get_feature_columns()
print('=== OFFLINE TEST FEATURE STATS ===')
for col in feature_cols:
    if col in X_test.columns:
        print(f'{col}: min={X_test[col].min():.2f}, max={X_test[col].max():.2f}, mean={X_test[col].mean():.2f}, std={X_test[col].std():.2f}')

print()
print('=== ioMs in test set ===')
# ioMs is not directly in X_test, need to check from original df
test_indices = X_test.index
print(df.loc[y_test.index, 'actualIoMs'].value_counts().sort_index())