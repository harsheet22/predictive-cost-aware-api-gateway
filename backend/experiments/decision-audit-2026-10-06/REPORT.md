# Current pipeline decision diagnostic

Seed 42; five seconds of configured arrivals; nearest-rank percentiles; fresh gateways for each profile. The original simulator replay ran unchanged. Baseline ran first, followed by one excluded ML warmup and predictive replay of the identical requests. Measurements include draining all requests. Bounded ML HTTP concurrency remained 2. All protected source/model hashes matched before and after. Only diagnostic files were added.

Observation wrappers call original functions unchanged. Each request trace records predictions, exact remaining budget passed to the decision, priority, admission decision/reason and final outcome. Both the execution snapshot actually used by the engine and fresh execution state at decision time are recorded. No per-request logging or file writes occur during replay. Small observation overhead and different host conditions limit direct causal comparison with historical runs.

## Final decisions

| Profile | Requests | ALLOW | DOWNGRADE | DELAY | REJECT | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 116 | 116 | 0 | 0 | 0 | cheap_and_budget_ok |
| demo | 588 | 588 | 0 | 0 | 0 | cheap_and_budget_ok |
| stress | 988 | 988 | 0 | 0 | 0 | cheap_and_budget_ok |
| burst | 417 | 417 | 0 | 0 | 0 | cheap_and_budget_ok |
| heavy_tail | 214 | 214 | 0 | 0 | 0 | cheap_and_budget_ok |
| overload | 2424 | 2424 | 0 | 0 | 0 | cheap_and_budget_ok |

## Predicted request cost (micro-USD; divide by 1,000,000 for USD)

| Profile | min | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 0.631 | 1.503 | 2.246 | 2.434 | 2.512 | 2.537 |
| demo | 0.561 | 1.561 | 2.233 | 2.439 | 2.719 | 2.800 |
| stress | 0.558 | 1.565 | 2.198 | 2.433 | 2.716 | 2.800 |
| burst | 0.561 | 1.561 | 2.228 | 2.439 | 2.716 | 2.797 |
| heavy_tail | 0.573 | 1.593 | 2.305 | 2.478 | 2.664 | 2.716 |
| overload | 0.554 | 1.560 | 2.230 | 2.471 | 2.685 | 2.802 |

## Predicted execution time (ms)

| Profile | min | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 13.100 | 19.000 | 33.860 | 38.480 | 40.680 | 41.470 |
| demo | 12.770 | 20.470 | 39.630 | 40.250 | 42.820 | 46.220 |
| stress | 12.770 | 18.920 | 39.860 | 40.580 | 41.940 | 46.220 |
| burst | 13.040 | 19.830 | 38.490 | 39.920 | 41.870 | 46.220 |
| heavy_tail | 13.040 | 32.290 | 39.920 | 40.680 | 41.480 | 42.000 |
| overload | 12.630 | 18.730 | 39.920 | 40.980 | 41.950 | 46.230 |

## Remaining budget at decision (USD)

| Profile | min | p50 | p90 | p95 |
| --- | --- | --- | --- | --- |
| normal | 0.000758771 | 0.000869411 | 0.000977876 | 0.000990959 |
| demo | 0.000330345 | 0.000345377 | 0.000860229 | 0.000934342 |
| stress | 0.000311917 | 0.000327505 | 0.000761019 | 0.000874505 |
| burst | 0.000331091 | 0.000541858 | 0.000903014 | 0.000951948 |
| heavy_tail | 0.000488984 | 0.000739935 | 0.000949861 | 0.000972565 |
| overload | 0.000278563 | 0.000309586 | 0.000414358 | 0.000701444 |

## Execution pressure actually used by policy (%)

| Profile | min | p50 | p90 | p95 | max | Max active | Max execution queue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 0.0 | 12.5 | 12.5 | 25.0 | 25.0 | 2 | 0 |
| demo | 0.0 | 12.5 | 25.0 | 25.0 | 37.5 | 3 | 0 |
| stress | 0.0 | 12.5 | 25.0 | 25.0 | 37.5 | 3 | 0 |
| burst | 0.0 | 12.5 | 25.0 | 25.0 | 37.5 | 3 | 0 |
| heavy_tail | 0.0 | 12.5 | 25.0 | 25.0 | 25.0 | 2 | 0 |
| overload | 0.0 | 25.0 | 25.0 | 25.0 | 37.5 | 3 | 0 |

## Fresh execution state observed at decision time

| Profile | Pressure min | p50 | p90 | p95 | max | Max active | Max queue | Stale snapshots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 0.0 | 12.5 | 12.5 | 12.5 | 12.5 | 1 | 0 | 51 |
| demo | 0.0 | 12.5 | 12.5 | 12.5 | 25.0 | 2 | 0 | 332 |
| stress | 0.0 | 12.5 | 12.5 | 12.5 | 25.0 | 2 | 0 | 585 |
| burst | 0.0 | 12.5 | 12.5 | 12.5 | 25.0 | 2 | 0 | 232 |
| heavy_tail | 0.0 | 12.5 | 12.5 | 12.5 | 25.0 | 2 | 0 | 129 |
| overload | 0.0 | 12.5 | 12.5 | 12.5 | 25.0 | 2 | 0 | 1621 |

## Costs and gateway latency

| Profile | Baseline cost USD | Predictive cost USD | Baseline mean gateway ms | Predictive mean gateway ms | Mean actual execution ms | Predictive elapsed s |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 0.000245159 | 0.000243629 | 46.73 | 90.36 | 46.128 | 6.325 |
| demo | 0.001433560 | 0.001323174 | 59.53 | 3263.12 | 51.969 | 20.109 |
| stress | 0.002582311 | 0.002319641 | 66.03 | 5886.87 | 55.361 | 34.872 |
| burst | 0.000981079 | 0.000931865 | 55.60 | 1546.81 | 50.844 | 14.260 |
| heavy_tail | 0.000533034 | 0.000515214 | 61.67 | 226.25 | 58.300 | 9.363 |
| overload | 0.007462264 | 0.005827218 | 84.45 | 19314.92 | 57.441 | 85.072 |

Costs are estimates from the existing execution cost formula, not AWS bills. All current requests execute at full precision; differences between baseline and predictive costs reflect measured execution timing, not admission savings. Gateway latency is measured inside handle(), including prediction wait, HTTP prediction, execution waiting and execution. It excludes simulator waiting before handle(). Configured duration is not elapsed wall time: overload baseline took 92.349 seconds and predictive took 85.072 seconds with unchanged replay.

## Prediction timing (mean ms unless indicated)

| Profile | Queue peak | Queue wait | HTTP | FastAPI | RF inference | HTTP minus FastAPI | Server worker wait | Total prediction | Predictions/s | ML errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 2 | 3.925 | 39.949 | 26.274 | 23.972 | 13.675 | 0.503 | 43.899 | 18.654 | 0 |
| demo | 182 | 3142.524 | 67.994 | 29.348 | 26.697 | 38.646 | 0.646 | 3210.531 | 29.356 | 0 |
| stress | 331 | 5760.581 | 70.416 | 27.574 | 25.146 | 42.842 | 0.498 | 5831.007 | 28.376 | 0 |
| burst | 92 | 1427.96 | 67.502 | 31.003 | 28.045 | 36.499 | 0.733 | 1495.472 | 29.407 | 0 |
| heavy_tail | 15 | 98.471 | 69.106 | 32.153 | 29.649 | 36.953 | 0.541 | 167.586 | 23.076 | 0 |
| overload | 1076 | 19186.769 | 70.081 | 25.047 | 22.941 | 45.034 | 0.356 | 19256.86 | 28.52 | 0 |

FastAPI and RF timing are nested inside HTTP timing; do not sum them. HTTP minus FastAPI includes transport, response parsing and Node scheduling, so it is not a pure network measurement. Prediction throughput uses the observed prediction interval including queue drain, not requests divided by the configured five seconds.

## Archived optimized benchmark versus current

| Profile | Archived A/D/L/R | Current A/D/L/R | Archived prediction/s | Current prediction/s | Archived queue peak | Current queue peak | Archived wait ms | Current wait ms | Archived RF ms | Current RF ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 116/0/0/0 | 116/0/0/0 | 19.798 | 18.654 | 2 | 2 | 0.474 | 3.925 | 10.463 | 23.972 |
| demo | 554/12/0/22 | 588/0/0/0 | 56.895 | 29.356 | 7 | 182 | 27.644 | 3142.524 | 13.11 | 26.697 |
| stress | 796/153/0/39 | 988/0/0/0 | 58.728 | 28.376 | 133 | 331 | 1023.006 | 5760.581 | 13.464 | 25.146 |
| burst | 417/0/0/0 | 417/0/0/0 | 46.966 | 29.407 | 4 | 92 | 4.635 | 1427.96 | 12.112 | 28.045 |
| heavy_tail | 214/0/0/0 | 214/0/0/0 | 29.492 | 23.076 | 3 | 15 | 0.833 | 98.471 | 10.13 | 29.649 |
| overload | No archive | 2424/0/0/0 | — | 28.52 | — | 1076 | — | 19186.769 | — | 22.941 |

All five comparable profiles have identical generated request counts and identical summed predicted USD costs to the archived benchmark. This strongly supports unchanged workload/predictions, but equal sums alone do not prove per-request equality because the archive did not retain individual predictions. The archive contains aggregate outcomes, not per-decision budget or execution-pressure traces. It cannot provide an exact historical threshold-crossing audit. Its rateLimited counter counts every HTTP 429, including budget rejections; it does not establish token-bucket rejection. Every archived request had an ML prediction.

## Diagnosis

- The cheap threshold is dynamic: predicted USD <= 0.3 * remaining budget. $0.000300 is its initial value, not a fixed threshold throughout a run. All current requests satisfy this test, remaining budget > predicted cost, and active execution < 8. There are zero expensive requests, insufficient-budget decisions, soft-pressure crossings or full-concurrency crossings in every profile.
- Execution pressure = max(active/8, execution queue/32)*100. Used pressure peaks at 37.5%; fresh pressure at decision time peaks at 25%; soft/hard values are 65%/90%. Prediction-queue depth/wait is not an admission input.
- Slower observed prediction delivery is the leading explanation. Demo throughput fell from 56.895 to 29.356 predictions/s; stress from 58.728 to 28.376. RF and HTTP timings both increased. This meters execution, prevents execution pressure, and spreads completion charges over multiple 10-second rolling budget windows. Remaining budget never approaches the per-request cheap boundary. The smallest observed remaining budget is $0.000278563, making even its 30% allowance $0.000083569, far above the largest request prediction of $0.000002802.
- Execution timing also changed: the synchronous Node workload affects replay and HTTP response scheduling. Overload is configured for approximately 500 arrivals/s, but unchanged replay does not complete those arrivals in five wall-clock seconds on this host. Therefore configured throughput cannot be used as actual achieved arrival rate. No arrival timestamps or replay semantics were modified.
- Used execution snapshots are captured before prediction and can be stale after multi-second waits. Fresh state was also measured; both remain below policy thresholds here. This implementation detail is real but does not explain absent non-ALLOW outcomes in these current runs.
- Archived DOWNGRADE implies the expensive branch was reached, consistent with smaller remaining budget. Historical REJECT causes and pressure margins are not fully recoverable without archived request traces. Current measurements show the timing-to-budget mechanism directly; they do not identify which host/runtime factor made serving slower than the historical benchmark.

Recommendation: C if admission is meant to protect gateway latency under overload: consider prediction-queue pressure as an input, since this is where overload accumulates while existing execution/cost inputs remain healthy. Preserve the cost policy until intended capacity/SLA is specified. Separate legitimate cost-pressure scenarios (A) remain useful for testing that policy; lowering cost thresholds (B) just to reproduce historical decision counts is not justified. No recommendation was implemented.

## Request priorities

| Profile | low | normal | high |
| --- | --- | --- | --- |
| normal | 22 | 72 | 22 |
| demo | 110 | 361 | 117 |
| stress | 210 | 581 | 197 |
| burst | 82 | 253 | 82 |
| heavy_tail | 46 | 128 | 40 |
| overload | 489 | 1444 | 491 |

Validation: all 4,747 requests have one recorded admission attempt, one final outcome and one ML timing sample; no ML errors, fallbacks, unhandled failures or remaining in-flight requests. Protected source/model hashes match. Full raw data: report.json and one PROFILE-requests.json per profile in this directory. Reproduce: node backend/experiments/decision-audit-2026-10-06/harness.cjs with the existing ML service running.
