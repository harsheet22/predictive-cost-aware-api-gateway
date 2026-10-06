# Bounded prediction admission: before versus after

Before: decision-audit-2026-10-06. After: this directory. Both use seed 42, five seconds of configured arrivals, unchanged simulator replay, fresh gateways, sequential baseline then predictive, and one excluded direct ML warmup. After uses the approved defaults: two active ML calls, four waiting entries, 50 ms normal/low and 100 ms high wait limits. No threshold tuning. These are single paired runs at different times, not controlled host-performance trials.

## Admission and outcomes

| Profile | Requests before/after | Gate rejections before → after | After rejection reasons | Final A/D/L/R before → after | ML errors before → after |
| --- | --- | --- | --- | --- | --- |
| normal | 116/116 | 0 → 25 | {"prediction_wait_limit":25} | 116/0/0/0 → 91/0/0/25 | 0 → 0 |
| demo | 588/588 | 0 → 232 | {"prediction_wait_limit":232} | 588/0/0/0 → 356/0/0/232 | 0 → 0 |
| stress | 988/988 | 0 → 417 | {"prediction_wait_limit":416,"prediction_queue_expired":1} | 988/0/0/0 → 571/0/0/417 | 0 → 0 |
| burst | 417/417 | 0 → 155 | {"prediction_wait_limit":153,"prediction_queue_expired":2} | 417/0/0/0 → 262/0/0/155 | 0 → 0 |
| heavy_tail | 214/214 | 0 → 74 | {"prediction_wait_limit":74} | 214/0/0/0 → 140/0/0/74 | 0 → 0 |
| overload | 2424/2424 | 0 → 1950 | {"prediction_wait_limit":1945,"prediction_queue_expired":5} | 2424/0/0/0 → 474/0/0/1950 | 0 → 0 |

## Prediction queue and throughput

| Profile | Queue peak before → after | Mean wait ms before → after | p95 wait ms before → after | Predictions/s before → after | ML attempts before → after |
| --- | --- | --- | --- | --- | --- |
| normal | 2 → 1 | 3.925 → 0.193 | 31.924 → 0.586 | 18.654 → 15.059 | 116 → 91 |
| demo | 182 → 2 | 3142.524 → 3.756 | 5599.291 → 30.085 | 29.356 → 26.349 | 588 → 356 |
| stress | 331 → 2 | 5760.581 → 2.92 | 11321.181 → 24.396 | 28.376 → 26.013 | 988 → 571 |
| burst | 92 → 2 | 1427.96 → 2.865 | 2845.218 → 25.953 | 29.407 → 24.825 | 417 → 262 |
| heavy_tail | 15 → 1 | 98.471 → 0.272 | 455.44 → 0.196 | 23.076 → 17.483 | 214 → 140 |
| overload | 1076 → 2 | 19186.769 → 1.723 | 35516.124 → 11.789 | 28.52 → 11.726 | 2424 → 474 |

## Gateway latency and SLA

| Profile | All-response mean ms before → after | All-response p95 ms before → after | Success mean ms before → after | Success p95 ms before → after | SLA-compliant before → after | Successful before → after |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 90.36 → 73.72 | 146.323 → 159 | 90.359 → 93.892 | 146.323 → 159.522 | 116/116 → 88/116 | 116 → 91 |
| demo | 3263.12 → 65.18 | 5707.991 → 165.141 | 3263.12 → 107.438 | 5707.991 → 178.444 | 9/588 → 354/588 | 588 → 356 |
| stress | 5886.87 → 65.7 | 11442.537 → 165.757 | 5886.87 → 113.213 | 11442.537 → 178.526 | 7/988 → 569/988 | 988 → 571 |
| burst | 1546.81 → 67.46 | 2963.577 → 166.354 | 1546.814 → 106.314 | 2963.577 → 192.156 | 11/417 → 259/417 | 417 → 262 |
| heavy_tail | 226.25 → 78.46 | 625.683 → 203.227 | 226.252 → 119.762 | 625.683 → 237.454 | 165/214 → 134/214 | 214 → 140 |
| overload | 19314.92 → 42.15 | 35644.122 → 144.002 | 19314.917 → 211.27 | 35644.122 → 247.472 | 7/2424 → 452/2424 | 2424 → 474 |

## Existing execution cost estimates (USD)

| Profile | Baseline before | Predictive before | Baseline after | Predictive after |
| --- | --- | --- | --- | --- |
| normal | 0.000245159 | 0.000243629 | 0.000239334 | 0.000182816 |
| demo | 0.001433560 | 0.001323174 | 0.001409657 | 0.000799915 |
| stress | 0.002582311 | 0.002319641 | 0.002462122 | 0.001374235 |
| burst | 0.000981079 | 0.000931865 | 0.000955792 | 0.000586518 |
| heavy_tail | 0.000533034 | 0.000515214 | 0.000509229 | 0.000338946 |
| overload | 0.007462264 | 0.005827218 | 0.007187301 | 0.001272139 |

Queue-wait statistics above cover predictions that actually started HTTP; gate expiry waits are recorded separately in gateEvents/gateWaitMs. p95 values use exact raw observations with nearest-rank percentiles, rather than the dashboard latency histogram. Prediction throughput covers the observed prediction interval, including drain; it is not requests divided by configured duration. All-response latency includes fast rejections, so successful-response latency is also reported. SLA counts require successful completion within the unchanged 250 ms threshold; rejections are not SLA-compliant.

Lower execution cost following rejection means less completed work, not cost-aware optimization savings. Admitted requests still use the original DecisionEngine, full-precision executor, existing cache and rolling budget. No rejection distribution was targeted. Normal-profile rejection is an observed availability tradeoff of these initial conservative limits and must remain visible.

Implementation: backend/src/config.js, backend/src/ml/predictionQueue.js, backend/src/gateways/predictiveGateway.js, backend/src/metrics/metricsStore.js. Tests: backend/test/predictionQueue.test.js and backend/test/predictionAdmission.test.js. Gate metrics are additive API fields; no dashboard changes. Configuration: PREDICTION_MAX_WAITING=4, PREDICTION_NORMAL_WAIT_MS=50, PREDICTION_HIGH_WAIT_MS=100. ML_CONCURRENCY retains its previous value.

Validation: 47 backend tests and 8 Python tests passed. All six experiments have complete request outcomes, zero final inFlight, zero ML errors/fallbacks, and reconciled submission/admission/start/expiry counters. Source hashes remained unchanged during experiments. Protected DecisionEngine, cost formulas, workload/replay, frontend, Python sources, model and training hashes match the pre-change audit.
