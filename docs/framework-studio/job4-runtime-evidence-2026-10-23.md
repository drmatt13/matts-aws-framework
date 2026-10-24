# Job 4 local runtime evidence — 2026-10-23

This record covers local Node handler ownership, Docker reuse and persistent local
storage. It uses no AWS calls. Existing developer services, containers and storage
remain outside the campaign's ownership.

## Baseline and method

Baseline source: `16c374ba6c8717438c088f98333d6aba8a1f87a2` before the runtime
changes in this campaign. Node `26.0.0`, npm `11.19.0`, macOS `14.1.2` on Apple
silicon; detailed CPU/memory context is in the JSON evidence. Measurements ran in
coordinated windows without other campaign benchmarks. Existing Studio, browser
and prior Job 3 observer processes remained running, so these are workstation
measurements rather than an otherwise idle machine.

The Node harness creates nine pools, invokes one cold handler and ten warm calls
per pool, closes it, and observes the exact child PID exiting. It also records
already-cancelled calls, active warm plus overflow calls at close, and a new call
after close. There are no timing assertions in ordinary tests.

The Docker fixture uses project `job4-runtime-20261023`, existing images only,
no published ports, credential mounts or Docker socket mounts. A small HTTP
harness exercises the actual current framework `LambdaWorkerPool` inside the
existing development image; a separate PostgreSQL 16 container stores a synthetic
sentinel. Five cycles check stopped-container restart, unchanged `up` reuses the
same container ID, two serial handler calls reuse their warm PID, forced compute
replacement, SQL sentinel retention and graceful stop. This does not establish
full application API, replay, auth, workflow or runner parity.

| Baseline operation | Samples | Median | Range |
| --- | ---: | ---: | ---: |
| Cold Node handler | 9 | 91.58 ms | 86.82–104.15 ms |
| Warm Node handler | 90 | 0.092 ms | 0.062–0.188 ms |
| Close idle worker and observe PID exit | 9 | 5.65 ms | 4.72–6.25 ms |
| Docker stopped-container startup, healthy | 5 | 1,705.97 ms | 1,695.72–1,739.92 ms |
| Docker unchanged `up`, healthy | 5 | 565.94 ms | 560.81–570.51 ms |
| Docker compute replacement, healthy | 5 | 1,862.76 ms | 1,851.80–1,917.86 ms |
| Docker stop | 6 | 172.85 ms | 130.45–208.51 ms |

The one-second Docker healthcheck interval and CLI/exec overhead are included.
These values do not establish p95/p99 latency or image-build performance. No
image build or registry fetch was performed.

## Confirmed lifecycle defects and changes

Before the fix, closing a pool killed its warm child but left the concurrent cold
overflow running. The controlled handler completed successfully 1,497 ms later;
it remained alive at the 50 ms observation. Calling the same pool after close also
created another handler. An already-aborted direct pool invocation ran its handler
and resolved successfully in 89.51 ms. These are reproduced observations, not
inferred leaks from process listings.

Pools now have a terminal abort lifetime shared by all their calls. Closing cancels
warm and cold overflow children and refuses new work. The executor also owns a
terminal lifetime, so cold-only execution is cancelled on close. Pre-aborted calls
are refused before a child is spawned. Warm module-state reuse, bounded pool size,
environment replacement, errors and timeout behavior remain covered by tests.
For a container Lambda, executor cancellation aborts the caller's HTTP wait;
the invocation runner still owns container timeout/removal. This change does not
establish cancellation propagation to a remote runner container.

Studio also started Vite, watchers and evaluators before binding its port. In a
minimal isolated source fixture, an owned blocker caused `EADDRINUSE` after
2,138.54 ms, but Studio remained alive at the 10-second observation with four
filesystem watchers and two evaluator process handles. The harness then stopped
only that owned child. Startup now claims loopback before acquiring these resources,
returns 503 during initialization, and registers disposers as resources are acquired.
Startup failure releases them; shutdown prevents new refreshes, cancels evaluators,
settles tracked refreshes and disposes any late pair. The exact collision replay
detected the conflict at 1,352.25 ms and exited naturally with status 1 at
1,507.13 ms. This is failed-start recovery evidence, not a successful-start benchmark.

The image janitor previously allowed any project to remove legacy container-Lambda
images without a project ownership label. That could remove another checkout's
current cache. Such images are now preserved for explicit ownership review. This
is a safety correction; no cleanup-speed improvement is claimed.

## Evidence and replay

Ignored artifacts live under `.framework/job4/runtime/`:

- `baseline.json`: raw Node samples, controlled failure results and child PIDs.
- `docker-baseline.json`: each Docker operation, replies, SQL sentinel and stopped
  container inventory.
- `after.json`, `docker-after.json`: exact original Node and Docker replay.
- `startup-collision-{baseline,after}.json`: actual failed-start process outcomes.
- `studio-lifecycle.json`: successful startup, HTTP 200, refresh during shutdown,
  exit 0 and absence of all four observed owned process IDs.
- `docker-semantic-validation.jsonl`: all ten SQL sentinel values and five warm-PID
  reuse pairs per phase checked directly from the recorded operation replies.
- `cleanup.json`: exact ownership-validated container/network/volume cleanup.
- `compose.yml`, `container/`, `docker-lifecycle.mjs`: exact isolated Docker fixture.

Replay the Node harness from the repository root:

```sh
FRAMEWORK_BENCHMARK_DIRECTORY=.framework/job4/runtime \
  node --import tsx packages/framework/bench/lambda-lifecycle.mts replay
```

The Docker fixture is deliberately campaign-local. Inspect its resolved Compose
configuration before rerunning; never substitute the user's normal project or
volume. Use `docker compose -f .framework/job4/runtime/compose.yml stop` to stop
only this fixture. `down` removes its containers/network while preserving its
named volume. No volume removal is needed for repeat testing.

## After-change comparison

| Operation | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Cold Node handler, median 9 | 91.58 ms | 90.64 ms | No meaningful throughput claim |
| Warm Node handler, median 90 | 0.092 ms | 0.089 ms | Reuse stays intact |
| Idle close / observed PID exit, median 9 | 5.65 ms | 5.52 ms | Equivalent behavior |
| Already-cancelled pool call, one diagnostic | 89.51 ms, handler ran | 0.043 ms, rejected before handler | Removed incorrect execution |
| Active overflow at pool close | Alive at 50 ms; success after 1,497 ms | Both children absent at 50 ms; both calls rejected | Shutdown ownership repaired |
| New pool call after close | Started another child | Rejected | Closed state is terminal |
| Docker stopped-container startup, median 5 | 1,705.97 ms | 1,736.10 ms | No improvement claimed |
| Docker unchanged `up`, median 5 | 565.94 ms | 561.27 ms | Container ID reused |
| Docker replacement, median 5 | 1,862.76 ms | 1,954.78 ms | No improvement claimed |
| Docker stop, median 6 | 172.85 ms | 176.92 ms | Exit 0; no active container remained |

The active-close diagnostic includes a fixed 50 ms observation delay; it does not
establish the exact after-change cancellation latency. Every Node child PID had
exited at each harness completion. Every synthetic SQL sentinel check passed after
all ten before/after compute replacements. Cold starts still pay Node/tsx/module
loading; warm execution was already inexpensive, so no speculative startup cache
or Docker build-skip behavior was introduced.

## Verification and remaining scope

The first targeted runtime run had 21 passes and one fixture failure: the new
executor test omitted the DSL's required empty sections and failed before invoking
the executor. Adding those sections corrected fixture construction; the isolated
executor rerun passed. The complete corrected replay is recorded separately below.

The complete corrected combined suite passed **24/24**, zero failures or skips,
in `focused-final.log`: fourteen pure/injected image-ownership tests, eight real
Node process lifecycle tests and two real loopback/startup-failure tests. The
successful minimal Studio replay then returned HTTP 200, received a controlled
source change and exited 0 after SIGTERM. Shutdown took 35.45 ms in that diagnostic;
all four observed process IDs were absent after exit. These are bounded regression
journeys, not an hours-long soak test.

The first targeted framework and Studio typecheck attempts both caught TS2440 in
a concurrent build-specialist edit to `config/index.ts` (duplicate
`isDeploySettingEnabled`). The owning specialist removed that intermediate duplicate
and owns the corrected framework/Studio typecheck replay. Original failed logs
remain preserved; the consolidated report records final typecheck/gate results.

Cleanup validated the campaign labels before removing exactly its two stopped
containers, default network and synthetic `job4-runtime-20261023_postgres_data`
volume. No campaign container or network remained. The user's existing
`matts-aws-framework_postgres_data` volume was never mounted by this fixture and
kept its original identity/creation time. Existing user images and services were
preserved. All fixture source and raw evidence remain on disk.

The campaign lead owns the final repository-wide verification and independent
developer-acceptance report. This record does not claim AWS runtime, live RDS,
application authentication, production deployment, remote runner cancellation or
Windows process-signal execution. Existing same-name Compose projects still share
images, container names and volumes as documented in Development.

Independent source review identified a separate `CommandRunner` lifetime risk.
The [independent QA pass](job4-independent-qa-2026-10-23.md) subsequently reproduced
an active command and descendant surviving Studio shutdown, repaired command-tree
ownership and replayed the actual-server scenario successfully. That evidence is
separate from this specialist's pool and failed-start probes.
