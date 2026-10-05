import pandas as pd
import numpy as np
import joblib
from sklearn.model_selection import train_test_split
import sys
sys.path.insert(0, 'app')
from features import get_feature_columns, dataframe_to_features, prepare_target

df = pd.read_csv('data/requests.csv')
feature_cols = ['type_encoded', 'iterations', 'type_x_iter', 'type_x_payload', 'iterations_k', 'payload_kb', 'payloadSize', 'priority_encoded', 'precision_encoded', 'ioMs']
X = dataframe_to_features(df)
for col in feature_cols:
    if col not in X.columns:
        X[col] = 0.0
X = X[feature_cols]
y = df['actualWallMs'].astype(float)

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = joblib.load('models/model.pkl')

idx = df.index[df['requestId'] == 'syn-000000'][0]
train_idx = list(y_train.index).index(idx)
print('Train index:', train_idx)

X_train_row = X_train.iloc[train_idx:train_idx+1]
y_train_row = y_train.iloc[train_idx]

print('X_train row:')
for col in feature_cols:
    print(f'  {col}: {X_train_row[col].values[0]}')
print('y_train:', y_train_row)

pred = model.predict(X_train_row)[0]
actual = y_train_row.values[0]
print('Prediction:', pred, 'ms')
print('Actual:', actual, 'ms')
print('Error:', abs(pred - actual), 'ms')