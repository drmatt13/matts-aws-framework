# Job 4 build and generation evidence — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

This specialist record covers offline generation, source implementation checks,
builds and synthesis. The integrated report owns browser, database, Docker,
developer acceptance and the final repository gate. No database migration, AWS
modification, publication or dependency upgrade was performed here.

## Method and baseline

Baseline revision: `16c374ba6c8717438c088f98333d6aba8a1f87a2`.
Host: Apple M3 Pro, 11 reported CPUs, 18 GiB RAM, macOS Darwin 23.1.0 arm64;
Node 26.0.0, npm 11.19.0. Agents coordinated quiet CPU windows. Each CLI sample
started a fresh process; filesystem/transform caches were warm after the first
sample, not OS-cache-cold. Small samples do not establish p95. OS-wide process
inspection was denied by the sandbox; no claim of an entirely idle host is made.

Raw scripts, stdout/stderr, CPU profiles, JSON samples and disposable fixtures
are ignored under `.framework/job4/build/`. `/usr/bin/time -p` recorded CLI real,
user and system time. In-process fixtures also recorded CPU usage and RSS
snapshots; RSS is not retained heap. The first sandboxed native `tsx` CLI attempts
failed because its IPC socket was denied; actual generator timings below came
from an approved native invocation, not those failed attempts.

| Operation | Baseline | Samples | Evidence |
| --- | ---: | ---: | --- |
| `npm run framework:generate`, ordinary application | 858.11 ms median | 5 | `baseline-clean.jsonl` |
| `npm run framework:check` | 1,490.23 ms median | 3 | `baseline-native.jsonl` |
| Prisma contract emit | 894.58 ms median | 3 | `baseline.jsonl` |
| GraphQL/client operation generation drift check | 851.38 ms median | 3 | `baseline.jsonl` |
| Framework TypeScript checks, both configs | 7,521.12 ms | 1 | `baseline-framework-typecheck-1.log` |
| Studio production build | 648.08 ms | 1 | `baseline-studio-build-1.log` |
| Reference client production build | 1,022.52 ms | 1 | `baseline-client-build-1.log` |
| Development CDK entrypoint, normal bundling | 3,672.59 ms | 1 | `synth-dev.json` |
| Production CDK entrypoint, normal bundling, WebSockets enabled | 8,138.25 ms | 1 | `synth-prod.json` |
| Full framework generator, 500 additional HTTP Lambdas | 26,570.49 ms median | 3 | `fixture-generator-baseline.json` |
| Implementation health, 20 HTTP Lambdas | 100.05 ms median | 3 | `health-baseline.json` |
| Implementation health, 100 HTTP Lambdas | 14,620.57 ms median | 3 | `health-baseline.json` |

CDK measurements explicitly set dev/prod context with WebSockets enabled in both
modes, use synthetic input files and
an empty credentials file, disable metadata and retain normal bundling. They
invoke the real application entrypoint directly and exclude the CDK CLI's
separate Prisma build prerequisite; they are not complete CLI latency numbers.
Synthesis performs no deployment or live runtime check. No client environment
export against AWS or deployment preparation was timed, because that would
measure external account/CloudFormation work beyond these local fixtures.

The 200-target implementation-health baseline was stopped after the completed
20/100 samples: the first 200-target sample had not completed. Its exact campaign
PID was identified before SIGTERM; exit 143 and the recovery of completed stdout
records are documented in `health-baseline-interruption.txt`. No 200-target
baseline latency is claimed.

## Confirmed causes and implementation

Ordinary generation is dominated by process/module loading and TypeScript/JSON
schema work. A CPU profile (`generator-baseline.cpuprofile`) and isolated imports
confirmed substantial loader/tsx/TypeScript/Prettier work. Deferring JSON schema
loading was rejected: this application actually has a Python JSON contract and
agent/tool schemas, so those dependencies are required.

Larger applications exposed repeated normalization:

1. Artifact checking resolved each Lambda by normalizing the whole application.
2. Route validation called whole-config `isTargetEnabled` for every route.
3. Local target selection repeated that work per target before Compose generation.
4. Studio implementation health ran complete wrapper checks for each handler.
   Cognito checks resolved every Lambda before consulting the selected-source
   callback, multiplying the full-application work again. A 100-target operation
   read the complete HTTP declaration list 10,301 times; 20 targets read it 461
   times. Existing route validation inside normalization amplifies the cost.

`getLambdaTargets` resolves all Lambda settings from one fresh normalization.
`createTargetArtifactValidator` and the Cognito validator capture settings only
for one operation. Standalone artifact/resolution APIs remain fresh across calls.
Canonical per-target agent/tool checks preserve the existing diagnostics. Studio
reads each implementation source once for its export and wrapper checks.
Route validation and local selection use normalized deploy settings with the
existing deploy predicate. Mandatory validation, exact source guards, packaging
checks, wrapper checks and generator output determinism remain required.

No persistent cache, timestamp-based skip, shared workspace cache or source-edit
invalidation scheme was added. Factories must be recreated after config changes.
Prisma/GraphQL dependencies and the sequential authored-contract workflow remain
intact; their current measured costs did not justify speculative caching or
weaker generation checks. Dependency versions and the lockfile remain unchanged.
The integrated verification work later changed Studio test concurrency from four
to two after a paired resource-contention study; that scheduling change is owned
by the integrated report.

## Measured result and verification

| Operation | Before median | After median | Change | Samples per phase |
| --- | ---: | ---: | ---: | ---: |
| Implementation health, 20 HTTP Lambdas | 100.05 ms | 3.82 ms | 96.2% lower | 3 |
| Implementation health, 100 HTTP Lambdas | 14,620.57 ms | 15.33 ms | 99.9% lower | 3 |
| Artifact checks, 100 HTTP Lambdas | 163.63 ms | 4.06 ms | 97.5% lower | 5 after one warmup |
| Artifact checks, 500 HTTP Lambdas | 8,927.12 ms | 41.93 ms | 99.5% lower | 5 after one warmup |
| Full generator, 500 additional HTTP Lambdas | 26,570.49 ms | 1,389.70 ms | 94.8% lower | 3 |
| Ordinary `framework:generate` CLI | 858.11 ms | 895.95 ms | 4.4% higher | 5 |
| Ordinary `framework:check` CLI | 1,490.23 ms | 1,472.49 ms | 1.2% lower | 3 |
| Model projection, 100 HTTP Lambdas | 1,171.11 ms | 19.08 ms | 98.4% lower | 1 before / 3 after |
| Model projection, 500 HTTP Lambdas | 73,972.76 ms | 204.56 ms | 99.7% lower | 1 before / 3 after |

The ordinary application's fresh-process generator did not show a meaningful
gain: before/after ranges overlap (826.82–1,024.53 ms versus 864.23–1,033.88 ms).
The table preserves its measured median increase rather than claiming every
operation improved. The measured large-application improvement comes from
removing repeated work. The full 500-additional-handler generator's median user
CPU time fell from 27.77 s to 1.83 s. In-memory implementation-health checks now
read the HTTP list three times per operation at all three tested sizes, versus
461 reads at 20 targets and 10,301 at 100. The 200-target after-only median is
28.83 ms (three samples); it has no valid before comparison.

Evidence: `health-{baseline,after}.json`, `artifact-{baseline,after}.json`,
`fixture-generator-{baseline,after}.json`, `baseline-clean.jsonl`, `after.jsonl`.
Each measurement remained serial within the coordinated campaign windows.

The model rows are a second measured repair: after the first generation/health
pass, projection still took 74 seconds at 500 targets, exceeding the evaluator's
60-second limit. That intermediate source is archived in
`projection-baseline-source/`, with samples in `project-before-model-fix.json`;
it is not claimed as a measurement of the original HEAD. Existing lane and
deployment predicates normalized the whole application repeatedly for every
target, and the existing Lambda cache still did one full normalization on each
target's first lookup. `createTargetAvailability` now shares exactly the same
canonical predicates within each operation; standalone predicates still read
current config. Cloud selection and cloud-edge checks use one fresh map per
call. Each synchronous projection temporarily installs a fresh batch of Lambda
settings, restoring/deleting its scope in `finally`. No new persistent cache
crosses requests. Direct declaration lookups remain proportional to the number
of displayed fields; complete HTTP discovery is constant across fixture sizes.
Final model samples: `project-final.json`.

Focused source/artifact/Cognito/agent/Studio health checks: **9 passed**.
Framework source/tooling TypeScript checks and Studio client/server TypeScript
checks: **passed**. The initial tooling check found an implicit array type in
the new benchmark harness; that annotation was fixed and the complete framework
check reran successfully. Independent replay of pool/cold-executor/image/Studio
server lifecycle checks: **24 passed**, including actual worker PID absence and
owned server shutdown; those checks are not Docker-container runtime evidence.
Logs: `focused-source.log`, `framework-typecheck-after.log`,
`studio-typecheck-after.log`, `independent-runtime.log`.

After the projection repair, **31 focused tests passed**, both workspace
typecheck commands passed again, and independent QA's role/deploy/WebSocket/tool
union matrix passed. Complete model JSON for dev/prod × WebSocket off/on remained
**byte-identical: 697,879 bytes**, including fields, graph edges, lane facts and
status. `projection-golden-comparison.json` records this comparison. Structural
tests count whole-list enumeration rather than asserting wall-clock thresholds,
and challenge fresh subsequent projections, in-place mutations, unknown targets
and failure cleanup. One initial test incorrectly expected HTTP graphs to have
no routing edges; that fixture expectation was corrected before the passing run.
The committed projection harness also passed a 10-target smoke run; knowledge
validation and owned-file whitespace checks passed after the final documentation
updates (`projection-harness-smoke.json`, `knowledge-check.log`).

Both after synths passed with normal bundling. `synth-identity-comparison.json`
compares **all resource logical IDs/types/properties, outputs/export names,
template metadata and stack environments**; equality passed after replacing only
exact asset IDs listed in their file/Docker asset manifests. Dev: **5 stacks,
66 resources, 38 outputs**; prod: **11 stacks, 253 resources, 78 outputs**.
After entrypoint latency was 3.61 s / 9.57 s respectively (one sample each);
after the additional canonical projection repair, both normal-bundled synths
passed again at 3.15 s / 8.22 s and full semantic equality passed again in
`synth-identity-projection-final.json`. There is no synth speedup claim.
Generated bytes **and timestamps** remained identical for all 12 generator-owned
files in both the ordinary application and the 500-additional-handler fixture
(`generated-comparison.json`); no generated file was hand-edited.
The integrated final gate owns `npm run verify`,
browser and actual database checks separately.

## Creation subprocess lifetime repair

A final lifecycle review reproduced an orphan outside the ordinary generation
benchmarks. Killing the owner of a real preview generator blocked while loading
a fixture config left generator PID 62736 alive (owner PID 62734). The former
90-second timeout also rejected immediately after signaling only its direct
child, allowing preview cleanup before command termination.

Creation now uses the existing fixed-argv process starter and owner tether. Its
timeout stops the owned process tree and settles only after child `close`, so
preview cleanup follows termination and released output pipes. Command argv,
cwd, environment, stdout tail and failure diagnostics retain their behavior.
The timeout is still 90 seconds; its internal helper accepts a shorter timeout
only for focused lifecycle tests.

The shared tether had a second confirmed gap: its direct-child exit handler
exited before the escalation timer could kill a stubborn grandchild. Before the
repair, owner 66390, direct child 66394 and tether 66392 exited, but grandchild
66395 remained alive. The exact recorded orphan was removed. The exit handler
now signals only the direct child's detached POSIX process group before
preserving the child's existing exit status. It never scans processes or
signals an ancestor or unrelated group. The replay's owner 75376, child 75379,
tether 75378 and grandchild 75381 were all absent 600 ms after owner death.
Successful commands also release their owned background descendants.

Five dedicated creation lifecycle tests and the four existing command tests
passed together. They cover literal argv/cwd/environment, stdout truncation,
nonzero stderr, a timeout with a SIGTERM-ignoring process tree, actual blocked
preview generation after owner death, successful completion with a background
child, and owner death after the direct child exits before its stubborn child.
Exact owned PIDs are observed; unrelated sentinels remain alive. Studio server
TypeScript checking passed. The initial sandbox replay failed because the tsx
CLI could not open its temporary Unix IPC socket; the authorized native replay
passed all nine tests. Evidence: `creation-generation-lifecycle-final.log`,
`creation-generation-types.log` and `lifetime/*.json`. These are local macOS
process tests; Windows process-tree behavior was not exercised.

The added Node tether has a measured startup cost. A coordinated quiet-window
sample alternated direct and supervised no-op Node commands, discarded three
warmups per case and retained fifteen samples each. Direct median: **47.07 ms**;
supervised median: **96.60 ms**, a **49.52 ms** difference. Every command returned
identical stdout. This isolates extra process startup; it is not full generator
or source-review latency. The integrated source-review benchmark is remeasured
after this final source freeze. The generation table above records the earlier
CLI measurements, which do not use Studio's wrapper. Evidence:
`creation-wrapper-overhead.{ts,json,log}`. Independent QA replayed the four
command tests successfully against the final tether.

A later integrated sample crossed host idle-sleep intervals and reached the
90-second command deadline; the integrated report retains and classifies that
failed run. No further production change was made in response. Twenty
instrumented actual preview generations and a complete one-sample source
review/Apply/Undo replay then passed under the default sandbox. Wrapper/direct
child exits and owned-group cleanup completed normally, including scoped-grant
review. These instrumented runs are diagnostics, not replacements for the final
coordinated benchmark (`lifetime/normal-sandbox*`, `lifetime/source-sandbox*`).

## Reproduction and remaining limits

The committed focused harness has no AWS/database effects:

```sh
node --import tsx packages/framework/scripts/benchmark-artifacts.ts
node --import tsx packages/framework/scripts/benchmark-artifacts.ts --standalone --sizes=20,100,500 --samples=5
node --import tsx framework-studio/scripts/benchmark-projection.ts --sizes=100,500 --samples=3
node --import tsx --test packages/framework/test/source-artifacts.test.ts
```

`--standalone` intentionally repeats fresh public resolution per target and can
take tens of seconds at 500 targets. It is a comparison mode, not an application
setting. Structural unit assertions require bounded config reads, fresh settings
after in-place mutation and unchanged deploy/warning behavior; timing assertions
are excluded from ordinary tests.

The full ignored fixture scripts are `generation-fixture.mjs`,
`generator-fixture-benchmark.mjs` and `health-benchmark.ts`. The generation fixture
copies source/manifests without authored environment files or dependencies, adds
500 real handler directories and literal declarations, and runs the actual
generator with `--repository-root`. Run a before checkout and an after checkout
under the same quiet-window conditions; preserve their generated bytes for
comparison. The baseline source archive is in `baseline-source/`.

Agent directory resolution, large route overlap checks and other normalization consumers remain
scaling limits to investigate separately. These measurements establish bounded
local scenarios, not unbounded-application scalability or long-session heap
stability.
