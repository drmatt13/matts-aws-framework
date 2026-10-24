# Job 4 independent developer acceptance — 2026-10-23

This acceptance pass approaches the documented framework and Studio workflows from
a fresh, isolated checkout. Historical Job 3 evidence informed the scenarios but
is not counted as current proof. No AWS writes, deployment, publication or shared
database mutations are authorized by or performed for this pass.

## Clean installation

The fixture is `.framework/job4/acceptance/gui first`, intentionally a path with
spaces. It starts from `git archive HEAD` at the revision in
`evidence/revision.txt`, with the campaign's frozen source patch overlaid; the
explicit file list is `evidence/overlay-files.json`. Only tracked environment
examples/templates are copied. No private environment, account directories, CDK
outputs, installed dependencies or original developer build artifacts are used.

Node 26.0.0 and npm 11.19.0 satisfy Node >=24 and the declared npm package manager.
The first pinned `npm ci` with a fresh task-specific empty cache failed in 0.79 s
because the restricted sandbox could not resolve `registry.npmjs.org`. The same
installation with approved network access succeeded in **55.31 s**, including the
normal Prisma postinstall. It neither reused the original `node_modules` nor a
warm npm package cache. The resulting dependency directory is an actual directory,
workspace symlinks resolve into this fixture, and `package-lock.json` remains
byte-identical. No dependency or manifest changes were made.

The initial README and Development setup sentence named only npm, although Studio
creation and lockfile preservation require npm 11. Both now state npm 11 explicitly;
the package-manager pin and existing dependency installation policy remain unchanged.

Raw evidence lives under `.framework/job4/acceptance/evidence/`:
`install-restricted-network.json`, `install-cold.{json,log}` and
`install-integrity.json`. This is one workstation observation, not a timing
benchmark or Windows installation claim.

## Acceptance outcomes

Actual Playwright MCP interaction used a fresh browser at
`http://127.0.0.1:4598/isometric`, with 1440×1000 desktop and 420×900 narrow
viewports. The isolated server receives an empty AWS credential file and synthetic
`job4-offline` configuration; inherited AWS/CDK/framework environment values are
removed. It reached HTTP 200 in 8.70 s in this one fresh Vite observation. The
sandbox initially refused loopback binding (`EPERM`); the same task-specific
server started with approved local network access. This is an execution boundary,
not a framework onboarding failure.

| Journey | Actual result | Evidence |
| --- | --- | --- |
| First load without credentials or authored env | Both source graphs valid; 61 resources / 59 relationships. Source discovery did not require AWS. | Initial Playwright snapshot; `gui-startup-initial.json`, `gui-studio.log` |
| Keyboard creation chooser | Add → Tab → Home → Enter opened Function. The chooser initially focuses Close, so Home alone does not select a resource. | Actual MCP key actions |
| HTTP creation and review | Created `job4-http`, HTTP GET `/job4-http`, authenticated, 128 MiB / 10 s. Review displayed handler, literal declarations and generated artifacts. Apply selected the new canonical resource. | `http-review.yml`; fixture handler uses `authenticated` and declaration has `auth: true`, `userPool: true` |
| Undo / Redo | Undo physically removed the new HTTP handler; Redo restored it. | Shell existence checks after actual GUI history actions; source journal |
| Event creation | Created and applied conventional `job4-event` source/handler. | Fixture `workloads/events.ts`, event handler |
| S3 creation | Created and applied `Job4StorageStack`, exposing `job4Storage.bucket`; private, encrypted, SSL-only and retained. | Fixture application stack, catalog descriptor and entry-point registration |
| Scoped relationship | HTTP Inspector → Connect workload → Grant bucket access → new bucket → `allowed/*` → review → Apply authored `grantRead("allowed/*")`. | Fixture `workloads/http.ts` |
| Stale review and recovery | Reviewed memory 128→192, appended an external source comment, and observed disabled Apply with the draft preserved. Escape returned to editing; Review against latest source → Apply succeeded and preserved the comment. | `stale-review.yml`, `stale-mobile.json`, `stale-mobile.png`; fixture source |
| Database source | Opened the installed Prisma workbench, reviewed and saved a comment-only schema edit. Existing User/Project models were preserved. The status view explicitly retained unknown database state and disabled inspection without a selected target. | Actual browser review/save; saved fixture `contract.prisma` |

The S3 grant observation proves reviewed source intent, not deployed IAM access.
Database saving changed only authored source; it did not generate artifacts, apply a
migration or connect to a database. No manual source repair was used to classify a
broken GUI authoring workflow as successful. Browser-driver mistakes selecting a
hidden accessibility-map entry or using fill instead of append were corrected
before saving; these are not product failures.

Compilation and historical campaign results are not used as substitutes for
actual browser interaction.

## Missing credentials: defect, repair and replay

Actual inspection of the empty, region-only `job4-offline` profile initially
reported an expired SSO session in Cognito and Deploy. The real CLI stderr was:
`NoCredentials: Unable to locate credentials`, followed by advice to run
`aws login`. `classifyAwsError` interpreted that advice before the concrete error,
so a new developer received the wrong remedy.

`scripts/aws-cli.ts` now gives explicit expiry errors their existing precedence,
then detects missing credentials, then uses a generic login hint as the expiry
fallback. Two focused regression tests passed, including the actual observed CLI
message and explicit expired-token/SSO cases. After every pending source draft
was saved, only the owned fixture Studio process was restarted. Actual Playwright
inspection then displayed **No AWS credentials were found for the selected
profile. No metadata verified.** Both source graphs remained valid. Evidence:
`missing-credentials.stderr`, `missing-credentials-cognito.yml`,
`missing-credentials-fixed.{json,yml}` and `aws-cli-tests.log`.

The GUI also applied `Job4IdentityStack` through its Cognito identity-pool wizard,
with authenticated-only, permissionless default roles and no guessed bucket ARN.
This proves valid authored source and discovery, not AWS identity exchange or
sign-in. Source review remained a separate action from deployment. This identity
wizard's Review request took approximately **34 s** while the lead's source tests
were still running; the in-flight request completed before the subsequent quiet
benchmark window. This was noticeable waiting time. It was not an isolated
before/after benchmark, and this pass does not claim that identity-pool creation
latency was optimized.

The Deploy → Client environment & frontend release controls remained disabled
while account/region observation was unavailable and explicitly requested region
resolution. This is a documented prerequisite: public client values require
completed deployment outputs. No outputs were fabricated, no client publication
was attempted, and no infrastructure plan or change set was requested. Full GUI
local Compose startup, deployment preparation, client output generation and
Cognito sign-in remain unverified without an authorized deployed development
environment. Database inspection was deliberately not pointed at the user's
existing PostgreSQL binding.

A controlled external TypeScript syntax error produced one error per source mode,
retained the last valid view, and paused editing. Restoring the exact prior bytes
recovered Source valid automatically. Evidence: `invalid-typescript.yml` and
`events-before-invalid.ts`.

## Independent code-first application

A second clean archive at `.framework/job4/acceptance/code first` received a
separate dependency tree through `npm ci --offline` using only the cache populated
by this pass's successful fresh network installation. It installed 1,062 packages
and ran the normal Prisma postinstall in 58 s. This second install uses a warm
package cache; it is not presented as another cold/network installation.

Before Studio was opened, ordinary authored source added
`framework-config/features/acceptance/index.ts`. That feature module exports
literal HTTP and event maps, composes them explicitly in the root arrays, retains
a shared `sizing` fragment and author comment, and declares the bucket permission
`grantRead("code-allowed/*")`. Conventional HTTP/event handlers and explicit native
`ReferenceExampleStack` registration complete the source. The new workloads have
no descriptions, tags, Studio inventory or hidden metadata. The script and initial
source are retained as `prepare-code.py`, `code-initial.json` and
`code-source-before.ts`.

| Check | Actual result | Evidence |
| --- | --- | --- |
| Documented generation | `npm run framework:generate` emitted target IDs and routes; `npm run framework:check` exited 0. An initial sandbox attempt failed because tsx could not bind its local IPC pipe; the same documented command with approved local IPC access passed. | `code-generate{,-sandbox}.log`, `code-check.log` |
| Local handlers | Actual HTTP and event handler invocation returned 200; the event preserved its synthetic input; repeated HTTP execution reused the warm worker. Both worker PIDs were absent after executor close. | `code-local.json` |
| Real local API | Two actual GET `/api/code-first` responses returned 200 and the same warm PID. POST returned the documented API Gateway-compatible 404 with the diagnostic naming GET. The API and worker PIDs were absent after shutdown. | `code-http.{json,log}` |
| Development synthesis | Direct real CDK entry point exited 0, four stack templates, no unresolved context; credentials absent and asset bundling deliberately skipped. | `code-synth-dev.log`, `code-synth.json` |
| Production structural synthesis | Direct entry point exited 0 and emitted ten stacks, but its manifest requested an account/region availability-zone lookup. This fresh checkout had no developer context cache. This is incomplete offline production preparation, not a successful credentialed CLI synth. Asset bundling was skipped. | `code-synth-prod.log`, `code-synth.json` |

The first local API test driver expected 405 for an undeclared method. Inspection
confirmed that this server deliberately matches API Gateway's 404 behavior; the
corrected driver replay passed without changing application/framework behavior.
These fixture checks remain separate from the lead's production-capable synth,
full repository verification and the runtime specialist's Docker/database
persistence evidence.


## Code-first discovery and exact source preservation

After the final projection implementation was frozen, its three changed source
files were overlaid into the code-first fixture. The final
`npm run framework:check` replay exited 0 (`code-check-final.log`). A new
Playwright MCP browser then opened Studio on 4599 and discovered **64 resources
and 61 relationships**, including the HTTP route, event handler and scoped bucket
relationship. Inspector source links identified the authored feature module;
implementation health identified the conventional existing handler.

A memory 128→192 edit produced a diff confined to the original feature module.
Observed keyboard focus moved Back to Editing → Tab → Discard All → Tab →
Apply All; Enter applied the reviewed change. An exact text comparison established
that **only `memorySize: 128` changed to `memorySize: 192`**. The author comment,
shared fragment/spread and scoped grant remained byte-identical. The Inspector
kept ambiguous spread-derived fields source-linked and read-only while allowing
the explicit memory property to be edited. Hash comparison
confirmed the root composition, both canonical kind modules, native CDK
entrypoint and both authored handler files remained unchanged. No Studio-specific
metadata was needed to discover, review or edit the new feature.

The first keyboard driver assumed Shift+Tab would immediately focus Apply. It did
not, and saved source correctly remained unchanged; the resulting assertion
failure was a driver failure. Observing each focus target and replaying the
normal forward Tab sequence succeeded. No authored code repair bypassed the GUI.

At 420×900, the document width was 420, the Inspector remained scrollable, memory
showed 192 and Source valid remained visible. Desktop and narrow screenshots were
visually inspected. The code-first browser had **zero console warnings/errors**.
The earlier GUI's only errors were the two deliberately induced credential
inspection 422 responses; source-authoring requests succeeded. The lead separately
owns Chrome DevTools diagnostics and the aggregate performance results.

Evidence: `code-first-review.yml`, `code-source-preserved.json`,
`code-authored-hashes-before.json`, `code-mobile-dimensions.json`,
`code-first-{desktop,mobile-applied}.png`, `code-browser-console.log` and
`browser-errors-before-restart.log`. Browser-driver diagnostic artifacts are
retained alongside the successful replay.

## Cleanup and acceptance limits

Both browser sessions are closed. Initial Studio PID 96914, restarted GUI Studio
16425, code-first Studio 31891, local API 20980 and recorded handler workers
18945, 18953 and 20988 are absent. The owned loopback ports 4598, 4599 and 4601
refuse connections. Individual Studio evaluator PIDs were not recorded before
shutdown; a fresh read-only process audit filtered to the exact acceptance fixture
path found no remaining Studio/evaluator/Lambda process. These bounded checks do
not establish Windows process-signal behavior. User Studio ports 4590/31295 were
excluded from shutdown and listener mutation.

All **64 owned Playwright MCP artifacts** were moved into the ignored
`.framework/job4/acceptance/browser/` directory with a source/destination/hash
ownership manifest. Earlier/user browser artifacts were preserved. After shutdown,
only these explicitly authorized disposable dependency/cache paths were removed:

| Owned path under `.framework/job4/acceptance/` | Allocated bytes before | After |
| --- | ---: | ---: |
| `gui first/node_modules` | 2,278,080,512 | Absent |
| `code first/node_modules` | 2,281,750,528 | Absent |
| `empty npm cache` | 301,469,696 | Absent |

Total removed: **4,861,300,736 allocated bytes**. Original repository
`node_modules` remained present with unchanged directory inode. Global npm cache,
private environment files, user storage and Docker resources were not targeted.
Both fixture source trees, lockfiles, preparation/replay scripts and raw evidence
remain. Reinstall their pinned dependencies before replaying them.

Receipts: `stopped.json`, `process-residual-audit.json`,
`dependency-cleanup.json` and `browser-artifact-ownership.json` under the evidence
directory. Scope and process limitations are explicit in those receipts.

This pass established clean installation, offline GUI source authoring/recovery,
code-first generation/local execution and exact authored-source preservation.
Unit evidence is the two passing AWS error-classification regressions; integration
evidence is the actual local API/event execution and shutdown; browser evidence is
the two fresh-fixture MCP journeys. Database evidence here is source-only, and
production synthesis retained the explicit fresh-context prerequisite. Deployed
AWS, full Compose onboarding, authentication and client export/publication were
not exercised. Paths containing spaces were exercised on macOS; Windows was not
available. The lead owns aggregate performance conclusions, full repository
verification, Docker/database persistence and the limited-beta release decision.

## Late integration failure investigation

The first integrated verification gate failed one Studio creation case after
283.47 s: catalog creation preserving authored values/automatic secret delivery
reported a 409 semantic-review mismatch. Three other concurrent TypeScript-heavy
cases took 283–307 s. That first gate remains a failed run.

A later read-only host-log correlation found **258 seconds of Idle Sleep**, from
19:33:04 to 19:37:22 EDT on October 23. The verification log places the preceding
ws-tester suite at 19:26:52, immediately before the 792.146-second Studio suite,
so the sleep occurred during Studio verification. The four observed durations
have a common suspension-sized excess:

| Case | Recorded duration | Minus the 258-second host sleep |
| --- | ---: | ---: |
| Catalog input/secret creation | 283.469 s | 25.469 s |
| Bucket/scoped grant/secret delivery | 301.447 s | 43.447 s |
| Local replay transaction | 307.343 s | 49.343 s |
| Native trigger removal | 283.376 s | 25.376 s |

This establishes host-sleep contamination of the original timing evidence and
strongly accounts for the shared stalls. The subtraction is a comparison, not a
reconstructed per-test execution interval: the parallel reporter did not record
test start/end wall timestamps. The original 409's underlying model result was
also unlogged; whether sleep caused a deadline or another model failure remains
inferred. A deterministic semantic regression or memory-pressure cause was not
established. The lead will keep the host awake for the final benchmark and gate
with a task-scoped assertion, without changing persistent power settings.

Two isolated replays of the exact failing case passed, taking 15.44 s and 15.37 s
for the test itself. The second used diagnostic-only wrappers and the exact
canonical signature function extracted from current source. Eleven both-mode
evaluations were all valid, with a maximum 484 ms; all eight Apply/Undo signature
comparisons matched. In particular, Undo matched the original snapshot taken
before the test wrote its synthetic `.env.dev`; that hypothesis did not reproduce
a mismatch. No private input text was recorded. The single test process reached
an observed 1,454 MiB RSS.

The four exact previously slow cases were then replayed together with normal
validation, fresh disposable test fixtures, per-process diagnostics and one-second
owned-process RSS sampling. A paired replay changed only test concurrency:

| One observed run each | Concurrency 4 | Concurrency 2 |
| --- | ---: | ---: |
| Passed cases | 4/4 | 4/4 |
| Elapsed | 46.24 s | 48.44 s |
| Peak aggregate owned-process RSS | 5.157 GiB | 4.908 GiB |
| Maximum evaluator duration | 1,351 ms | 608 ms |
| Canonical signature mismatches | 0 | 0 |
| Workstation swap-out delta, 16 KiB pages | 63,656 | 0 |
| Workstation compression-count delta | 3,084,529 | 180,268 |

Concurrency two took 4.8% longer in this pair and reduced observed paging. VM
counters describe the whole workstation, not test-exclusive activity; ordering,
background work and filesystem caches prevent a universal or causal claim.
Neither replay reproduced the original failure. The only rejected models were
an intentional invalid local-replay configuration that its test expected to
reject. These diagnostics reuse the repository's existing dependencies and are
separate from the fresh-install acceptance above.

Independent QA corrected a confirmed diagnostic-order problem: a failed
preflight now reports 422 before semantic comparison; valid candidate semantics
are still compared exactly and mismatches remain 409. Four focused new tests
cover creation and connection/removal guards, including zero writes/records and
unchanged fixture source. All four passed, and Studio's complete server/test
TypeScript configuration passed. This repair exposes the proper failure class;
it does not establish what caused the original gate failure. The lead selected
Studio test concurrency two without removing any tests or validation and owns
the subsequent complete gate replay.

Raw evidence under `evidence/`: `creation-filtered-pass1.log`,
`creation-filtered-diagnostic.log`, `creation-diagnostics.jsonl`,
`creation-diagnostic-summary.json`, `creation-four-case*`,
`creation-concurrency-comparison.json`, `batch-validation-precedence.log` and
`validation-precedence-types.log`, plus `first-gate-host-sleep-correlation.json`.
The root evidence includes `host-sleep-events.log` and the preserved
`verify-integration-pass1.log`. Preparation and diagnostic scripts remain in
the ignored acceptance directory. No production signature or validation check was
weakened by this investigation.
