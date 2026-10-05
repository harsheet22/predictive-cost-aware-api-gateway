import sys
sys.path.insert(0, 'app')
from features import extract_features, get_feature_columns, IO_MS_MAP
import numpy as np
import joblib

req = {
    'type': 'image_resize',
    'payloadSize': 8602,
    'iterations': 6520,
    'priority': 'low',
    'precision': 'full',
    'parameters': {'itemId': 31},
    'requestId': 'syn-000000',
    'systemState': {'cpuPct': 45, 'queueDepth': 2, 'concurrent': 3}
}

features = extract_features(req)
print('Features:')
for k, v in sorted(features.items()):
    print(f'  {k}: {v}')

feature_cols = get_feature_columns()
print()
print('Model feature columns:')
X = np.array([features[col] for col in get_feature_columns()]).reshape(1, -1)
print(f'X shape: {X.shape}')

model = joblib.load('models/model.pkl')
pred = model.predict(X)
print(f'Prediction: {pred[0]:.2f}ms')

print(f'ioMs for image_resize: {IO_MS_MAP["image_resize"]}')
print(f'Expected wall time: {IO_MS_MAP["image_resize"]} + CPU time')