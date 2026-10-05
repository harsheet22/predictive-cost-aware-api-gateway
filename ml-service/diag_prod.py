import json
import sys
import os
sys.path.insert(0, 'app')

# Simulate a production request to see what features are sent
from features import extract_features, get_feature_columns

# Simulate a typical production request
req = {
    'type': 'image_resize',
    'payloadSize': 8602,
    'iterations': 6520,
    'priority': 'low',
    'precision': 'full',
    'parameters': {'itemId': 31},
    'requestId': 'syn-000000'
}

systemState = {
    'cpuPct': 45,
    'queueDepth': 2,
    'concurrent': 3
}

features = extract_features(req)
print('=== PRODUCTION FEATURES (with systemState) ===')
for k, v in sorted(features.items()):
    print(f'  {k}: {v}')

# Also check what the ML client sends
print()
print('=== ML CLIENT PAYLOAD ===')
payload = {
    'type': 'image_resize',
    'payloadSize': 8602,
    'iterations': 6520,
    'priority': 'low',
    'precision': 'full',
    'requestId': 'syn-000000',
    'systemState': {'cpuPct': 45, 'queueDepth': 2, 'concurrent': 3}
}
print(json.dumps(payload, indent=2))