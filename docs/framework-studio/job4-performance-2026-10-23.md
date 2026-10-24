# Job 4: developer acceptance and performance — October 23, 2026

This is the integrated Job 4 implementation and evidence report. Historical
Jobs 1–3 and the visual refinement campaign supplied test cases; their results
are not counted as current verification. The initial working tree was clean.
The campaign changed source processing, graph computation, canonical generation
and process ownership. It preserved the existing visual design and features.
No cloud deployment, publication, user database migration or shared Docker cleanup
was performed. The final repository gate passed. **Decision: CONDITIONAL GO for
a limited developer beta on the tested local environment.** Cloud release paths,
native Windows execution and longer heap attribution remain separate acceptance
work. No remaining P0/P1 blocker was identified in the measured and reviewed paths.

## Method and reproducibility

Measurements run serially in coordinated CPU windows on an Apple M3 Pro,
11 logical CPUs, 18 GiB memory, macOS Darwin 23.1.0 arm64, Node 26.0.0 and npm
11.19.0. Installed dependencies are shared where explicitly stated; clean
installation is a separate acceptance experiment. Existing user Studio and
unrelated processes remain running and are preserved. Five local samples permit
reporting a median and observed maximum, rather than a meaningful p95 or p99.
Process-cold does not mean cold OS filesystem caches.

The first full gate overlapped a 258-second macOS idle sleep. A later benchmark
overlapped a 50-second sleep and another 95-second maintenance sleep, crossing
its generator timeout. Those interrupted timings are not performance samples.
`host-sleep-events.log` and the independent acceptance correlation preserve the
evidence. The final benchmark and gate use a command-scoped `caffeinate -i`
assertion, verified with `pmset -g assertions`; no saved power policy changed.
The final OS audit found no sleep/wake events from 20:45 EDT through completion
of the final benchmark and gate (`final-sleep-audit.json`).

Ignored raw evidence lives under `.framework/job4/`. The source benchmark uses
26 real declared targets and 30 catalog resources, copies authored source and
manifests into a private directory containing spaces, and excludes private env
files, dependencies and deployment outputs. Every Apply/Undo affects that fixture.
This source-service fixture omits client/Prisma implementation content; it is not
a full application startup measurement. The separate clean acceptance archives
include the complete tracked application and install their own dependencies.
The harness records nested evaluator/validation/generator spans, payload bytes
and parent RSS. Nested spans must not be added together. Browser latency and
source-service latency are separate measurements.

```sh
caffeinate -i node --import tsx framework-studio/scripts/benchmark-source.ts \
  --samples 5 --output .framework/job4/source-replay.json
```

The starting revision is recorded in `source-before.json`; its relevant source
implementation matched that revision before optimization. After evidence also
records the relevant working patch hash. The same harness, fixture and order are
used for the comparison. See the specialist evidence for graph/build/runtime
commands and measurement boundaries.

## Source proposal baseline and confirmed causes

All times below are milliseconds. Before and after used the same fixture,
operation order and five samples, except the single process-cold snapshot.
The final harness exited 0 with all lifecycle changes included. Evidence:
`source-before.json`, `source-after.json`, their logs and `source-comparison.json`.
A sleep-interrupted intermediate run is preserved separately and excluded.

| Source-service operation | Before median | After median | Reduction | Before / after maximum |
| --- | ---: | ---: | ---: | ---: |
| First snapshot, n=1 each | 3,759.90 | 3,391.62 | 9.8% | Same as sample |
| Small Lambda property review | 5,649.87 | 1,416.08 | 74.9% | 6,896.68 / 1,461.46 |
| Add environment mapping | 5,278.39 | 1,416.38 | 73.2% | 5,652.31 / 1,437.98 |
| Add scoped IAM grant | 5,257.53 | 2,400.88 | 54.3% | 5,401.48 / 2,549.69 |
| Create HTTP Lambda | 3,375.40 | 2,381.16 | 29.5% | 3,678.05 / 2,790.47 |
| Multi-resource review | 5,107.07 | 1,493.53 | 70.8% | 5,318.84 / 1,682.94 |
| Description-only review | 3,379.48 | 439.60 | 87.0% | 3,710.17 / 479.21 |
| Source Apply | 2,914.15 | 1,027.60 | 64.7% | 3,059.50 / 1,092.23 |
| Source Undo | 2,666.86 | 1,038.98 | 61.0% | 2,791.74 / 1,099.85 |
| No-op refusal | 1,643.60 | 3.42 | 99.8% | 1,708.73 / 4.45 |
| Invalid numeric field refusal | 1.26 | 1.07 | 15.5% | 1.84 / 1.31 |
| External TypeScript edit → refreshed model | 953.60 | 568.17 | 40.4% | 1,000.03 / 668.84 |

The sub-millisecond difference in invalid-field refusal is not a meaningful
performance gain. The single cold-snapshot observation is descriptive. Every
common review median improved; no unsupported percentile or universal latency
SLO is inferred from this workstation sample.

These measurements confirm expensive work before the diff reaches the browser:

1. `BatchEditor.plan` validated both modes, generated artifacts in a disposable
   copy, then validated both modes again. Metadata edits without generation also
   performed two complete validations. Each evaluator starts a fresh module graph.
2. Connection comparison included source-evidence excerpts and locations attached
   only to snapshots. An unchanged declared grant therefore appeared changed,
   causing full candidate TypeScript checking even for memory or description edits.
3. Implementation health repeatedly enumerated/resolved the full configuration
   inside per-target artifact/authentication checks. The build specialist measures
   its separate scaling behavior and owns the canonical fix.
4. A no-op description was recognized only after an entire validation pass.
5. A later large-fixture challenge found the remaining per-target normalization
   in availability, cloud-edge checks and Lambda field resolution. A 500-target
   projection alone took 73.97 seconds, exceeding the evaluator's 60-second
   response budget. That confirmed P1 was repaired during the second pass.

The diff algorithm was not the important delay. After-only diagnostic medians
were 5.28 ms for AST splice plus exact diff, 0.050 ms for diff calculation alone
and 0.017 ms for proposal JSON serialization (five samples). These unchanged
micro-stages were added after the comparable scenarios; they have no before
comparison. A small-property review still returns 1,631 bytes, and an external
refresh returns 601,787 bytes in both phases. Payload truncation did not produce
the speedup.

The source patch generates first in the existing private workspace, then validates
the exact final candidate once. Generator failures still block valid candidates;
invalid candidates retain both-mode diagnostics. It excludes only display evidence
from binding comparison, retaining permission/scope/destination/invocation fields.
No-op drafts stop before generation/evaluation. Final review rechecks all captured
generation inputs after asynchronous validation. Apply still revalidates, checks
source hashes/absence, journals before writes, refreshes both graphs and compares
their actual semantics; guarded rollback and Undo remain in place.

There is no new cross-request source cache. Existing declaration parsing remains
dependency-lock/compiler-options keyed and idle-expiring. Request-local snapshots
must be recreated for each evaluation rather than retained across source edits.

For a small-property review, both-mode validation fell from two calls to one,
with median individual spans of 2,323 ms before and 448 ms after. Its generator
still runs once, approximately 896 ms after. A real scoped grant retains candidate
typechecking; its after validation span is 1,453 ms. Apply retains its candidate
evaluation and post-write refresh. These are intentional correctness costs.
Observed parent RSS snapshots ranged from 0.88–1.69 GB before and 0.94–1.42 GB
after; they exclude child-process memory and do not prove a retained-heap reduction.

## Runtime and Docker evidence

See [runtime evidence](job4-runtime-evidence-2026-10-23.md). Initial Node probes
reproduced overflow children surviving pool closure, successful work after closure
and handler execution from an already-aborted signal. The implementation tracks
those lifetimes and treats closure as terminal. Image reconciliation preserves
legacy images whose checkout ownership cannot be verified.

The isolated Compose baseline reused unchanged container IDs, and a PostgreSQL
sentinel survived five compute replacements. These local observations concern the
campaign harness and actual PostgreSQL, rather than a deployed application or RDS.
Routine stops preserve volumes. Only resources with verified campaign ownership
may be removed; no global pruning is permitted or performed.

| Operation | Before | After | Interpretation / evidence |
| --- | ---: | ---: | --- |
| Cold Node handler, median 9 | 91.58 ms | 90.64 ms | Equivalent; runtime `baseline.json` / `after.json` |
| Warm Node handler, median 90 | 0.092 ms | 0.089 ms | Reuse preserved; no meaningful speed claim |
| Docker stopped-container startup, median 5 | 1,705.97 ms | 1,736.10 ms | No improvement claimed |
| Docker unchanged `up`, median 5 | 565.94 ms | 561.27 ms | Same container IDs reused |
| Docker compute replacement, median 5 | 1,862.76 ms | 1,954.78 ms | Sentinel retained; no speedup |
| Docker stop, median 6 | 172.85 ms | 176.92 ms | Exit 0 and no active fixture container |
| Occupied-port Studio start, diagnostic n=1 | Still alive at 10 s | Natural exit 1 at 1.51 s | Failed-start ownership repaired |

The active-overflow baseline remained alive 50 ms after pool close and returned
success 1,497 ms later. After repair both active children were absent at 50 ms
and both calls rejected. Pre-aborted work no longer executes; calls after close
are refused. A successful minimal Studio startup, controlled refresh and SIGTERM
exited 0 in 35.45 ms; all four observed owned PIDs were absent. These are bounded
cleanup receipts, not throughput or successful-start timing distributions.

Independent QA then reproduced an active allowlisted Studio command surviving
shutdown with its wrapper and descendant. `CommandRunner` now owns and disposes
its supervised process tree. The exact server replay left all three recorded
PIDs absent at +200 ms, while an unrelated control survived. Inter-step shutdown
reports cancellation and prevents later commands. See the
[independent QA report](job4-independent-qa-2026-10-23.md).

The final shutdown challenge also reproduced blocked evaluators surviving
mid-startup termination, queued refreshes acquiring replacement pairs during
cleanup, and a blocked source-review pair outside the snapshot pool. Signal
supervision now starts before acquisition, joins startup and drains late
resources. One explicit per-Studio evaluator owner includes snapshot, batch,
route and resource validation pools. Closing it is terminal; no process-global
registry is introduced. Exact replays stopped all owned evaluators and preserved
source. An evaluator that registers SIGTERM and blocks receives SIGKILL after a
one-second grace, targeted only at its recorded ChildProcess.

Artifact generation now uses the existing tethered process supervisor. It waits
for process/output closure before rejecting a timeout and deleting its preview.
An actual owner-death probe originally left the blocked generator alive. A
further test caught the shared tether exiting while a signal-ignoring grandchild
survived: the tether now finishes only its detached child's POSIX process group
on direct-child exit and preserves the original exit status. Both owner-death
and normal-success descendant probes pass, as do unrelated-control survival
checks. These changes are remeasured in the final source benchmark; their extra
supervisor process is not treated as free.

An alternating empty-Node-command probe measured 47.07 ms direct versus 96.60 ms
tethered (+49.52 ms median, 15 samples each after three discarded warmups), with
identical stdout. That isolates supervisor startup. The complete source numbers
above include this cost; the lifecycle repair is not claimed as a speedup.

After label verification, the runtime specialist removed exactly its two stopped
containers, its network and its synthetic PostgreSQL volume. The original ten
stopped user containers and `matts-aws-framework_postgres_data` were preserved;
the campaign never mounted that volume. Existing images were reused. Ownerless
legacy runner images are now retained for explicit review. No AWS resources or
ongoing cloud costs were created. Remote runner cancellation is not proven by
aborting the executor's HTTP wait.

The lead's final read-only Docker audit independently found no campaign containers,
networks or volumes and confirmed the original user volume's October 12 creation
time (`docker-final-audit.json`). Acceptance closed both owned Studio servers,
the API and observed workers; exact fixture-command/path inspection found no
remaining evaluator or Studio processes. Ports 4598, 4599 and 4601 refused
connections. Its 64 owned browser artifacts were moved into ignored evidence.
Only the two disposable dependency trees and task-specific npm cache were removed
(4,861,300,736 allocated bytes); the original dependency directory retained its
inode. Source, lockfiles and raw receipts remain. See acceptance cleanup receipts;
individual acceptance evaluator PIDs were not captured before closure, so its
process claim is based on the exact-path residual audit.

## Graph scaling and browser evidence

See [frontend evidence](job4-frontend-evidence-2026-10-23.md). Deterministic mixed
fixtures contain 25, 100, 250 and 500 entities. Initial warm scene medians were
1.33, 12.26, 47.00 and 139.69 ms respectively; Board layout remained below 0.7 ms
at 500. CPU sampling identified exact path/segment intersection checks as the
main computation cost. Conservative geometric rejection is tested against exact
route-output hashes and boundary cases; it adds no retained source/model cache.

| Entities | Warm scene before / after, median 5 | Reduction | Production browser load before / after, median 5 |
| ---: | ---: | ---: | ---: |
| 25 | 1.33 / 1.06 ms | 19.7% | 144 / 145 ms |
| 100 | 12.26 / 7.60 ms | 38.0% | 178 / 172 ms |
| 250 | 47.00 / 25.81 ms | 45.1% | 253 / 229 ms |
| 500 | 139.69 / 67.21 ms | 51.9% | 430 / 328 ms |

Complete routed-point/length hashes matched at all four sizes. Cold 500-entity
scene construction fell from 173.15 to 95.22 ms (one sample each). Board layout
was already below 0.7 ms at 500. The saved real declaration graph had 61 drawn
nodes: warm scene 3.43 ms and Board 0.126 ms, after-only observations.

Synthetic headless browser measurements remain distinct from real-source GUI
acceptance. Software rasterization and retained visual effects limit large-scene
frame rate even where JavaScript drawing is relatively short. They do not justify
claiming a general FPS improvement from layout timings.

The browser uses sandboxed Chromium 155 with SwiftShader, isolated archived
production assets and intercepted synthetic snapshots. At 500 entities, Inspector
opening was 166→161 ms, JavaScript drawing 3.2→3.1 ms and RAF intervals remained
about 50 ms. Search was 313→322 ms; the 100-entity 56→87 ms difference was variable
and has no established causal regression. This patch materially improves scene
construction/load, not every interaction or 60 FPS on software rendering.

The independent continuation performed 180 Board↔Isometric/search cycles, forcing
GC at checkpoints. Retained JavaScript heap was 13.316 MB initially, 15.121 MB at
90 cycles, 15.482 MB at 180, and 15.507 MB after three idle seconds and GC. Visible
DOM count stayed 2,129 and EventSource created/active/peak remained one. CDP's
broader DOM counters and browser performance/history buffers were also recorded.
The later 90 cycles added 0.36 MB; attribution and an absolute plateau are not
established. This is a bounded soak, not hours-long or leak-free certification.

An additional Chrome DevTools session inspected the actual fresh-fixture server:
no console warning/error and successful snapshot/recovery requests. A single
1440×1000 reload trace reported LCP 574 ms and CLS 0.17; this has no controlled
before comparison. The MCP refused the raw trace export path, so only returned
trace summaries are retained in `browser/root-chrome-receipt.json`. The actual
420-pixel mobile verification belongs to Playwright acceptance; Chrome's resize
settled at a 500-pixel inner width and is not claimed as 420-pixel coverage.

## Build, generation and infrastructure evidence

See [build and generation evidence](job4-build-evidence-2026-10-23.md). Factories
now resolve canonical target settings once per operation. Projection temporarily
installs a fresh Lambda batch and restores/deletes it in `finally`; later
projections observe in-place mutation. Availability, local/cloud target selection
and cloud-edge checks use the same canonical deploy predicates. There is no
persistent normalized-config cache or optimistic timestamp skip.

| Operation | Before | After | Samples / result |
| --- | ---: | ---: | --- |
| Projection, 100 targets | 1,171.11 ms | 19.08 ms | Before n=1; after median 3 |
| Projection, 500 targets | 73,972.76 ms | 204.56 ms | Before n=1; after median 3; 99.72% lower |
| Implementation health, 100 Lambdas | 14,620.57 ms | 15.33 ms | Median 3; 99.9% lower |
| Artifact checks, 500 Lambdas | 8,927.12 ms | 41.93 ms | Median 5; 99.5% lower |
| Generator with 500 additional Lambdas | 26,570.49 ms | 1,389.70 ms | Median 3; 94.8% lower |
| Ordinary generator CLI | 858.11 ms | 895.95 ms | Median 5; 4.4% higher, overlapping ranges |
| Ordinary framework check CLI | 1,490.23 ms | 1,472.49 ms | Median 3; equivalent |
| Prisma generation | 894.58 ms | Not separately retimed | Baseline median 3; final gate runs generation |
| GraphQL/client operation drift check | 851.38 ms | Not separately retimed | Baseline median 3; final gate checks drift |
| Framework checks, both TypeScript configs | 7,521 ms | Correctness replay only | Baseline n=1; no build-speed claim |
| Studio production build | 648 ms | 362 ms reported by Vite | Different timing boundaries; no speedup claim |
| Reference client production build | 1,023 ms | Not separately retimed | Baseline n=1; no client source changes |
| Normal-bundled dev CDK entrypoint | 3.67 s | 3.15 s | n=1 each; not complete CDK CLI |
| Normal-bundled prod CDK entrypoint | 8.14 s | 8.22 s | n=1 each; no synth-speed claim |
| Full successful Studio startup | No comparable baseline | 8.70 s fresh fixture | One install/Vite observation; includes different work from snapshot |

Ordinary generation is dominated by fresh-process loader/TypeScript/schema work.
The framework exports TypeScript source directly and has no separate build
script; its source/tooling typechecks and consumer bundles are the applicable
framework build checks.
Its unchanged small-application cost is reported honestly. The confirmed scaling
failure was repeated whole-config work: implementation health read the HTTP list
10,301 times at 100 targets; now three times at all tested sizes. Projection's
complete declaration scans are now ten independent of target count. A 200-target
health baseline was interrupted by its exact owned PID after it failed to finish;
no completed baseline latency is invented. Its after-only median is 28.83 ms.

All 12 generated files in ordinary and 500-additional-handler fixtures retained
exact bytes and timestamps. Four dev/prod × WebSocket on/off model projections
retained all 697,879 serialized bytes. Normal-bundled offline synths passed in
both explicit modes, with WebSockets enabled. Full semantic comparison preserved
resource logical IDs/types/properties, outputs/exports, metadata and stack
environments, normalizing only exact asset IDs listed in asset manifests:
dev 5 stacks / 66 resources / 38 outputs; prod 11 / 253 / 78. Final comparisons
include the second projection repair. These are synthesis checks, not deployment.

Cloud client-environment export and deployment preparation were not benchmarked:
they require actual account/output observation absent from the isolated fixtures.
No outputs or success states were fabricated. Normal generation, authentication,
artifact, schema and source validation remain mandatory. Dependency versions and
the lockfile are unchanged. Studio's test script now runs two files concurrently,
as explained in the verification section.

## Developer acceptance

See [independent developer acceptance](job4-developer-acceptance-2026-10-23.md).
Two archived clean fixtures used paths with spaces, no copied private/authored env files,
original installed dependencies, account directories or CDK outputs. The first
actual network `npm ci`, with a task-specific empty cache, succeeded in 55.31 s
including Prisma postinstall, after the sandbox DNS boundary was granted. The
second used only that newly populated cache offline. Neither changed the lockfile.
README and Development now explicitly require npm 11 alongside Node 24+.

Actual GUI journeys created an authenticated HTTP Lambda, event, private retained
S3 bucket, scoped `grantRead("allowed/*")` relationship and Cognito identity pool.
Reviewed source was applied; Undo removed the handler and Redo restored it.
A stale review disabled Apply and preserved its draft; re-review preserved the
external comment. The Prisma workbench reviewed/saved a comment-only contract
change, with no database connection or migration. An invalid external TypeScript
edit paused editing and retained the last valid graph; restoring source recovered
automatically. Keyboard creation and actual 420×900 layout were exercised.

The new empty AWS profile initially received an incorrect expired-SSO remedy:
the CLI's missing-credentials message contained an `aws login` hint. Classification
now recognizes explicit expiry first, concrete missing credentials next, then
generic login advice. Two regression tests and actual Cognito browser replay
confirmed the correct missing-credentials message while source stayed valid.

The independent code-first fixture authored literal feature modules, shared
settings/comments, scoped permissions and native stack registration before
opening Studio. Generation/check and real HTTP/event invocations passed. The
actual local API returned 200 twice with a reused warm PID; undeclared POST
returned the documented 404. API and worker PIDs were absent after shutdown.
The fresh code-first Studio then discovered 64 resources and 61 relationships,
including feature HTTP/event resources and the scoped grant, with Inspector
source links to the feature module. Actual keyboard review and
Apply changed memory from 128 to 192 MiB. Exact comparison proved that only the
memory literal changed: the shared sizing spread, author comment and grant scope
were preserved, and six other authored files retained their hashes. No mandatory
GUI metadata was present. Both desktop and 420-pixel views stayed source-valid;
the browser recorded no console errors or warnings and the final fixture
`framework:check` exited 0.

One identity-pool wizard review remained pending for approximately 34 seconds
while concurrent correctness work was active, then enabled Apply successfully.
This contended observation has no isolated baseline or reliable stage timing;
it is retained as a latency uncertainty, not reported as an optimization win.

Direct dev synthesis completed without missing context. Fresh prod structural
synthesis emitted templates but requested availability-zone context; it is not
counted as complete production preparation. The build specialist's separate
normal-bundled synth has the required explicit offline context.

Code-first synthesis later authored minimal synthetic dev/prod environment inputs;
it did not copy the developer's credentials or private configuration.
Full GUI application Compose startup, AWS sign-in/identity exchange, deployed
database behavior, deployment preparation and client output generation remain
unverified here. Disabled client environment/release controls explained
account/region prerequisites.
The actual synthetic Docker/PostgreSQL and local code-first API checks above
cover their stated scopes. Native Windows execution was unavailable; independent
tests covered Windows path strings on macOS.

## Independent review and reliability

Five specialists covered runtime/Docker, frontend scaling, build/generation,
fresh developer acceptance and adversarial QA; the campaign lead owned source
review performance and integration. Later independent passes challenged the
author's successful paths. Confirmed defects were repaired and replayed rather
than left as recommendations.

QA challenged stale factories, in-place config mutation, invalid packaging/auth
inputs, all nine workload roles, deployment modes, WebSocket flags and tool
unions. Source checks preserved POSIX permissions and external bytes while
refusing obsolete proposals, traversal, UNC/absolute paths and symlink parents.
Interrupted-journal recovery restored campaign writes while preserving a later
user edit. Competing processes retained the exclusive checkout lock. Review also
caught an input-hash merge that could overwrite an earlier guard; trigger and
generation hash sets are now checked independently. No grant scope, approval,
fixed command allowlist or source authority was broadened.

The late audit reproduced and repaired startup, queued-refresh, active-review,
signal-ignoring evaluator and generator-descendant shutdown defects. Independent
replays passed against the final shared supervisor. Failed candidate validation
now reports the existing safe 422 refusal before comparing valid-model semantics;
valid changed semantics still reject with 409. This prevents failed models with
empty targets from being mislabeled as a stale proposal. It does not relax any
source or semantic guard.

## Verification and release decision

The first integrated repository gate exited 1: Studio reported 831 passes,
one creation-semantics conflict and two skips. The failing catalog/secret creation
test took 283 seconds. Two exact isolated replays passed in about 15.4 seconds,
with all forward/inverse signatures equal in both modes. The preserved OS log
subsequently identified a 258-second sleep at 19:33:04–19:37:22 EDT inside the
792-second Studio suite (the preceding ws-tester launch anchors it at 19:26:52).
Subtracting that suspension from the four long cases leaves 25.47, 43.45, 49.34
and 25.38 seconds, consistent with the shared stall. The final uninterrupted
replay passed; the initial exit 1 remains recorded. The exact
internal failed-model/409 mechanism was not logged and remains inferred.
A diagnostic four-case
concurrent replay passed all four in 46.24 seconds; no deadline or canonical
mismatch occurred. Its observed peak aggregate RSS was 5.157 GiB and VM counters
recorded roughly 995 MiB swapped out. This establishes pressure in that replay,
but does not establish memory pressure as the original failure's cause. Its
memory/model diagnostics were not captured. The failed receipt is
`verify-integration-pass1.log`; the independent correlation is
`acceptance/evidence/first-gate-host-sleep-correlation.json`. Semantic validation
was preserved throughout. The final gate exited 0; the previously failing case
passed in 16.67 seconds within the full suite.

The identical four-case replay at two concurrent files passed in 48.44 s versus
46.24 s at four (+4.8%, one run each). Observed peak aggregate RSS was
4.908 versus 5.157 GiB; evaluator maximum was 608 versus 1,351 ms. Whole-workstation
VM counters recorded zero swap-out pages in the two-file run versus 63,656 in the
four-file run, with substantially fewer compression/decompression operations.
The runs are ordered, small and not an otherwise idle-host experiment; they do
not establish a universal speed or memory gain. Studio's test script now bounds
concurrent files at two to limit simultaneous TypeScript work. It retains every
case, assertion and timeout. The final gate records external five-second process
RSS/VM samples without injecting test hooks or changing validation.

**Final `npm run verify`: exit 0, 782.56 s (13 min 2.56 s).** It completed lockfile
platform checks, framework artifact/auth drift checks, offline Prisma generation,
GraphQL/client document drift checks, every workspace TypeScript check, executable
schemas and workspace suites. The external resource sampler recorded 158
checkpoints and a maximum observed aggregate process RSS of 4.27 GiB; shared
pages are double-counted and this is not retained heap. Whole-host swap counters
still advanced during the full gate; no elimination of paging is claimed.
Evidence: `verify-final.log`, `verify-final-resources.json`,
`verification-summary.json` and `verification-sleep-assertion.txt`.

| Final gate suite | Passed | Skipped |
| --- | ---: | ---: |
| Executable GraphQL schemas | 22 | 0 |
| Reference client | 65 | 0 |
| Local API | 16 | 0 |
| Invocation runner | 27 | 0 |
| CDK/application | 276 | 1 |
| Database workspace | 28 | 0 |
| Framework | 490 | 0 |
| Models | 4 | 0 |
| Studio | 844 | 2 |
| **Total test executions** | **1,772** | **3** |

There were zero failures or cancellations. The three skips are explicit opt-in
database integrations: retained PostgreSQL lifecycle, Compose migration/recovery,
and real seed-ledger/constraint rollback. They were not enabled by the offline
gate. Actual isolated PostgreSQL persistence was separately tested through all
ten sentinel checks; that does not substitute for migration/seed execution or
live application/RDS authorization.

The final Studio production build exited 0 and reported 362 ms bundling, retaining
the existing >500 kB chunk warning. The knowledge checker passed all 30 pages,
593 links and 168 source references; `git diff --check` passed. No generated
framework/GraphQL/Compose artifact or lockfile drift remains.

Focused evidence already completed, reported separately to avoid counting
overlapping tests as independent observations:

| Check class | Actual evidence |
| --- | --- |
| Source diff / proposal / transactions | 34/34, zero skips; real exact diffs, Apply/Undo/rollback, conflicts and generator-input changes |
| Runtime / image ownership / server lifecycle | 24/24 combined; independent second replay also 24/24 |
| Frontend geometry / UI / event ownership | 140/140 using Studio workspace configuration; route hashes equal at all four sizes |
| Build / projection correctness | 31 focused tests; framework and Studio TypeScript configs passed |
| Independent command supervision | 4/4 including hard owner kill and inter-step cancellation |
| Final lifecycle continuation | Independent server 6/6 and command 4/4; creation/supervisor 5/5 plus combined command replay 9/9 |
| Independent factory / path / source safety | 16/16; interrupted journal/locking 2/2; stale proposals 3/3 |
| Independent deployment/projection matrix | 6/6; all roles, deploy tokens, tool unions and WS flags |
| Validation-failure precedence | 4/4: failed creation/operation preflight refuses 422; validated changed semantics refuses 409; no journal writes |
| AWS error classification | 2/2 and actual browser replay |
| Docker integration | Actual isolated Compose, unchanged IDs, all ten PostgreSQL sentinel checks, scoped cleanup |
| Browser | Actual fresh GUI and code-first sessions; production synthetic before/after; independent 180-cycle continuation; Chrome diagnostics |
| Infrastructure | Both explicit offline modes, normal bundling; semantic/logical identity comparisons passed |
| Database / deployed | Synthetic PostgreSQL only; no live user DB/RDS, migration application or deployment |

Reproduce focused benchmarks with `benchmark-source.ts`,
`framework-studio/scripts/benchmark-graph.ts`,
`framework-studio/scripts/benchmark-projection.ts`,
`packages/framework/scripts/benchmark-artifacts.ts` and
`packages/framework/bench/lambda-lifecycle.mts`. Specialist reports define their
exact fixture preparation, timing boundaries and safe teardown commands. Ordinary
tests assert bounded work, freshness and ownership rather than fragile timing.

Remaining measured limits are large-scene software rasterization, roughly
95 ms cold 500-entity layout, 205 ms projection, mandatory generator/typecheck
costs for consequential edits, a substantial production entry chunk and finite
unattributed browser heap drift. The smallest follow-ups are allocation-snapshot
attribution over a longer session, native Windows execution and authorized
development-account acceptance for the explicitly blocked cloud workflows.

**Limited beta: CONDITIONAL GO.** The repaired source, generation, graph and
graceful process-lifecycle paths pass their independent checks and the integrated
gate on macOS/Apple silicon with Node 26/npm 11. No remaining P0/P1 blocker was
identified in those measured paths. This is not production or all-platform
certification. Native Windows execution, an extended heap/allocation study, a
quiet replay of the contended identity-pool wizard, and authorized development
account checks for Cognito/client outputs/deployment remain the smallest useful
follow-ups. No migration or cloud action is pending from this patch.

The final read-only local audit found all last benchmark/gate processes and
temporary sleep assertions gone; campaign ports 4592, 4598, 4599, 4601 and 4608
refused connections. The original user Studio PID 31295 remained on port 4590.
Its existing process was preserved and needs a restart to load backend lifecycle
changes. See `final-local-audit.json`. Active evaluator cleanup was tested for
supervised SIGINT/SIGTERM; direct hard termination while arbitrary configuration
blocks is not certified. Command/generator owner-death tests separately include
hard owner termination. No unrelated process was stopped.
