# Predictive Cost-Aware API Gateway for Intelligent Cloud Resource Optimization

A local-first, zero-cost demonstration that compares two systems under the **same
incoming workload**:

1. **Baseline Gateway** — traditional request-count / rate-based handling. Cost-blind:
   it admits work until a fixed token bucket or concurrency cap is hit, then rejects.
2. **Predictive Gateway** _(step 2)_ — estimates each request's computational cost
   *before* execution and uses a budget/resource limit to decide
   **ALLOW / DELAY / DOWNGRADE / REJECT**.

The project is designed to be built and graded entirely on localhost. AWS
(API Gateway, Lambda, DynamoDB, S3, CloudWatch, EventBridge) is a documented
mapping plus an optional final deployment — never a prerequisite.

---

## Status

| Step | Scope | State |
|------|-------|-------|
| 1 | Shared schemas, config, executor, seeded simulator, cost model, metrics, **baseline gateway**, HTTP API | ✅ done |
| 2 | **Predictive gateway + decision engine (ALLOW/DELAY/DOWNGRADE/REJECT) + heuristic cost predictor** | ✅ done |
| 3 | **ML service (FastAPI): dataset generator, RandomForest, `/predict` with heuristic fallback** | ✅ done |
| 4 | **React dashboard (live comparison, cost, decision breakdown)** | ✅ done |
| 5 | **Experiment runner across profiles + JSON/CSV report export** | ✅ done |
| 6 | Optional AWS deployment (SAM) | ⏳ next |

---

## Architecture (local)

```
        React dashboard (:5173)  ──poll──▶  Backend API (Express :3000)
                                                │
                         ┌──────────────────────┴───────────────────────┐
                         ▼                                               ▼
                 BASELINE GATEWAY                              PREDICTIVE GATEWAY
                 count/rate only                               predict → decide
                         │                                               │
                         │                                     ┌─────────┴─────────┐
                         │                                     ▼                   ▼
                         │                              ML service (:8000)   budget/utilization
                         │                              cost prediction       decision engine
                         └──────────────────────┬──────────────────────────────┘
                                                ▼
                                   SHARED EXECUTOR (identical jobs)
                                   CPU hash rounds + simulated I/O
                                                ▼
                                   METRICS + COST CALCULATOR
```

**Fairness rule:** both gateways receive an identical, seeded request stream from
one simulator and share the exact same executor. Only admission/scheduling
differs, so any difference is attributable to the gateway.

---

## Folder structure

```
.
├─ package.json                     # backend deps + scripts (Express installed here)
├─ shared/
│  ├─ schemas/                      # JSON Schema contracts
│  │  ├─ request.schema.json
│  │  ├─ prediction.schema.json
│  │  ├─ decision.schema.json
│  │  ├─ result.schema.json
│  │  └─ metrics.schema.json
│  └─ fixtures/sample-requests.json
├─ backend/
│  ├─ scripts/
│  │  ├─ demo.js                    # drive a seeded workload through a gateway, print metrics
│  │  ├─ calibrate.js               # measure this machine's CPU throughput
│  │  ├─ showcase.js                # demo all four decisions with overridden limits
│  │  └─ experiment.js              # automated runner across all profiles, JSON/CSV export
│  └─ src/
│     ├─ config.js                  # ports, jobs, cost model, limits, simulator profiles
│     ├─ index.js                   # Express app + gateway registry
│     ├─ gateways/
│     │  ├─ baselineGateway.js
│     │  └─ predictiveGateway.js
│     ├─ decision/
│     │  ├─ limiters.js             # TokenBucket, ConcurrencyGuard, QueuedConcurrencyGuard
│     │  ├─ decisionEngine.js       # ALLOW/DELAY/DOWNGRADE/REJECT logic
│     │  ├─ heuristicPredictor.js   # per-type median cost predictor (ML fallback)
│     │  └─ cache.js                # LRU cache for DOWNGRADE path
│     ├─ workload/
│     │  ├─ jobs.js                 # job catalogue + raw work functions
│     │  └─ executor.js             # runs a request and MEASURES its true cost
│     ├─ simulator/
│     │  ├─ distributions.js        # seeded PRNG, Poisson arrivals, weighted choice
│     │  └─ simulator.js            # deterministic request-stream generator
│     ├─ metrics/
│     │  ├─ metricsStore.js         # throughput, latency percentiles, cost, prediction error
│     │  └─ costCalculator.js       # shared predicted/actual cost model
│     └─ routes/
│        ├─ health.js  metrics.js  execute.js
└─ ml-service/                      # Python FastAPI cost predictor
   ├─ app/
   │  ├─ main.py                    # FastAPI app + routes (/predict, /model/info, /health)
   │  ├─ schemas.py                 # Pydantic request/response models
   │  ├─ features.py                # Feature engineering + heuristic fallback + cost model
   │  ├─ predictor.py               # Model loading + inference with fallback
   │  └─ model_registry.py          # Model persistence (joblib)
   ├─ training/
   │  ├─ generate_dataset.py        # Python executor → CSV dataset (features + actual cost)
   │  ├─ train.py                   # RandomForestRegressor training
   │  └─ evaluate.py                # MAE/RMSE/R²/MAPE vs heuristic baseline
   ├─ models/
   │  └─ model.pkl                  # Serialized model
   ├─ data/
   │  └─ requests.csv               # Training data
   ├─ requirements.txt
   └─ README.md
```

---

## Getting started

```bash
npm install            # installs Express only

npm run calibrate      # measure CPU throughput and sanity-check job costs
npm run demo           # baseline gateway vs a seeded workload (profile, duration, seed)
npm start              # backend HTTP API on http://localhost:3000
```

### Demo

```bash
node backend/scripts/demo.js normal 5 42      # profile durationSec seed
node backend/scripts/demo.js burst 5 42
node backend/scripts/demo.js heavy_tail 5 42
```

Profiles: `light`, `normal`, `burst`, `heavy_tail`, `mixed`, `stress`, `overload`, `demo`.

### Showcase (all four decisions)

```bash
node backend/scripts/showcase.js
```

Runs the demo profile with tightened limits (maxConcurrent=4, maxQueue=8, budget=$0.0008/10s) to demonstrate ALLOW, DELAY, DOWNGRADE, REJECT in a single run.

### HTTP endpoints (Backend - Express :3000)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | liveness + config |
| POST | `/api/execute` | run one request: `{ "type": "db_query" }` or `{ "request": {...} }` |
| GET  | `/api/metrics/live` | snapshots for every gateway |
| POST | `/api/metrics/reset` | zero counters |
| POST | `/api/compare/run` | run identical seeded workload through both gateways, return comparison |
| GET  | `/api/compare/stream/:profile/:seed` | inspect generated request stream |

### HTTP endpoints (ML Service - FastAPI :8000)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | liveness + model status |
| GET  | `/model/info` | current model metadata (version, type, metrics) |
| POST | `/predict` | predict cost for a request |
| POST | `/train` | retrain model from current dataset |

---

## Design decisions

### Request types & cost spread

| Type | ~CPU (avg payload) | I/O wait |
|------|--------------------|----------|
| `db_query` | ~4 ms | 30 ms |
| `image_resize` | ~22 ms | 8 ms |
| `hash_compute` | ~26 ms | 4 ms |
| `ml_inference` | ~21 ms | 12 ms |
| `report_generate` | ~48 ms | 20 ms |

`hashIterationsPerUnit` (config) converts abstract CPU units into SHA-256 rounds;
run `npm run calibrate` to retune on your machine.

### Cost model (shared for predicted & actual)

```
cost = compute + memory + invocation + egress
     = (ms/1000)·vcpu·pricePerVcpuSec
     + (ms/1000)·(memMB/1024)·pricePerGbSec
     + pricePerInvocation
     + (payloadBytes/1e9)·pricePerGbEgress
```

The **same formula** turns a *predicted* millisecond figure and an *actual*
millisecond figure into cost. So predicted-vs-actual divergence isolates the
predictor's error — perfect for the report's analysis.

### Outcome taxonomy (fair comparison)

Every request is classified identically for both gateways:
`incoming`, `processed` (2xx), `delayed`, `downgraded`, `rejected` (429/503),
`slaMet` (processed within `sla.targetLatencyMs`).

### Measurement note

Gateways record **service latency** (from admission to completion). The step-5
experiment runner will additionally record **client-observed latency** (scheduled
arrival → completion), which is where the baseline's queueing backpressure shows
up under saturation.

### ML roadmap

1. ✅ Heuristic predictor (per-type median) — keeps the gateway working with no model.
2. LinearRegression on engineered features — interpretable coefficients (optional).
3. ✅ `RandomForestRegressor` — nonlinearity + feature importances.

Served by the FastAPI service behind the same `mlClient` interface, so swapping
the predictor never touches gateway logic.

---

## Roadmap

- ✅ **Step 1** — Shared schemas, config, executor, seeded simulator, cost model, metrics, baseline gateway, HTTP API.
- ✅ **Step 2** — `predictiveGateway.js` + `decisionEngine.js`: predict cost (heuristic), compare against budget and utilization, then ALLOW/DELAY/DOWNGRADE/REJECT; bounded queue via `QueuedConcurrencyGuard`; LRU cache for DOWNGRADE path; comparison endpoint `/api/compare/run`.
- ✅ **Step 3** — `ml-service/`: dataset generator (Python executor), training (RandomForestRegressor), `/predict` with heuristic fallback; MAE 2.73ms vs heuristic 8.28ms (67% reduction), R² 0.926 vs 0.668.
- ✅ **Step 4** — React dashboard: live comparison cards, latency/throughput charts, predicted-vs-actual cost, decision breakdown, savings.
- ✅ **Step 5** — Experiment runner (`backend/scripts/experiment.js`): automated runs across 8 profiles, JSON + CSV export, 8 profiles tested.
- **Step 6** — AWS mapping (SAM): API Gateway → Lambda, DynamoDB, S3, CloudWatch, EventBridge; local stand-ins already mirror these.

---

## Experiment Results

Automated comparison across 8 workload profiles (seed=42):

| Profile | Requests | Baseline Cost | Predictive Cost | Savings | Baseline p95 | Pred p95 | SLA Baseline | SLA Pred |
|---------|----------|---------------|-----------------|---------|--------------|----------|--------------|----------|
| Light | 78 | $0.000143 | $0.000144 | -0.6% | 50ms | 50ms | 100% | 100% |
| Normal | 246 | $0.000458 | $0.000461 | -0.8% | 50ms | 75ms | 100% | 100% |
| Mixed | 417 | $0.000780 | $0.000779 | **+0.2%** | 75ms | 75ms | 100% | 100% |
| Burst | 417 | $0.000782 | $0.000801 | -2.5% | 75ms | 75ms | 100% | 100% |
| Heavy Tail | 449 | $0.000851 | $0.000918 | -7.8% | 75ms | 100ms | 100% | 100% |
| **Stress** | 588 | $0.001125 | $0.001002 | **+10.9%** | 75ms | 100ms | 100% | 100% |
| **Overload** | 988 | $0.002133 | $0.001711 | **+19.8%** | 100ms | 100ms | 100% | 100% |
| Demo (tuned) | 588 | $0.001106 | $0.001103 | **+0.3%** | 75ms | 75ms | 100% | 100% |

**Key findings:**
- At low load (Light, Normal): predictive gateway overhead slightly exceeds savings
- At high load (Stress, Overload): **10–20% cost savings** by rejecting expensive requests and downgrading
- Demo profile (tuned limits) shows all 4 decisions: ALLOW, DELAY, DOWNGRADE, REJECT
- ML prediction accuracy: MAE ~10ms, R² ~0.3–0.6 depending on load

Reports exported to `backend/experiments/` as timestamped JSON + CSV.
