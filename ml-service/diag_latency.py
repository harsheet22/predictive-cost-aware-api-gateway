import time
import requests
import json

url = "http://localhost:8000/predict"
payload = {
    "type": "image_resize",
    "payloadSize": 8602,
    "iterations": 6520,
    "priority": "low",
    "precision": "full",
    "requestId": "test-001",
    "systemState": {"cpuPct": 45, "queueDepth": 2, "concurrent": 3}
}

# Warm up
requests.post(url, json=payload)

# Measure multiple requests
latencies = []
for i in range(10):
    start = time.time()
    resp = requests.post(url, json=payload)
    elapsed = (time.time() - start) * 1000
    latencies.append(elapsed)
    print(f"Request {i+1}: {elapsed:.0f}ms, status={resp.status_code}")

print(f"\nAvg: {sum(latencies)/len(latencies):.0f}ms")
print(f"Min: {min(latencies):.0f}ms")
print(f"Max: {max(latencies):.0f}ms")

# Also test concurrent requests
import concurrent.futures
def make_request():
    start = time.time()
    r = requests.post(url, json=payload)
    return (time.time() - start) * 1000, r.status_code

print("\n=== Concurrent test (10 parallel) ===")
start = time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
    futures = [executor.submit(make_request) for _ in range(10)]
    results = [f.result() for f in concurrent.futures.as_completed(futures)]
    elapsed = (time.time() - start) * 1000
    
for i, (lat, status) in enumerate(results):
    print(f"  Request {i+1}: {lat:.0f}ms, status={status}")
print(f"Total wall time: {elapsed:.0f}ms")