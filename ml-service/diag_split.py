import pandas as pd
import numpy as np
import joblib
from sklearn.model_selection import train_test_split
import sys
sys.path.insert(0, 'app')
from features import get_feature_columns, dataframe_to_features, prepare_target

df = pd.read_csv('data/requests.csv')
feature_cols = get_feature_columns()
X = dataframe_to_features(df)
for col in feature_cols:
    if col not in X.columns:
        X[col] = 0.0
X = X[feature_cols]
y = df['actualWallMs'].astype(float)

print('df index:', df.index[:5].tolist())
print('X index:', X.index[:5].tolist())
print('y index:', y.index[:5].tolist())

# Check the split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
print('X_train index sample:', X_train.index[:5].tolist())
print('X_test index sample:', X_test.index[:5].tolist())

# Check syn-000000
idx = df.index[df['requestId'] == 'syn-000000'][0]
print('syn-000000 df index:', idx)
print('syn-000000 in X_train:', idx in X_train.index)
print('syn-000000 in X_test:', idx in X_test.index)
print('syn-000000 in y_train:', idx in y_train.index)
print('syn-000000 in y_test:', idx in y_test.index)