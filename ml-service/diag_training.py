import pandas as pd
import numpy as np

df = pd.read_csv('data/requests.csv')
print('=== TRAINING DATA (full 1000 samples) ===')
print(f'Samples: {len(df)}')

feature_cols = [
    'type_encoded', 'iterations', 'type_x_iter', 'type_x_payload', 
    'iterations_k', 'payload_kb', 'payloadSize', 'priority_encoded',
    'cpuPct', 'queueDepth', 'concurrent', 'precision_encoded', 
    'priority_x_concurrent'
]

print()
print('=== TRAINING FEATURE STATS ===')
for col in feature_cols:
    if col in df.columns:
        print(f'{col}: min={df[col].min():.2f}, max={df[col].max():.2f}, mean={df[col].mean():.2f}, std={df[col].std():.2f}')

print()
print('=== ioMs stats ===')
print(df['actualIoMs'].value_counts().sort_index())