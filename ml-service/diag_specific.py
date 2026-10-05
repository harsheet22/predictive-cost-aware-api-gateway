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

_, X_test, _, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = joblib.load('models/model.pkl')

# Check syn-000000 specifically
idx = df.index[df['requestId'] == 'syn-000000'][0]
print('Index of syn-000000:', idx)
print('In test set:', idx in y_test.index)

if idx in y_test.index:
    test_idx = list(y_test.index).index(idx)
    print('Test index:', test_idx)
    pred = model.predict(X_test.iloc[test_idx:test_idx+1])[0]
    actual = y_test.iloc[test_idx]
    print('Prediction:', pred, 'ms')
    print('Actual:', actual, 'ms')
    print('Error:', abs(pred - actual), 'ms')
else:
    print('Not in test set')
    _, X_train, _, y_train = train_test_split(X, y, test_size=0.2, random_state=42)
    print('In train set:', idx in y_train.index)
    if idx in y_train.index:
        train_idx = list(y_train.index).index(idx)
        pred = model.predict(X_train.iloc[train_idx:train_idx+1])[0]
        actual = y_train.iloc[train_idx]
        print('In train set:')
        print('Prediction:', pred, 'ms')
        print('Actual:', actual, 'ms')
        print('Error:', abs(pred - actual), 'ms')