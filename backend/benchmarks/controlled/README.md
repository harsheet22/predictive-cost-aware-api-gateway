# Controlled benchmark harness

Benchmark-only infrastructure. Production defaults and frontend are not edited.

Run from the repository root:

```powershell
node --test backend/benchmarks/controlled/infrastructure.test.cjs
node backend/benchmarks/controlled/run.cjs --mode screen --experiment both --profiles light,stress --duration 1 --seeds 42 --drain 300
```

The runner creates a new timestamped `backend/experiments/controlled-benchmark-*` directory with immutable traces, per-run raw client/server observations, resolved configuration, Node/Python versions, hardware, process logs, protected file hashes, integrated resources, checks, results, and REPORT.md. It refuses to overwrite files. Each arm has a fresh owned gateway process and, when needed, a fresh owned ML process on temporary ports. Existing backend/ML/frontend instances are not used or stopped. Windows subprocesses use hidden windows. `BENCH_PYTHON` may select an existing compatible interpreter; default is the ML service's virtual environment.

**A:** baseline/current predictive. Preserve and disclose real differences: token limiting, no baseline waiting room, predictive prediction/execution/budget queues, RF overhead, CPU reuse and eligible reduced quality.

**B:** FIFO/shadow/policy. Execution slots and waiting capacity come from the same resolved predictive configuration. All use full quality, no response caching or CPU reuse and no front token limiter. Shadow records a real RF prediction through the existing gate, then acts like FIFO; policy uses the existing DecisionEngine and budget waiting. No optional heuristic arm. Overrides are in-memory inside disposable child processes; no environment/config/source files are rewritten. FIFO does not enforce the rolling budget; shadow/policy have the same prediction buffering, but only policy has budget waiting. These are explicit treatment differences, not an isolated proof of forest superiority.

Recorded input precision is full. Reuse the existing generator with a fixed epoch so the entire trace, not just arrival offsets, is reproducible. A separate client schedules absolute monotonic deadlines and never waits for responses before scheduling the next arrival. It has a finite 16,384 outstanding request cap; missed offers are recorded and invalidate the run, rather than becoming hidden backpressure. No retries. Actual dispatch is the call to HTTP request submission; socket-assignment/connect times are also recorded. Kernel transmission time is not measured.

The scheduler refreshes time after every submission so requests becoming due during HTTP setup are caught up in the same batch, without another timer sleep. Wire payloads are pre-encoded inside the existing 100 ms arming interval; the start clock is never reset to hide slow preparation. Absolute deadlines, order, and contents are unchanged. Client observations retain timer wakeups, synchronous submission durations, event-loop delay and GC events. These can locate new stalls but cannot retrospectively identify the CPU/GC/OS cause of a historical stall. An externally delayed wakeup still fails the original 20 ms p99 criterion.

The isolated HTTP server records accept, gateway entry and gateway terminal times. It returns existing embedded result status: HTTP 200 alone is not a successful execution. Client latency is actual dispatch through complete response, scheduled latency includes client lateness, and gateway latency surrounds handle. Server/client clocks are not subtracted. No production API needs modification; the temporary `/execute` endpoint is a benchmark adapter around the existing handle method.

HTTP transport keeps the existing bounded LIFO connection pool and no-retry rule. Free sockets retire after at most 4 seconds, or 1 second before a shorter advertised peer keep-alive timeout. This deadline is cleared on reuse and does not constrain active responses; existing client request/drain deadlines remain in force. Server HTTP timeouts are unchanged. Saved client/server `transport` observations include socket IDs, endpoint ports, assignments/request IDs, connect/end/timeout/error/close events and resolved HTTP timeout settings. Client rows record `reusedSocket`, response keep-alive hints and transport error codes. Server parser errors are observed without installing a `clientError` handler that would replace Node's default closure behavior. Clock origins are separate; correlate endpoints/request IDs and epoch timestamps, rather than subtracting process clocks. Idle retirement reduces a demonstrated stale-pool risk but cannot prevent every peer/network reset or prove the cause of earlier failures whose socket events were not recorded. Any transport error still fails the existing complete-observation gate; no missing outcomes are replaced.

Validation: trace hashes, unique IDs, offers accounted for, server counts/counters balanced, no retries, correlated outcomes, no missing/censored requests, no capacity losses, p99 dispatch lateness ≤20 ms and ≥99% dispatched by horizon+20 ms. Controlled full quality/no cache/reuse is checked. Fallbacks remain explicit; a fallback must not be presented as successful RF evidence. Node/Python RSS and CPU observation intervals are recorded, including small client-launch/arming gaps. Do not sum executor per-request cpuMs: its process CPU measurements overlap under concurrency.

Warmup is deliberately simple: three excluded direct ML HTTP calls followed by construction of the measured gateway. Node execution is cold in each fresh process; gateway cache/budget/tokens and prediction estimator history start fresh. This replaces the plan's more elaborate ten-second warmup protocol and is recorded in the manifest. Node and Python share the same host; slot counts are async limits, not CPU cores. Python sampling is dependency-free on Windows/Linux and covers the single uvicorn process and its worker threads. ML startup/idle infrastructure is not included in synthetic execution cost.

Screening is capped at 5 seconds, three profiles and one seed. The default is screening, never the full matrix. Unresolved observations are saved after the configured drain; a client timeout does not imply a server rejection. Generator timing failure exits with code 2 and is reported as invalid. Screening supports infrastructure validation, not performance conclusions or repeatability. On Windows, the ML interpreter explicitly reports its PID so resources include the real serving process as well as any distinct virtual-environment launcher. Cleanup stops only the process trees this runner owns.

After approval, full commands (not run automatically):

```powershell
node backend/benchmarks/controlled/run.cjs --mode full --experiment A --profiles light,normal,mixed,burst,heavy_tail,stress,overload,demo --duration 60 --seeds 42,43,44 --drain 300
node backend/benchmarks/controlled/run.cjs --mode full --experiment B --profiles light,normal,mixed,burst,heavy_tail,stress,overload,demo --duration 60 --seeds 42,43,44 --drain 300
```

Three paired seeds, balanced arm rotations and fresh processes make variability visible, but do not establish universal statistical significance. Reports retain every run and mark invalid ones. Cost remains the existing **synthetic execution estimate**, excluding ML/waiting/idle resources and actual AWS bills. No EC2 deployment or AWS savings claim.
