# External load demonstration

Run this client on your laptop, not on the EC2 gateway. It sends supported synthetic request types over HTTP to AWS, using the existing seeded workload generator. No package or Autocannon installation is required.

```powershell
node backend/benchmarks/external/run.cjs --url http://YOUR_EC2_PUBLIC_IP --profile mixed --rates 10,25,50 --duration 5 --seed 42 --drain 300
```

Use the dashboard's **External load** tab. It shows the command, current phase, request progress, the latest completed comparison, recent results, and downloadable JSON evidence. This command runs up to three prespecified load levels once; it stops at the first invalid arm. For an initial smoke test use `--rates 10`.

## What is compared

For each load level the client saves one trace and uploads it once. The server validates its hash, request IDs, features, arrival order and bounds. Baseline and predictive receive the exact same requests in separate fresh Node workers. Existing cost, policy, queue, execution, cache and quality settings are not overridden. Baseline runs first, followed by predictive only if the baseline validity checks pass.

The existing ML service remains running; it is shared and not cold-started for each arm. This is **Experiment A style current-system evidence**, not a controlled equal-quality policy experiment. Predictive may use reduced quality and exact CPU reuse, while baseline does not. Neither the external proxy nor worker observation code changes DecisionEngine decisions. The parent process does add a measured HTTP forwarding hop.

Arrival deadlines are absolute and open-loop on the laptop. A bounded client capacity of 128 outstanding requests is the default. Offers exceeding client capacity are recorded, not delayed or dropped silently. There are no request retries, duplicate IDs are refused, and an embedded gateway rejection is counted even when its outer HTTP status is 200.

## Validity and timing

The existing controlled benchmark summary checks are reused, including p99 dispatch lateness <=20 ms, at least 99% dispatched by the configured horizon +20 ms, matching trace hashes, unique request IDs, reconciliation and no retries. Explicit transport-error, unresolved-cutoff, model-loaded, source-integrity and no-fallback checks are also recorded. No failing samples are removed. The runner stops rather than rerunning to obtain a passing result.

Client latency is dispatch through complete HTTP response, including laptop-to-AWS transport, Nginx, the proxy and gateway work. Scheduled latency additionally includes client scheduling lateness. Gateway latency starts in the isolated worker and excludes the external network and parent proxy. Client completion throughput includes the offered horizon and drain. The existing dashboard phase denominator also includes the control/arming interval from worker begin to its final snapshot; these boundaries are shown separately.

After the client drain cutoff, accepted server work is observed for up to the configured server drain. Pending and unresolved requests invalidate the arm before its owned worker is stopped. Interrupted clients have a finite server lease; a 60-second idle lease applies between arms and startup. Active observation has a horizon + drain +45-second lease. No lease provides guaranteed crash-proof evidence; a parent crash can make server observations incomplete. Client raw records remain essential.

Gateway child-process CPU time and sampled RSS are saved. **They exclude the main proxy and Python ML service.** Basic CloudWatch metrics can provide whole-instance context; a 5-second run is too short for a reliable 5-minute CloudWatch CPU attribution. No actual AWS billing savings are claimed.

## Evidence

Laptop: `backend/experiments/external-client-<timestamp>-<id>/` contains configuration, traces, client rows, phase responses, downloaded server reports and validity outcomes. EC2: `backend/experiments/external-demo-<timestamp>-<id>/` contains source/model hashes, resolved configurations and worker PIDs, server observations, client submissions, summaries, logs and comparison JSON. New files use exclusive creation; older runs are not overwritten. Failed and partial runs are retained. The dashboard shows the ten most recent runs in the current backend process; files survive restart, but this in-memory history does not automatically reload.

## Bounds and operation

Initial demo limits: 100 offered requests/s, 30-second horizon, 5,000 trace requests, 512 maximum client outstanding requests and 300-second drain. These are limits of this new demonstration interface, not production policy changes or altered existing workload profiles. The original controlled runner is unchanged.

Trace uploads are bounded to 2 MiB and observation JSON to 16 MiB. If using long traces, Nginx's default 1 MiB request-body limit may reject an evidence upload; use `client_max_body_size 16m;` only inside the existing `/api/` location before testing those larger runs. The default five-second, 10/25/50 req/s demonstration is well below that size.

Worker stop verifies the owned child has exited. If cleanup fails, further comparisons are blocked rather than running alongside an unverified worker. Resolve the reported owned PID before restarting the backend. The external worker also exits if its parent IPC connection disappears; this is failure cleanup, not a request retry.

Keep HTTP and SSH restricted to your IP. This demo API has no user authentication and must not be exposed broadly. API endpoints are under `/api/external/runs`; the existing Nginx `/api/` proxy already covers them. Keep ports 3000 and 8000 closed to the internet. Do not run an internal comparison or other external client at the same time; other instance traffic still affects resources.

To update EC2 after committing and pushing these files:

```bash
cd ~/predictive-cost-aware-api-gateway
git pull --ff-only origin main
npm --prefix frontend run build
sudo cp -r frontend/dist/. /var/www/gateway/
sudo systemctl restart gateway-backend
```

The model, ML service, Nginx routing and security group need no changes for this update. No deployment or AWS load run is performed merely by building the frontend.

## Tests

```powershell
node --test backend/benchmarks/external/external.test.cjs
node --test backend/benchmarks/controlled/infrastructure.test.cjs backend/benchmarks/controlled/diagnostic.test.cjs backend/benchmarks/controlled/tracing-controller.test.cjs
npm test -- --runInBand
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```
