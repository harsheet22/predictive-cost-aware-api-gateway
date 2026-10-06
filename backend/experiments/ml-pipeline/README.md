# ML prediction pipeline benchmark

All profile runs use the existing simulator/replay, seed 42, five seconds of configured arrivals, and a fresh gateway per profile. Demo uses its normal profile settings, without showcase overrides. Throughput uses the observed prediction interval including queue drain; low-load results are arrival-limited. Runs are sequential. Per-request console output is suppressed equally by the harness.

Before: original Node pipeline with four concurrent ML calls and saved RandomForest n_jobs=-1. Additive FastAPI timing headers were installed first to measure the real model-call duration. Independent detailed samples correct the original duplicate-count bug; the before table is not the halved dashboard average.

After: two bounded ML HTTP calls, four FastAPI thread-pool workers, and serving-only n_jobs=1. The saved model, architecture, features and dataset are unchanged.

## Before -> after

All latency values below are means in milliseconds. Each latency pair and throughput pair is before -> after.

| Profile | Requests | Prediction/s | Queue wait ms | RF inference ms | Total prediction ms | ML errors |
|---|---:|---:|---:|---:|---:|---:|
| normal | 116 | 19.584 -> 19.798 | 11.388 -> 0.474 | 98.354 -> 10.463 | 119.457 -> 15.284 | 0 -> 0 |
| demo | 588 | 26.072 -> 56.895 | 5772.643 -> 27.644 | 126.507 -> 13.110 | 5925.495 -> 58.573 | 0 -> 0 |
| stress | 988 | 25.553 -> 58.728 | 10948.308 -> 1023.006 | 127.077 -> 13.464 | 11104.561 -> 1056.915 | 0 -> 0 |
| burst | 417 | 24.123 -> 46.966 | 3714.631 -> 4.635 | 137.565 -> 12.112 | 3879.604 -> 27.198 | 0 -> 0 |
| heavy_tail | 214 | 24.471 -> 29.492 | 645.402 -> 0.833 | 127.837 -> 10.130 | 805.645 -> 16.272 | 0 -> 0 |

## After: complete timing breakdown

FastAPI time and RF time are nested inside HTTP elapsed time; do not add them to HTTP time. Total prediction latency includes Node queue wait plus the complete HTTP client operation and small gateway instrumentation overhead.

Network residual is max(0, HTTP elapsed - FastAPI processing); it includes transport, response parsing, and Node scheduling, not just wire latency. FastAPI processing starts at ASGI request entry and ends at response-header creation, including validation, executor wait, features, model prediction and response serialization.

| Profile | HTTP ms | Network residual ms | FastAPI ms | RF ms | Server worker queue ms | In flight at end |
|---|---:|---:|---:|---:|---:|---:|
| normal | 14.766 | 3.309 | 11.457 | 10.463 | 0.136 | 0 |
| demo | 30.926 | 16.592 | 14.335 | 13.110 | 0.213 | 0 |
| stress | 33.906 | 19.146 | 14.760 | 13.464 | 0.219 | 0 |
| burst | 22.560 | 9.351 | 13.209 | 12.112 | 0.156 | 0 |
| heavy_tail | 15.436 | 4.354 | 11.082 | 10.130 | 0.139 | 0 |

Every final profile completed without an unhandled gateway failure, an ML error, or a heuristic fallback. Predictions equal actual detailed metric samples and client attempts (warmup excluded); every request has a processed or rejected outcome.

## Configuration comparison

Direct saved-model calibration used 100 predictions per trial, three trials per setting, and bounded thread pools. Reported throughput is the median trial throughput. n_jobs changes apply only to the in-memory estimator; predictions were checked for equivalence.

| RF n_jobs | Workers | Prediction/s | Mean RF inference ms |
|---:|---:|---:|---:|
| -1 | 1 | 30.61 | 32.513 |
| -1 | 2 | 35.68 | 55.800 |
| -1 | 4 | 36.33 | 109.044 |
| -1 | 8 | 34.76 | 223.668 |
| 1 | 1 | 95.68 | 9.990 |
| 1 | 2 | 88.26 | 22.450 |
| 1 | 4 | 80.74 | 48.927 |
| 1 | 8 | 79.45 | 97.544 |

HTTP client concurrency was separately checked using actual stress replay, because the Node executor also blocks the event loop and changes effective HTTP capacity.

| Bounded client concurrency | First stress prediction/s | First mean queue wait ms | First total prediction ms |
|---:|---:|---:|---:|
| 1 | 42.335 | 4202.594 | 4226.181 |
| 2 | 68.346 | 682.958 | 712.111 |
| 4 | 63.995 | 95.185 | 141.542 |
| 8 | 56.660 | 80.021 | 164.949 |

Two and four slots were repeated for three independent stress replays each:

| Slots | Median prediction/s | Median mean queue wait ms | Median total prediction ms |
|---:|---:|---:|---:|
| 2 | 60.336 | 1097.988 | 1130.964 |
| 4 | 57.295 | 57.482 | 106.066 |

Two slots had the highest median prediction throughput and were selected for the requested throughput objective. Four slots had lower queue latency; ML_CONCURRENCY=4 remains an available override. This is a measured tradeoff, not a claim that two slots eliminate all queueing. Final stress mean queue wait remains about one second; sustained arrivals faster than service capacity can still backlog. No new waiting-queue rejection limit or arrival/replay change was introduced.

## Validation

- Jest: 27 tests passed in four suites (including the eight original tests).
- Python unittest: eight tests passed, including timing boundaries, bounded FastAPI workers, explicit heuristic fallback and saved-model prediction parity.
- Existing offline evaluation: MAE 0.806 ms, RMSE 1.164 ms, R2 0.9888, MAPE 3.63%, unchanged from the audit.
- Protected sources verified unchanged: training, dataset, model artifacts, feature extraction, admission engine/limiters, costs, replay, workload profiles, frontend, cache and budget behavior.

Reproduce with backend/scripts/benchmark-ml.js and ml-service/benchmarks/benchmark_inference.py; commands and timing definitions are documented in ml-service/README.md. Raw reports are stored beside this file.
