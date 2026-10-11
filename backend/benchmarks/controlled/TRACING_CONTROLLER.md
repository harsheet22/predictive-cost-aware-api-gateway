# Bounded Windows controller — review before execution

Live execution is currently blocked in code, with no CLI bypass. Netsh/logman
reconciliation, live WPR logger mapping and safe ownership protection have not
been established by an approved request-free capture.

No live capture or replay has validated this controller yet. Tests mock all stop
commands and never invoke the Windows runtime adapter. There is no auto-elevation.

## Proposed launch (NOT EXECUTED)

Future command shape only: the current controller rejects it before starting
any native helper, recording or benchmark. Explicit approval and a separate
request-free validation plan are required before removing the code blockers:

```powershell
node backend/benchmarks/controlled/tracing-controller.cjs --execute
```

An optional `--output-parent <directory>` must resolve outside the repository.
The default is `~/Downloads/gateway-tcp-diagnostics`. A timestamp/UUID subdirectory
is created without overwriting old evidence. Output must be outside the source
tree because the benchmark hashes existing experiment files for integrity.

The controller invokes exactly:

```powershell
node backend/benchmarks/controlled/run.cjs --mode diagnostic --experiment A --arm baseline --trace "backend/experiments/controlled-benchmark-2026-10-11T05-42-31-156Z-19826f7e/traces/overload-42.json" --drain 300 --expected-trace-sha256 0b5fd16adda0997854d8d1063272b59ccee50399503a428e202847116f1eb1ff
```

The original file SHA-256, request hash, profile, seed, 60-second horizon and 29,938
requests are checked before capture and again before replay. The child runner
also verifies the pinned source SHA-256 on the single byte buffer it parses and
executes, before integrity scanning, output creation or service startup. No request generation,
prediction arm, matrix, retry or changed validity gate is available in this CLI.

## Capture and ownership

A detached Node watchdog starts before the runner. Its persistent, read-only
PowerShell helper enumerates ETW sessions through `QueryAllTracesW` and reads free
space. It does not start or stop any recording. Incomplete queries fail closed.

Preflight records native sessions, netsh/WPR status, both provider descriptions,
local event schemas, CPU.light profile details and free space. Potentially
conflicting recordings, unrecognized status text, missing manifests or unverified
CSwitch/ReadyThread coverage prevent replay. Existing recordings are never stopped.

Network start uses a UUID session name, TCPIP and Winsock-AFD providers at level 5
with all keyword bits, capture=no, report=no, persistent=no, overwrite=no,
maxsize=512 and filemode=single. This requests coverage; it does not guarantee any
particular accept/rejection field is emitted. Local schemas are retained in the
command journal. No packet payload capture, registry change or software install.

WPR starts CPU.light in file mode with a private temporary directory and UUID
instance name. A fresh launch acknowledgment is required in addition to readiness. Cancellation,
stopping, lost IPC or watchdog failure revoke launch permission. Ready is sent
only after matching the created native sessions to
their names and output paths, and with at least 60 seconds left in the capture
window. The baseline listener cannot exist before readiness and launch acknowledgment.
These checks do not atomically couple ETW lifetime to process creation; live
execution remains blocked rather than claiming that residual race is eliminated. The 60-second remaining-window check is made
before launch, not a guarantee of coverage for the complete offered horizon;
runner integrity scans/startup consume part of that window.

Native session names, handles, GUIDs, paths and loss counters are recorded. Cleanup
requeries and checks these identities. The original preflight snapshot is retained in the disk and IPC ownership ledger.
All changed/new sessions are classified; unmatched sessions require manual review
and are never adopted or stopped. Disk/logging failures cannot prevent an
otherwise verified cleanup attempt. Native cleanup currently fails closed because
the Windows adapter reports cleanupVerified=false. The candidate network cleanup
uses `logman stop <unique
session name> -ets`: never the global `netsh trace stop`. CPU cleanup uses WPR
`-stop <cpu.etl> -instancename <unique instance>`, never cancel or default-instance
stop. Replaced, extra or partially missing instance sessions block cleanup and
require manual review. No ETL/temp files are deleted.
Observed lost-event/buffer counters or unexpected session disappearance produce a
controller failure independently of the benchmark's unchanged validity results.

## Watchdog bounds

- Time stop trigger: 90 seconds from the first network-start attempt, including
  startup. Separate from the runner's arrival clock and 300-second drain.
- Poll period: 500 ms. Aggregate capture-directory stop threshold: 2 GiB.
- Network-file stop trigger: 480 MiB, before its configured 512 MiB limit.
- Initial free space: at least 5 GiB. Stop if free space falls below 3 GiB:
  1 GiB minimum plus 2 GiB finalization headroom.
- Also stop on runner finish, controller IPC disconnect, controller signal or
  failed watchdog observation. Startup failures launch no replay.

These are **stop triggers, not strict time/byte quotas**. OS scheduling, polling,
command startup and finalization can exceed them; headroom is not a reservation
against other processes. WPR file mode itself is unbounded. Candidate stop commands are
issued concurrently only with a verified test adapter; normal command deadlines are 15 seconds and WPR finalization
is allowed 120 seconds. A command timeout is retained as a failure, never retried.
Incomplete cleanup is reported; no global stop is attempted to recover it.
Native command outcomes distinguish numeric exit status, signal, timeout trigger,
spawn error and other error codes. A timeout can terminate the owned native
command process, never the benchmark. Partial output is retained.

Observation continues during finalization where possible and records measured
time/storage overshoot, peak capture-directory size, sample gaps and incomplete
measurements. External WPR managed-symbol-cache growth is not included. Neither
headroom nor deadlines are hard quotas; a hung helper, scheduling delay or host
failure can exceed them.

The parent monitors watchdog exit/error/unexpected IPC loss immediately. It retains
the latest ownership ledger in memory and attempts only verified cleanup with a
fresh session query. With the native adapter still unverified, it reports manual
review instead of issuing potentially unsafe stops. The runner is a separate
detached process. Capture termination never kills it,
signals it or changes observation/accounting. Its nonzero exit/invalidity remains
nonzero in controller results. Every transport error remains an end-to-end error.

## Evidence and remaining Windows uncertainties

`controller.json`, `controller-events.jsonl`, `sessions.json`,
`watchdog-events.jsonl`, process logs, `benchmark-exit.json`, `watchdog-exit.json`,
byte-identical `source-trace.json`, ETLs and all WPR temporary files are retained.
The diagnostic runner stores its own report/raw data in its new experiment directory;
the exact report path is preserved in `benchmark-process.log`.

Before a live attempt, review these unverified constraints:

1. QueryAllTraces marshaling and native-session visibility on this Windows build.
2. English netsh/WPR status messages; another locale fails closed.
3. Provider manifests and CPU.light profile details must contain expected coverage
   text. If they do not, inspect captured preflight output rather than weakening it.
4. WPR native logger names must contain the instance UUID and all output paths must
   be under `-recordtempto`. If not, ownership cannot be established: no replay;
   potentially started recordings require manual review.
5. Netsh/WPR coexistence and provider events/losses require a live capture. A
   netsh-started session stopped directly through logman is only a proposed cleanup
   mapping. Netsh bookkeeping/finalization and raw-ETL flush behavior are not
   validated; preserve raw ETL and review
   status manually before another attempt. Never issue a global cleanup command.
6. Identity checks plus random names protect normal concurrent use, but cannot
   atomically lock out another administrator replacing a recording between query
   and named stop. Operators must not manipulate these UUID sessions concurrently.
7. Forced termination, OS crash, exhausted disk or revoked permissions can defeat
   the watchdog. It cannot promise a hard recording bound in those circumstances.
8. Native CPU/accept interpretation and observer overhead remain unmeasured. A
   failure to reproduce is not a correction of the original failed arm.

Do not rerun automatically. Preserve an invalid diagnostic exactly as produced.

References: Microsoft documentation for [netsh trace](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-trace),
[WPR commands](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options),
[named ETW stop](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/logman-start-stop),
and [QueryAllTracesW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-queryalltracesw).

## Storage and privacy preconditions

Before capture, both parent and watchdog use read-only ACL inspection. Only a
local fixed output volume and a directory owned by the current user, SYSTEM or
Administrators are accepted. Allow rules must be restricted to those identities;
the current user must have inheritable full control. Unrecognized/denied rules,
reparse output directories or incomplete results fail closed. No ACL is rewritten.
The free-space probe uses GetVolumePathNameW and GetDiskFreeSpaceExW on the output
path, including mounted volumes, rather than assuming the drive-letter root.
These native probes have only static/mock coverage, not live installation validation.

ETLs, WPR symbol output and journals may identify other host processes, paths,
network endpoints, SIDs and unrelated ETW recorders. capture=no disables requested
packet capture; it does not sanitize provider events. Keep original evidence
private and review/redact a separate copy before sharing. Existing artifacts and
partial trace files are never removed by cleanup.

## Service-free validation

```powershell
node --test backend/benchmarks/controlled/tracing-controller.test.cjs backend/benchmarks/controlled/diagnostic.test.cjs
```

Tests inject fake processes, native commands, timers and filesystems. They cover
logging/disk failures, partial startup, unknown/replaced sessions, cancellation,
watchdog failure, finalization observations, native command error classification
and pinned input rejection. Temporary saved-trace fixtures are isolated under the
OS temporary directory. They do not establish real Windows ETW/WPR/Netsh behavior.
