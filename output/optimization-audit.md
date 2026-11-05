# Monorepo optimization audit — November 5, 2026

Both audit passes and six implementation commits are complete. **The requested Done
gate is not met:** `npm run verify` already failed before edits and still fails on
four `LayoutQuality.crowding` TypeScript errors. Those defects, failing assertions
and golden screenshots were left unchanged. Complete workspace tests finished with
2,421 passes, 14 Studio failures and four skips. Failure attribution and final
quiet-window measurements are recorded below.

Branch: `chore/monorepo-optimization-20261105`. Initial revision:
`047de449` (full hash in `optimization/initial-head.txt`). All 35 workspaces plus root
scripts, declarations, non-workspace workloads, Docker and current documentation
received two passes. Forty pre-existing modified/untracked Studio files were
fingerprinted, excluded from edits/staging and checked unchanged through the final
optimization source checks. The optimization comparison ends at `37510c1`.

During final test execution, another task committed the original pending changes as
`510fb39`, added `42e5ebc`, and implemented Sightline in `c996709`. Those commits and edits
are outside this audit's change set. Shared history was preserved. Remaining checks
use an immutable copy of `37510c1` with the exact 40 original files overlaid; concurrent
Sightline changes are excluded from the before/after measurements and conclusions.

## Ranked audit and disposition

The initial ranking was written before implementation and is preserved in this
file's first commit (`db5fc10`). Its final disposition is:

| Rank | Candidate / impact | Risk and disposition |
| --- | --- | --- |
| 1 | Unrouted Board and exclusive UI: less source and test burden | Low after source/test/docs/convention tracing; removed dead UI and its exclusive cases. |
| 2 | Unused direct dependencies: less declared/install output | Medium ownership risk; removed only proven unused declarations, retaining native records and pins. |
| 3 | Small client/tester/private helper deletions | Low where unreferenced; removed proven dead code, retained public Button options and SSO facade. |
| 4 | Repeated framework/Studio work | High for scheduling/freshness changes; accepted only fresh per-render indexes with equal result arrays. Deferred caches and broad subscriptions/render changes. |
| 5 | Build/test/Docker duplication | Medium runtime risk; removed bundled service's unused runtime dependency tree after image/request/log equivalence checks. Retained script order and generation ownership. |

## Changes by commit

| Commit | Change and equivalence evidence |
| --- | --- |
| `db5fc10` | Removed unrouted Board/layout, exclusive helpers/gallery cases and unused deployment Rail; preserved `RailRow`, shared UI, historical evidence and goldens. Updated editable current docs. Five exclusive test cases removed with their dead UI; surviving tests unchanged. 35 source/doc/test files, 1,006 net lines removed. |
| `d096aff` | Removed unreachable client PageError/schema/error predicate, tester ThemeToggle, unused private framework/CDK/GraphQL helpers/types and unused imports. Replaced discarded parse-json error enhancement with native JSON.parse; 45-case acceptance check matched. Import-only changes emit identical JS. Client assets remain byte-identical. |
| `f3c4af6` | Removed 46 unused dependency declarations across 19 manifests; npm 11 offline lock-only update pruned 27 records, with no additions/version changes and all native entries intact. Retained actual SDK owners and the root/CDK esbuild pins. |
| `e3ae88f` | Reused a fresh pair of model indexes within one Connections render. No cross-render cache, invalidation change, ordering change or new dependency. Default helper caller stays unchanged; three additional tests verify mode/ownership/missing/duplicate-ID results and freshness. Paired measurements below show the actual implementation. |
| `03683d2` | Removed full monorepo node_modules from the already-bundled example-service runtime image. Same bundle, map, package metadata, image command and Node24 behavior; image 88.01% smaller. |
| `37510c1` | Second pass removed newly dead resourceBadge, three private test-only helpers and only their exclusive assertions, one unused CDK import, two tester Testing Library declarations and root deepmerge-ts declaration. Retained its override pin. All mixed tests keep their other assertions. |

Revert note: the later dependency/second-pass cleanup follows earlier deletions.
Restoring the tester parser requires its `parse-json` declaration too; restoring Board
requires its subsequently removed `resourceBadge` helper. Reverse those related
cleanups together or in reverse order. Shared commits added during this work prevented
safe history rewriting to fold these dependencies into the earlier commits.

No routes, API/GraphQL contracts, auth checks, validation, retries, timeouts, defaults,
UI copy, animations or runtime log messages were intentionally changed. No public
framework vocabulary was removed: all 68 framework source export surfaces match.
No new dependency, dependency upgrade, cross-request cache or sequential-to-concurrent
runtime rewrite was introduced. No AWS action, database apply/migration, publication,
push/merge, dev-stack restart or action against port 4590 was performed.

## Before and after

Bytes are decimal, measured from fresh production output; gzip is per-file level-9
compression with deterministic timestamps, summed across all JavaScript chunks. This
is total emitted JavaScript, not initial-route transfer size. Source lines are physical
tracked authored TS/TSX/JS/JSX/CJS/MJS/CSS/Prisma/GraphQL/Python lines, including tests,
excluding generated directories/route trees. Original untracked user files are excluded
from both line counts and independently protected. Dependency counts include runtime
and development declarations, including workspace edges; optional native declarations
are retained and checked separately. Nested workspaces are counted only once.

| Measurement | Before | After | Result |
| --- | ---: | ---: | --- |
| Client JavaScript | 626,725 B | 626,725 B | Entire build byte-identical |
| Client JavaScript gzip | 198,548 B | 198,548 B | Unchanged |
| Client CSS | 34,479 B | 34,479 B | Unchanged |
| Studio JavaScript | 2,114,451 B | 2,114,019 B | 432 B less |
| Studio JavaScript gzip | 647,815 B | 647,723 B | 92 B less |
| Studio CSS | 113,410 B | 110,927 B | 2,483 B less |
| Tester JavaScript | 437,746 B | 423,286 B | 14,460 B less |
| Tester JavaScript gzip | 140,183 B | 132,113 B | 8,070 B less |
| Tester CSS | 16,671 B | 13,767 B | 2,904 B less |
| Direct dependency declarations | 321 | 272 | 49 removed |
| Lockfile package records | 1,331 | 1,303 | 28 removed; no additions/upgrades |
| Authored code lines, including tests | 190,600 | 189,389 | 1,211 fewer |
| Service linux/arm64 image | 2,112,652,032 B | 253,205,476 B | 1,859,446,556 B / 88.01% less |
| Inspector availability, current 45 rows | 2.644 ms | 0.156 ms | Paired warm median, computation only |
| Inspector availability, synthetic 332 rows  / 500 entities | 113.265 ms | 1.731 ms | Paired warm median, computation only |
| Studio startup | 4.798 s | 4.677 s | Single processes; final temporary port; no speed claim |
| Snapshot first refresh | 3,598 ms | 3,815 ms | Final isolated copy; no speed claim |
| Snapshot subsequent refresh median, 3 samples | 546 ms | 971 ms | Final isolated copy; no speed claim |
| Client / Studio / tester build | 1.210 / 1.161 / 0.825 s | 2.028 / 0.895 / 1.235 s | Single runs under differing load; no speed claim |
| Local / prod synth | 3.830 / 9.874 s | 5.284 / 9.552 s | Single runs under differing load; no speed claim |
| Required verify gate | Fails, 58.31 s | Same failure, 83.82 s | Final frozen copy; not a passing gate |

The availability benchmark alternates seven samples of the original two-argument
computation path and the supplied-index path in one quiet Node process, with index
construction included. Complete result arrays match in every sample. The pre-edit
measurement was 3.130 ms for 45 rows; the paired final control remeasured 2.644 ms.
These are not React, DOM, page-load or FPS measurements. No other runtime speedup is
claimed. Docker build times were not compared: the baseline was cold and the later
build reused layers. Installed node_modules was not replaced beneath running services.

Startup and snapshot samples are observations, not controlled speed comparisons.
The original checkout's final source gate took 67.22 s; the additional frozen-copy
gate took 83.82 s. A later original-tree snapshot run with matching isolated module
layout measured 3,250 ms first refresh and 823 ms warm median, versus the final
copy's 3,815 / 971 ms. Neither reproduced the initial checkout's 546 ms warm median.
Directory/module layout, cache history and concurrent work differ; no causal gain
or regression is inferred. Every sample produced both models with status `ok`, 27
targets each and zero diagnostics. These changes do not rewrite snapshot processing.

The original owned Studio on 4591 was stopped after browser checks. Another task
then acquired 4591, so the attempted final restart was abandoned on EADDRINUSE.
Startup alone was measured on temporary port 58994, without opening a browser there,
and that owned process was immediately stopped. All Studio browser checks used 4591.

## Every workspace: two audit passes

The first and second receipts cover entrypoints, imports/exports, package/HTML/CLI/
spawn/Docker conventions, dynamic/string references, tests, configuration and docs.
All apparent zero-import files were checked against these other roots before removal.
Source index/projection, canvas/layout, React context/subscriptions, auth/session,
repositories/queries, workload/runtime, generated contracts, Docker/watch and build/test
paths were reviewed. No remaining safe, unblocked deletion was established in the
second pass. Protected/uncertain candidates are listed below.

| Workspace (root shown separately) | Code lines before → after | Direct declarations before → after |
| --- | ---: | ---: |
| `.` | 7,498 → 7,496 | 10 → 9 |
| `agents/example-agent` | 568 → 568 | 5 → 5 |
| `cdk-app` | 18,056 → 18,033 | 12 → 11 |
| `cdk-app/ecs_containers/services/example-service` | 119 → 119 | 8 → 8 |
| `cdk-app/ecs_containers/tasks/invocation-test-task` | 26 → 26 | 4 → 4 |
| `cdk-app/lambda_functions/event_functions/cognito-custom-message` | 51 → 51 | 5 → 3 |
| `cdk-app/lambda_functions/event_functions/cognito-post-confirmation-trigger` | 32 → 32 | 7 → 5 |
| `cdk-app/lambda_functions/event_functions/cognito-pre-signup-trigger` | 188 → 188 | 6 → 4 |
| `cdk-app/lambda_functions/event_functions/cognito-pre-token-generation` | 42 → 42 | 5 → 3 |
| `cdk-app/lambda_functions/event_functions/invocation-test-step` | 21 → 21 | 3 → 3 |
| `cdk-app/lambda_functions/http_functions/graphql-api` | 1,193 → 1,181 | 13 → 9 |
| `cdk-app/lambda_functions/http_functions/mfa` | 192 → 192 | 6 → 6 |
| `cdk-app/lambda_functions/http_functions/oauth-callback` | 177 → 177 | 8 → 5 |
| `cdk-app/lambda_functions/http_functions/refresh` | 111 → 111 | 5 → 5 |
| `cdk-app/lambda_functions/http_functions/sign-in` | 258 → 258 | 8 → 6 |
| `cdk-app/lambda_functions/http_functions/sign-out` | 53 → 53 | 7 → 5 |
| `cdk-app/lambda_functions/http_functions/test-run-task` | 78 → 78 | 4 → 4 |
| `cdk-app/lambda_functions/http_functions/test-start-workflow` | 78 → 78 | 4 → 4 |
| `cdk-app/lambda_functions/http_functions/verify-session` | 7 → 7 | 6 → 4 |
| `cdk-app/lambda_functions/tool_functions/add-numbers` | 19 → 19 | 2 → 2 |
| `cdk-app/lambda_functions/tool_functions/multiply-numbers` | 19 → 19 | 2 → 2 |
| `cdk-app/lambda_functions/websocket_functions/ws-authorizer` | 91 → 91 | 6 → 4 |
| `cdk-app/lambda_functions/websocket_functions/ws-connect-route` | 28 → 28 | 5 → 3 |
| `cdk-app/lambda_functions/websocket_functions/ws-custom-action-route` | 29 → 29 | 6 → 3 |
| `cdk-app/lambda_functions/websocket_functions/ws-default-route` | 27 → 27 | 6 → 3 |
| `cdk-app/lambda_functions/websocket_functions/ws-disconnect-route` | 20 → 20 | 6 → 3 |
| `client-app` | 6,438 → 6,324 | 27 → 25 |
| `framework-studio` | 106,795 → 105,832 | 37 → 37 |
| `local-api-dev-server` | 1,699 → 1,699 | 13 → 10 |
| `local-invocation-runner` | 3,850 → 3,850 | 6 → 6 |
| `local-ws-dev-server` | 428 → 428 | 10 → 8 |
| `packages/api-contract` | 66 → 66 | 3 → 3 |
| `packages/database` | 4,937 → 4,937 | 10 → 10 |
| `packages/framework` | 36,323 → 36,308 | 27 → 27 |
| `packages/models` | 328 → 328 | 6 → 6 |
| `ws-tester` | 755 → 673 | 23 → 17 |

Non-workspace areas also covered: `framework-config` declarations/shared values,
Python Lambda, `db-migrate` Docker/CLI/migration inputs, root scripts/Compose/Docker
contexts, current source-linked docs and retained historical evidence. Framework
public config/runtime/local exports, convention-discovered workers and generated
namespaces remain intact even when this application does not consume them.

Detailed coverage: [application first pass](optimization/application-first-pass.md),
[application second pass](optimization/application-second-pass.md),
[framework first pass](optimization/framework-first-pass.md),
[framework second pass](optimization/framework-second-pass.md),
[Studio first pass](optimization/studio-first-pass.md),
[Studio second pass](optimization/studio-second-pass.md).
These supporting receipts are retained locally, not committed as source artifacts.

## Verification and limits

| Category | Actual evidence |
| --- | --- |
| Required `npm run verify` | Run before edits and after every coherent source batch, plus final. Baseline/working-tree runs and the corrected frozen-copy run reach Studio typechecking and fail on the same four TS2339 errors at island-composition.test.ts:66–67. Framework generation/check, database regeneration, GraphQL drift check and preceding workspace typechecks pass. The first sandbox-only attempt failed earlier on tsx IPC EPERM; native reruns are the real gate receipts. |
| Generated artifacts | All 19 baseline file SHA256 values remain exact, including ignored database artifacts, framework/API/GraphQL projections, Compose services and route tree. Generators were used; no generated files were hand-edited. |
| Unit/schema | Full `npm test`: 2,421 pass / 14 fail / 4 skip, 904.98 s. Client 67, local API 16, runner 27, CDK 329 (1 skip), database 28, framework 529, tester 4 and Studio 1,421 (14 fail, 3 skip). Separate GraphQL executable schema 22/22, new availability 3/3 and second-pass helper suites 23/23 pass. |
| Focused Studio | 201/205 pass. Four unchanged failures reproduced against the exact initial revision plus all 40 pre-existing files; no assertions altered to pass. |
| Full-suite failure attribution | All 14 Studio failures reproduce on the initial tree, with matching error details and assertion values. Twelve reproduce in filtered runs; the remaining two require the original full isometric test-file order and matching ignored environment inputs. The five failing test files are byte-identical at both boundaries. Private comparison inputs were copied with mode 0600, never printed, and removed afterward. |
| Synth | Real CDK app entrypoint, normal asset bundling, synthetic mode-specific inputs, account/region fixed, credentials/config isolated. Development 5 stacks and production 11 pass. Development templates exact; production differences confined to Docker image asset digests. Logical IDs, stack names/scopes, identities, networks, outputs, properties, IAM and dependencies match. No CLI lookups, AWS deployment or database activity. |
| Production builds | Client, Studio and standalone tester pass. Existing large-chunk/native-config-loader warnings retained. Client complete asset hashes exact. |
| Browser suite | Sandboxed Chromium light, 233 current cases: 218 pass / 15 fail. Exact original tree: 235 cases, 219 pass / 16 fail. The difference is the two removed Board-only cases (one pass, one historical golden mismatch). All 15 current failures reproduce with identical error details and mismatch counts. Eleven of 12 corresponding actual PNGs are byte-identical; Domains differs by 27 pixels at border edges, maximum channel delta 2/255, with the same 4,176-pixel mismatch against its unchanged golden. Goldens were never updated. Dark/Firefox/WebKit matrices not run. |
| Manual browser | Playwright MCP on owned Studio 4591: main destinations, map empty search, Add menu/Escape/focus restoration, 45-row inspector in both modes, 390px layout with no document overflow. Empty-profile deployment state observed without AWS reads. Client production preview 3091: login keyboard behavior and signed-in main panels at desktop / 390px using browser-only synthetic API responses; no live auth/DB. Tester 3092 plus local echo 3093: invalid/valid JSON send state, successful echoed response and disconnect; mobile capture. |
| Chrome DevTools | Separate isolated Chrome session reproduced Studio 45-row inspector. Clean navigation has no errors/warnings and no document overflow. During edits the long-lived development tab showed HMR context errors; clean reload clears them. No production failure or performance claim inferred from that transient state. |
| Docker | Same Node24.22.2/linux-arm64 base for both images; bundled JS/map/package hashes and image command/config equal. 60 request/auth/error cases and stdout/stderr match byte-for-byte with network disabled/read-only roots. Actual npm start startup logs, health 200 and unauthenticated hello 401 also match. Disposable test containers removed. Both exact comparison image tags were label/ID/in-use checked and removed unforced with `--no-prune`; no unrelated image, parent image or build cache cleanup. |
| Knowledge and whitespace | Knowledge checker passes: 36 pages, 841 links, 307 source references. Whitespace check passes. |
| Cleanup | Owned Studio/client/tester/echo processes and browser pages closed. The final startup-only process is stopped. Both comparison images and all temporary private input copies removed; original private input hashes remain exact. The later owner of 4591 and the user's original dev stack/4590 were left running. |
| Protected material | Optimization commits touch none of the 40 original user paths or 36 golden PNGs. All 128 native lock entries and 68 framework export surfaces match. Original file hashes stayed exact through final source checks; later owner edits are outside this pass. Historical docs/artwork, original env files, cache/state, postgres_data and identity vocabulary untouched. |
| Not verified / excluded | Live database behavior, real auth/AWS operations, deployed behavior, cross-platform Docker runtime and every browser/device. Docker fixtures prove the present service bundle and tested inputs, not arbitrary future view engines/plugins. |

Raw logs, hashes, scripts, isolated-tree provenance and comparisons are under
`output/optimization/`. Browser evidence is under
`output/playwright/monorepo-optimization/`. The initial synth harness accidentally
staged its output inside its own Docker source context; that failed attempt was
retained as a log, its owned generated tree removed, and all valid synths used /tmp.
No application workaround was added for that harness error.

The first frozen-copy verification reused a root node_modules symlink, which omitted
nested workspace modules and resolved framework types from two checkout paths. It
therefore produced harness-only missing-module/nominal-type errors. The isolated
module layout was corrected to point workspace packages into the frozen copy while
reusing external installed packages. The corrected run reports only the four baseline
errors; both attempts are retained. No application source or shared dependency tree
was changed to accommodate the copy.

## Bugs found but intentionally not fixed

- **Baseline typecheck/layout mismatch:** `LayoutQuality` lacks `crowding`, while
  `island-composition.test.ts:66–67` reads it four times. Its unchanged runtime suite
  also fails 4/5 cases concerning spacing/shape. No layout behavior or test fixed.
- **Baseline Studio unit failures:** alongside the four layout failures, required-input
  readiness returns null; header rename cannot find `Value in development`; input-group
  hover counts expect four development inputs instead of three; new WebSocket copy
  expects the guarded handshake to be Off; renderer assertions fail for red-X markers,
  resting connection strength, the unbuilt-VPC rim and per-connection opacity/thickness;
  two landscape opacity assertions expect 0.075 while current code returns 0.045.
  All 14 failures reproduce on the original tree with matching test order/local inputs.
- **Baseline browser failures:** two document-style selectors, an assertion forbidding
  deployment reads now made by the existing global observer, and 12 golden comparisons.
  All reproduce on original source, with existing user edits included.
- **Tester accessibility:** Send is an `i` with an onClick handler and no keyboard
  control semantics. Existing behavior retained. Source review also observes an
  uncaught parse of non-JSON inbound messages and broader URL validation than the
  WebSocket constructor; these two cases were not runtime-reproduced.
- **Runner source-only concern:** invalid container-Lambda timeout can throw after
  controller registration but before the cleanup block. Not fixed or runtime-tested.
- **Tooling/docs observations:** legacy modifying ESLint commands lack a declared
  ESLint setup; sign-in workspace name is `sgn-in`; AgentCore docs include older
  provider-variable wording. These are retained contracts/issues, not silently fixed.

## Needs human decision

| Skipped removal/optimization | Evidence and reason |
| --- | --- |
| Pending Studio source/docs/tests | 40 initially modified/untracked files belong to another task. FrontendRelease and ServiceLogs still have tests in protected deploy-ui.test.ts; LifecycleDisclosure is itself protected. Do not delete or rewrite that work. `useDeployLive` and deployment query helpers are actually live through the original untracked observations.tsx and were correctly retained on second pass. |
| Four stale Board references | Protected main.tsx comment, framework-studio/README.md and knowledge interface.md/snapshots.md still describe retained Board. Editable current docs were corrected; those four files need their owner's follow-up. |
| Public framework/CDK/data vocabulary | Framework exports, native task/workflow handles, legacy secret-binding readers, API route types, database repository contract and documented timestamp adapter have external/convention consumers. Current app non-use does not prove death. |
| Client Button options and enterprise SSO facade | Existing accepted inputs/public facade; narrowing them is a contract decision. No active caller is not sufficient under this task's equivalence requirement. |
| Persisted/external compatibility | Replay envelopes, CLI/output aliases, old selection URLs, retained-resource/job formats and source naming compatibility remain supported inputs. Existing tests/persisted records require them. |
| Cross-request caches, workers, lazy imports | Snapshot/type evaluation freshness, source hashes/revalidation, SDK/provider import effects, canvas pixels and loading/cancellation would need different contracts. Existing renderer caches retained; no speculative extra cache or scheduling rewrite. |
| Repeated normalization/repository reads | Public deployment predicate callbacks may mutate config; source/deployment integrity checks deliberately reread bytes. No equivalent invalidation/order proof. Database full records are public results; narrowing them changes output. |
| Duplicate typecheck scripts | Nested Lambda tsconfigs/options differ and npm scripts are externally callable with observable output/order. Do not remove checks or change concurrency merely for a faster gate. |
| Docker install/cache/OpenSSL changes | Root postinstall owns generated database artifacts. Manifest-first layer restructuring and removing native system packages require separate build/runtime proofs; image size gain here needed neither. Small nested dockerignore files are convention inputs, not safely dead by grep. |
| Fonts, CSS tokens, icon/public assets | Dynamic icon/catalog paths, CSS inheritance/vendor viewer styling, manifest/public URL access and retained artwork prevent deletion without narrower proof. Historical docs/evidence and all golden images explicitly retained. |
| Remaining tooling pins | api-contract tsx documents test-loader support. Hono server pins still back Prisma transitive dependencies. Their declaration placement can be reconsidered separately; no upgrades/unpinning here. |

The no-bug-fix/no-test-weakening constraints prevent making the already-failing gate
green in this pass. Completion of that part of Done requires a separately scoped fix
for baseline defects; no passing result is implied by the successful equivalence checks.
