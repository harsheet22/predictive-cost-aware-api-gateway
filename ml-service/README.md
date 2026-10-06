# ML Service for Predictive Cost-Aware API Gateway

FastAPI service providing cost prediction for the gateway. Uses scikit-learn with heuristic fallback.

## Quick Start

```bash
cd ml-service
pip install -r requirements.txt

# Generate training data
python -m training.generate_dataset --samples 5000 --output data/requests.csv

# Train models
python -m training.train --input data/requests.csv --output models/model.pkl

# Run API server
uvicorn app.main:app --port 8000 --reload
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/predict` | Predict cost for a request |
| GET | `/model/info` | Current model metadata |
| POST | `/train` | Retrain from current dataset |
| GET | `/health` | Liveness |

## Request/Response

### POST /predict
```json
// Request
{
  "type": "hash_compute",
  "payloadSize": 4096,
  "iterations": 16000,
  "priority": "normal",
  "precision": "full",
  "systemState": { "cpuPct": 45, "queueDepth": 2, "concurrent": 3 }
}

// Response
{
  "requestId": "optional-echo",
  "predictedCostMs": 38.2,
  "predictedCloudCostUsd": 0.0000321,
  "costTier": "medium",
  "confidence": 0.87,
  "modelVersion": "rf-v1"
}
```

## Architecture

```
ml-service/
├─ app/
│  ├─ main.py           # FastAPI app + routes
│  ├─ schemas.py        # Pydantic models
│  ├─ features.py       # Feature engineering
│  ├─ predictor.py      # Model loading + inference
│  └─ model_registry.py # Model persistence
├─ training/
│  ├─ generate_dataset.py  # Drives executor, logs features + actual cost
│  ├─ train.py             # LinearRegression → RandomForest
│  └─ evaluate.py          # MAE/RMSE/R²/MAPE
├─ models/
│  └─ model.pkl           # Serialized model
├─ data/
│  └─ requests.csv        # Training data
├─ notebooks/
│  └─ exploration.ipynb   # EDA
└─ requirements.txt
```

## Prediction serving and timing

The saved RandomForest architecture, weights and features are unchanged. At
load time the service sets `n_jobs=1` in memory to avoid running a parallel
forest inside each FastAPI thread. `ML_RF_N_JOBS=-1` restores the previous
serving parallelism for comparison. This setting never rewrites `model.pkl`.
FastAPI retains a bounded four-worker thread pool. The backend defaults to
two concurrent ML HTTP calls (`ML_CONCURRENCY` can override this); the replay
benchmark selected two for the highest measured stress prediction throughput.
The prediction queue starts tasks FIFO and releases slots on success and failure.
No workload timing, admission limits, features or cost formulas are changed.

`POST /predict` preserves the prediction JSON and adds `Server-Timing` headers:

- `fastapi`: time from ASGI request entry through response-header creation,
  including request validation, thread-pool wait, feature extraction, inference
  and response serialization.
- `rf`: duration around the actual estimator's `predict()` call only.
- `worker_queue`: time from submitting work to starting it in the thread pool.

The backend records one sample per prediction attempt. `/api/metrics/live`
includes `ml.predictionCount`, `successCount`, `errorCount`, `fallbackCount`,
`serverTimingCount`, `predictionThroughputPerSec`, `avgQueueWaitMs`, `avgHttpMs`,
`avgFastapiMs`, `avgInferenceMs`, `avgWorkerQueueMs`, `avgNetworkResidualMs`,
and `avgLatencyMs` (total prediction latency, including the Node queue).
Timers use monotonic clocks. HTTP time includes reading/parsing the response;
the HTTP timeout remains active until that completes. Server duration averages
use only samples with server timing headers; missing timings are `null`.

The network residual is HTTP elapsed time minus reported FastAPI duration,
clamped at zero. It includes transport, response consumption and Node scheduling;
it is not a packet-level measurement of pure network latency. Server timings
overlap HTTP time and must not be added to it a second time. Prediction throughput
uses the measured prediction interval, including queue drain, rather than the
configured workload duration. At low load it reflects arrivals, not peak capacity.

An HTTP/transport/invalid-response prediction failure produces a completed
gateway `REJECT` with result status 503 and reason `ml_prediction_failed`.
It increments the ML error counter and balances `inFlight`, including failures
on re-prediction after DELAY. There is no automatic backend heuristic fallback.
The service's existing heuristic fallback for a missing/broken model remains;
it is identified by `X-Prediction-Fallback` and `modelVersion=heuristic-v1`, and
increments both `ml.errorCount` and `ml.fallbackCount` instead of hiding the
ML failure. Successful RandomForest predictions retain their previous values.

The waiting queue is not given a new rejection threshold. Sustained demand above
the measured pipeline capacity can still accumulate waiting work.

Validation and reproducible benchmarks (run profile benchmarks sequentially):

```powershell
# Repository root
npm test -- --runInBand --cache=false
$env:ML_SERVICE_URL = 'http://127.0.0.1:8001'
node backend/scripts/benchmark-ml.js after

# ml-service directory, in a separate terminal for the server
.\.venv\Scripts\python.exe -B -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --no-access-log
.\.venv\Scripts\python.exe -B -W ignore -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -B -W ignore benchmarks/benchmark_inference.py
```

The profile benchmark uses the existing simulator/replay, a fresh gateway per
profile, seed 42 and five seconds of configured arrivals for normal, demo,
stress, burst and heavy_tail. It warms the HTTP connection before measurement,
waits for all submitted work, and records independent timing samples so the
pre-fix duplicate metric counts cannot halve the comparison results. The demo
uses the existing profile and admission settings, without showcase overrides.
Reports and serving-concurrency comparisons are in
`backend/experiments/ml-pipeline/`.
