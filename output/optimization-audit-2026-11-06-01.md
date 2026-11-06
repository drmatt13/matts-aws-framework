# Monorepo optimization audit — November 6, 2026, run 01

Status: **complete with proven pre-existing failures**. Both full audit passes are complete, every candidate and advisory has a disposition, and seven coherent implementation/documentation changes are committed. Root verification still fails on the same four baseline type diagnostics; the full workspace suites retain exactly the same 22 baseline failures. This is not a green verification. Historical reports remain unchanged.

## Ownership and environment

- Baseline: `40d3cb21828854815f2629c5c42c017e2efc0ef1`.
- Shared checkout: `/Users/matt/Desktop/code/framework-fix/matts-aws-framework`, branch `feature/studio-sightline`; clean at capture. No protected overlay is needed. No shared source edits or commits are authorized by this audit.
- Owned worktree: `/private/tmp/matts-optimization-2026-11-06`; branch `audit/optimization-2026-11-06`.
- macOS 27.2 arm64; Node `v26.13.0`, npm `11.20.0`; Docker Engine/CLI 29.8.0, Scout 1.24.0; Docker runtime Node 24.22.2 Linux arm64. Clean installations use this isolated worktree; all workspace links resolve within it.
- Raw evidence: `.framework/artifacts/optimization-2026-11-06-01/` (ignored). Browser evidence: `output/playwright/optimization-2026-11-06-01/` (ignored). Synth assemblies are outside source/build contexts at `/private/tmp/matts-optimization-synth-2026-11-06/`. The independent fixed control is `/private/tmp/matts-optimization-baseline-2026-11-06` at the baseline revision with its own clean installation.
- Root agent owns edits, Git, services and benchmarks; delegated audits are read-only.
- No AWS calls, database application, deployment, push, merge, publication, account change or existing-service restart is permitted.

## Fresh baseline

Clean `npm ci` completed in the isolated worktree (1118 installed packages); all 35 workspace symlinks resolve within it. Initial offline attempt lacked the locked SSO tarball and was retained as failed evidence; the exact-lockfile registry retry passed. All three frontend production builds passed. The initial sandboxed verify stopped at tsx IPC `listen EPERM`. The equivalent local-process-access retry reached Studio typecheck and reproduced four TS2339 `LayoutQuality.crowding` errors at `test/island-composition.test.ts:66–67` (57.27s). Separate Studio-server typecheck reproduces the same four errors. Root scripts typecheck and GraphQL schema tests pass; full workspace suites finished: Studio 1,669 tests, 1,643 pass, 22 fail, 4 skipped; all other workspace suites passed. Knowledge checker passed. A ten-minute Query GC timer surviving test teardown explains much of the Studio suite duration; this audit preserves that baseline behavior. Both normal-bundling offline synth modes passed (local 5 stacks, prod 11). Generated and bundle fingerprints are captured, as are repeated quiet-window startup/snapshot and candidate timings, browser behavior, and npm vulnerability scans. The exact baseline Docker image built and its network-disabled task invocation passed.

## Ranked candidates (before implementation)

First-pass ranking and evidence were recorded before product edits. The decision column now records each final disposition; measured results and equivalence evidence follow.

| Rank | Location / workspace | Evidence / expected benefit | Risk and verification | Decision |
| --- | --- | --- | --- | --- |
| 1 | Dependency tree: body-parser, undici, qs, seroval, Vitest, Zod | Fresh npm advisory results; compatible fixes may remove known vulnerable versions | Read upstream advisory/release notes, trace exact paths/constraints, narrow lock diff, exploit/control checks, full gates and final audits | Implemented narrow fixes in `06a250d`; four residual advisories documented below |
| 2 | `packages/framework/scripts/check-repository.ts`, CDK target registry | Per-target standalone availability predicates repeatedly normalize the same config; existing `createTargetAvailability` supplies the same predicates per operation | Preserve kind/error/order and refresh per call; structural/equivalence tests, timings, both synths | Implemented; see commit and measurement tables |
| 3 | `framework-studio/shared/permissions.ts` | Each target scans all enriched edges; one per-call target-to-edge index can preserve edge order/dedup | Deep-equal complete models incl self edges/principal endpoints, fresh-call mutation and permission-source order; benchmark real/synthetic models | Implemented; see commit and measurement tables |
| 4 | `framework-studio/src/sightline/focus.ts` | Rebuilds indexes repeatedly within one focus construction; island membership scans repeatedly | One fresh pair per build only, no cross-call cache; complete Sightline equality, mutation cases, browser focus/capture/keyboard and timings | Implemented; see commit and measurement tables |
| 5 | `ws-tester` typography plugin/declaration/scoped override | No `prose` utility consumers in tracked tester source | Exact production CSS comparison, complete consumer trace, desktop/mobile send/error/echo/disconnect behavior, clean install | Implemented in `88098a1` |
| 6 | Studio private helpers/wrappers | `tileTopPoints`, `eventTone`, `sourceWriteInProgress` have no named/dynamic consumers; deploy log-store only reexports canonical operations owner | Recheck source/test/docs/package exports/discovery, preserve all mixed tests; build/type/full gate | Implemented in `effc7d6` after consumer tracing |
| 7 | Studio database-empty wrapper and database standalone lock helper | Only reexport consumer; current initialization uses transaction advisory lock elsewhere | Read database guidance, imports, runtime order and all existing lock tests; no live DB action | Implemented in `effc7d6` |
| 8 | Framework `pathsOverlap` | Valid literal route pairs currently split both strings in quadratic pair loop | Exact collision/errors/output on literal/root/wildcard/agent paths; existing routing tests and benchmark | Implemented; see commit and measurement tables |
| 9 | Framework task/service/workflow getters | N+1 normalizations; public APIs retained even if unconsumed locally | New shared projection helpers add code; compare output/default/error/freshness and meaningful timing benefit | Retain public getters: one application workflow; added abstraction lacks measured material benefit |
| 10 | Current Board references and unused imports | Source no longer has Board; current comments/wiki claim retention | Correct only current docs; preserve historical evidence, knowledge checker | Implemented in `effc7d6` |
| 11 | Tester unused CSS theme variables | Static reference trace found no consumer | CSS custom properties can be externally observed; computed font/theme and browser comparison needed | Implemented in `88098a1`; full computed-style equivalence at both widths |

No new dependency, cross-call cache, runtime concurrency change, public API removal, golden update or test weakening was introduced.

## Two-pass coverage ledger

| Workspace | First pass | Second pass |
| --- | --- | --- |
| `agents/example-agent` (`@repo/example-agent`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app` (`cdk-app`) | Complete; area disposition below | Complete: 27 framework and 11 application infrastructure modules; accept registry batching and finalization reuse |
| `cdk-app/ecs_containers/services/example-service` (`@repo/example-service`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/ecs_containers/tasks/invocation-test-task` (`@repo/invocation-test-task`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/event_functions/cognito-custom-message` (`cognito-custom-message`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/event_functions/cognito-post-confirmation-trigger` (`cognito-post-confirmation-trigger`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/event_functions/cognito-pre-signup-trigger` (`cognito-pre-signup-trigger`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/event_functions/cognito-pre-token-generation` (`cognito-pre-token-generation`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/event_functions/invocation-test-step` (`invocation-test-step`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/graphql-api` (`graphql-api`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/mfa` (`mfa`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/oauth-callback` (`oauth-callback`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/refresh` (`refresh`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/sign-in` (`sgn-in`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/sign-out` (`sign-out`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/test-run-task` (`test-run-task`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/test-start-workflow` (`test-start-workflow`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/http_functions/verify-session` (`verify-session`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/tool_functions/add-numbers` (`add-numbers-tool`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/tool_functions/multiply-numbers` (`multiply-numbers-tool`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/websocket_functions/ws-authorizer` (`authorizer-function`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/websocket_functions/ws-connect-route` (`connect-route-function`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/websocket_functions/ws-custom-action-route` (`customAction-route-function`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/websocket_functions/ws-default-route` (`default-route-function`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `cdk-app/lambda_functions/websocket_functions/ws-disconnect-route` (`disconnect-route-function`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `client-app` (`client-app`) | Complete; area disposition below | Complete: 52 files,41 entry dependencies,10 tests and deliberate typecheck fixture; retain source and contracts |
| `framework-studio` (`framework-studio`) | Complete; area disposition below | Complete: all frontend/shared 282 files and server 164 files; accepted indexes/private deletions; retain active and documented consumers |
| `local-api-dev-server` (`local-api-dev-server`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `local-invocation-runner` (`@repo/local-invocation-runner`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `local-ws-dev-server` (`local-ws-server`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `packages/api-contract` (`@repo/api-contract`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `packages/database` (`@repo/database`) | Complete; area disposition below | Complete: canonical transaction lock and migration safeguards intact; accept private deletion; retain public methods |
| `packages/framework` (`@repo/framework`) | Complete; area disposition below | Complete: exports/config/runtime/deploy/local/protocol/scripts reviewed; accept batching, retain public APIs and replay checks |
| `packages/models` (`@repo/models`) | Complete; area disposition below | Complete: declarations, imports, tests, dependency ownership and supported entrypoints traced; retain active capability |
| `ws-tester` (`ws-tester`) | Complete; area disposition below | Complete: 8 files; accept unused plugin/theme removal; retain JSON-viewer prewarm pending UX evidence |

First-pass disposition by area (read-only static evidence; runtime checks remain separate):

- Framework public exports, DSL, deployment, runtime/local helpers, scripts and tests: retain public/compatibility capabilities; investigate only ranked repeated work. Public compatibility secret-binding parsers/readers, replay formats and CLI aliases retain supported consumers.
- CDK app/framework stacks, bin entrypoints, declarations/resources/shared/network/database: retain identities and extension capabilities. Source-only ReferenceExampleStack is documented, not dead. Availability batching was accepted with grouping/error/order tests.
- Local API/WebSocket/invocation runner: active declaration-driven routing/auth/task/workflow/callback/image lifecycle retained. Image hash/caching/concurrency changes lack equivalence evidence. Only proven unused imports were removed.
- Studio frontend/shared: active graph, scene, inspector, controls, styles, database/Cognito/deploy/identity/operations preserved; unrouted FrontendRelease is explicitly documented as retained and is not a deletion candidate. New Sightline/Coding lazy loading, disabled cache-only observations, privacy and capture budgets retained.
- Studio backend: serial snapshot/review/publication, source-watch, evaluator, native agent host, operations coordinator, profile-scoped observation caches, source/physical-state safety checks and persisted recovery formats retained. Spawned host/coordinator/naming-worker/probe files are live dynamic entrypoints.
- Client: all runtime modules reachable; `client.typecheck.ts` intentionally provides compile-only contract checks. Auth/query cancellation and workload panels retained. GraphQL is used by contract tests and typed-document peer ownership.
- WebSocket tester: all eight modules reachable. Separate Studio adaptation serves different presentation/accessibility; avoid speculative shared abstraction. Keep jsdom test environment and native bindings.
- Database/API/model packages: repositories/public methods, timestamp helper required by playbooks, generated ownership/migration snapshots/CLIs and all three model providers retained. SQL owner filtering and request-local GraphQL ID memoization already present; no N+1 change justified.
- All HTTP/event/WebSocket/tool/agent/service/task workspaces: declaration/import/test consumers traced; preserve supported examples, intentional invocation fixture delay, exact wire spelling/logs, auth and errors. Non-workspace Python handler is active and stdlib-only; db-migrate remains active offline-plan/runtime capability.
- Root scripts/Docker/Compose/generated output/current docs: explicit ownership/discovery and privacy/native bindings retained; manifest-first images and current labels retained. No blanket cleanup. Obsolete OpenSSL comments were corrected; the binary remains because removal is unproven.

Detailed raw inventory: `baseline-inventory.json`. All 35 workspace entries above have an initial disposition; the second full pass is documented below.

## Changes by commit

| Commit | Change | Equivalence / security evidence |
| --- | --- | --- |
| `8553d71` | Framework input and CDK target checks reuse per-call normalization; literal-route overlap shortcut | Exact-output comparisons,527 framework tests, registration/order/freshness tests, both synths |
| `6e4f7aa` | Studio permission edge index and per-focus Sightline indexes | Full model equality,31 focused tests,56 existing browser tests with unchanged goldens, manual desktop/mobile/keyboard |
| `effc7d6` | Remove private unused helpers, forwarding modules and imports; correct current docs | Consumer tracing,25 database/log-store tests, unchanged active transaction lock, knowledge check |
| `88098a1` | Remove tester typography dependency/override and unused template variables | Four packages removed; plugin-only assets byte-identical;116 elements' computed styles identical at 390/1280px; echo/error/disconnect flows |
| `06a250d` | Compatible security upgrades and exploit regressions |14 advisory IDs removed; compressed-body/serialization/SRI controls pass; glob mitigation remains partial; full suites retain exactly baseline failures |
| `b2d7690` | Reuse availability while publishing development resource outputs | Same target/output order;26 existing focused tests pass; both synths differ only in 2 expected task image hashes |
| `51869f0` | Correct Docker pinning and Rust-free Prisma comments | Comments only; final normal Docker build/runtime pass; required verify retains four baseline errors |

Every committed implementation ran the root verify gate and reproduced exactly the four independently captured baseline type diagnostics. No green verification is claimed.

## Measurements and methods

Baseline source is `40d3cb2`; final runtime source is `51869f0`. The separate control installation resolves its own workspace modules. Source optimization experiments use equal dependency versions; the final end-to-end comparison includes the explicitly reviewed security upgrades. Timings were serial with owned builds/test services stopped. No browser-paint or total-user-latency claim is inferred from function benchmarks. Complete outputs/hashes were compared outside timed intervals; candidate scripts, every sample and ranges are retained in the ignored evidence directory.

Bundle totals below sum every production `.js`/`.css` asset; gzip is per-file level 9 with fixed mtime. They are exact bytes, not Vite display estimates. Normal production builds use equivalent inputs; synthetic login builds use a separate output directory and do not enter these totals.

| Frontend / asset | Baseline raw / gzip bytes | Final raw / gzip bytes | Raw / gzip change |
| --- | ---: | ---: | ---: |
| client-app / JS | 625,407 / 197,775 | 625,407 / 197,775 | +0 / +0 |
| client-app / CSS | 34,479 / 6,595 | 34,479 / 6,595 | +0 / +0 |
| framework-studio / JS | 2,247,957 / 686,149 | 2,247,999 / 686,163 | +42 / +14 |
| framework-studio / CSS | 114,217 / 22,584 | 114,217 / 22,584 | +0 / +0 |
| ws-tester / JS | 423,286 / 131,768 | 423,286 / 131,768 | +0 / +0 |
| ws-tester / CSS | 13,767 / 3,802 | 12,546 / 3,446 | -1,221 / -356 |

| Dependency / source / image measure | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| Direct dependency declarations, all four manifest dependency sections | 281 | 280 | −1 |
| Lockfile package records, including root/workspace/link metadata | 1,303 | 1,299 | −4 |
| npm clean-install reported packages on macOS arm64 | 1,118 | 1,114 | −4 |
| Authored physical code lines, including tests/comments/blanks | 207,401 | 207,852 | +451 |
| Normal Dockerfile.dev image size, bytes | 2,298,468,930 | 2,298,213,654 | −255,276 |
| Generated artifact SHA-256 fingerprints equal to baseline | 20 / 20 | 20 / 20 | Unchanged |

The added equivalence/security regression coverage outweighs deleted source in total line count. There is no overall LOC reduction claim. Studio JS grows 42 raw/14 gzip bytes; tester CSS shrinks 1,221 raw/356 gzip bytes. The image difference is only 0.011%, a small aggregate observation, not a material image-size optimization. Both images use the same resolved Node and Docker CLI base digests and share their first nine filesystem layers. Final inspected image contents contain the intended dependency versions, omit typography, and contain the same lockfile SHA as the host (`d67c9b77cd9c57b1597d7cd72499007b5dcda9fb5e3340593d6b76112d6607e6`). Runtime behavior is checked below. Image sizes also include source/tests and the then-current audit document; final prose edits are not represented by the disposed image.

Line method: tracked `.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs`, `.mts`, `.cts`, `.css`, `.prisma`, `.graphql` and `.py` files; physical lines including blank/comment/test lines; exclude the four generated directories, generated Compose file and both route trees. Assign a file once to its longest workspace prefix; root scripts and nonworkspace workloads form the last bucket. Markdown, manifests, lockfiles and Dockerfile comments are outside this code count. `measure.py`, `baseline-verified-metrics.json` and `final-metrics.json` preserve the exact method and all file/byte totals.

| Workspace / bucket | Baseline lines | Final lines | Change |
| --- | ---: | ---: | ---: |
| `agents/example-agent` | 568 | 568 | +0 |
| `cdk-app` | 18,034 | 18,308 | +274 |
| `cdk-app/ecs_containers/services/example-service` | 119 | 119 | +0 |
| `cdk-app/ecs_containers/tasks/invocation-test-task` | 26 | 26 | +0 |
| `cdk-app/lambda_functions/event_functions/cognito-custom-message` | 51 | 51 | +0 |
| `cdk-app/lambda_functions/event_functions/cognito-post-confirmation-trigger` | 32 | 32 | +0 |
| `cdk-app/lambda_functions/event_functions/cognito-pre-signup-trigger` | 188 | 188 | +0 |
| `cdk-app/lambda_functions/event_functions/cognito-pre-token-generation` | 42 | 42 | +0 |
| `cdk-app/lambda_functions/event_functions/invocation-test-step` | 21 | 21 | +0 |
| `cdk-app/lambda_functions/http_functions/graphql-api` | 1,181 | 1,181 | +0 |
| `cdk-app/lambda_functions/http_functions/mfa` | 192 | 192 | +0 |
| `cdk-app/lambda_functions/http_functions/oauth-callback` | 177 | 177 | +0 |
| `cdk-app/lambda_functions/http_functions/refresh` | 111 | 111 | +0 |
| `cdk-app/lambda_functions/http_functions/sign-in` | 258 | 258 | +0 |
| `cdk-app/lambda_functions/http_functions/sign-out` | 53 | 53 | +0 |
| `cdk-app/lambda_functions/http_functions/test-run-task` | 78 | 78 | +0 |
| `cdk-app/lambda_functions/http_functions/test-start-workflow` | 78 | 78 | +0 |
| `cdk-app/lambda_functions/http_functions/verify-session` | 7 | 7 | +0 |
| `cdk-app/lambda_functions/tool_functions/add-numbers` | 19 | 19 | +0 |
| `cdk-app/lambda_functions/tool_functions/multiply-numbers` | 19 | 19 | +0 |
| `cdk-app/lambda_functions/websocket_functions/ws-authorizer` | 91 | 91 | +0 |
| `cdk-app/lambda_functions/websocket_functions/ws-connect-route` | 28 | 28 | +0 |
| `cdk-app/lambda_functions/websocket_functions/ws-custom-action-route` | 29 | 29 | +0 |
| `cdk-app/lambda_functions/websocket_functions/ws-default-route` | 27 | 27 | +0 |
| `cdk-app/lambda_functions/websocket_functions/ws-disconnect-route` | 20 | 20 | +0 |
| `client-app` | 6,324 | 6,324 | +0 |
| `framework-studio` | 124,037 | 124,113 | +76 |
| `local-api-dev-server` | 1,699 | 1,850 | +151 |
| `local-invocation-runner` | 3,850 | 3,849 | -1 |
| `local-ws-dev-server` | 428 | 428 | +0 |
| `packages/api-contract` | 66 | 66 | +0 |
| `packages/database` | 4,937 | 4,928 | -9 |
| `packages/framework` | 36,104 | 36,133 | +29 |
| `packages/models` | 328 | 328 | +0 |
| `root/non-workspace` | 7,506 | 7,506 | +0 |
| `ws-tester` | 673 | 604 | -69 |

Studio startup/snapshot samples use the same synthetic configuration: Dev 27 targets/139 edges, Prod 27 targets/135 edges, every model status `ok`. Each of three new processes takes one initial snapshot then three warm refreshes; three separate server processes are timed to the ready log and checked for HTML. OS caches remain warm. Baseline and final groups were taken at different quiet times, not alternated; environmental drift and the narrow dependency updates prevent causal attribution of these small changes.

| Operation | Samples per side | Baseline median ms (min–max) | Final median ms (min–max) |
| --- | ---: | ---: | ---: |
| Process-cold snapshot | 3 | 2395.98 (2357.79–2924.67) | 2393.75 (2364.45–2914.79) |
| Warm snapshot refresh | 9 | 518.77 (512.39–539.73) | 542.03 (520.93–584.69) |
| Server process to ready | 3 | 3667.76 (3433.10–3670.51) | 3461.26 (3460.11–3874.07) |

Warm refresh is observed 4.5% slower (+23.26ms median); cold snapshot is effectively unchanged and server-ready ranges overlap. These end-to-end results are inconclusive and do not establish a startup gain. Function-level improvements are reported separately with alternating repeated workloads. Local/prod synth elapsed 4.426/9.045s baseline and 3.661/8.542s final; these single cache-sensitive samples are validation receipts, not a speedup claim. Full-suite duration is likewise not a performance result because baseline query GC timers dominate.

## Vulnerability results

npm 11.20.0 used `npm audit --json --package-lock-only --ignore-scripts`, then the same command with `--omit=dev`. Exit 1 means findings; both scans obtained results. No advisory suppression, audit filtering change or forced upgrade was used.

| Scan scope / count | Initial baseline | Contemporaneous unchanged baseline | Final |
| --- | ---: | ---: | ---: |
| Full unique advisory IDs | 18 | 18 | 4 |
| Full package/metavulnerability records | 19 (3 high /16 moderate) | 26 (9 high /17 moderate) | 19 (7 high /12 moderate) |
| Production unique advisory IDs | 14 | 14 | 2 |
| Production package/metavulnerability records | 11 (7 high /4 moderate) | 11 (7 high /4 moderate) | 7 (5 high /2 moderate) |

Fourteen unique advisories were removed, none introduced. npm's recalculation of parent metavulnerabilities changed the unchanged baseline full-view record count; both original and same-time scans are retained. Unique IDs and the contemporaneous comparison avoid misattributing registry state to this patch. The full 18-advisory table below records exact versions, paths, ranges, exposure and remediation/deferral. Remaining findings are Zod, minimatch, Hono's Node adapter and glob's partially mitigated cancellation issue. Production task/service/Python container images were not all built or run; Python coverage is host unit tests and db-migrate execution is prohibited. OS/base-image scanning did not run successfully: installed Scout requires Docker login; no account change was made. npm scanning is not a substitute for OS scanning.

## Verification by category

| Category | Fresh baseline | Final / acceptance evidence |
| --- | --- | --- |
| Unit/workspace suites | Studio 1,669 total:1,643 pass/22 fail/4 skipped; every other workspace suite passes | Studio 1,673:1,647 pass/22 fail/4 skipped; exact same 22 names, every other workspace suite passes |
| Focused unit and fixture integration | Existing controls and exploit failures captured before edits | Framework 527 pass; Studio projection 31; database/log-store 25; tester 4; CVE focused 25 and reviewed 9; CDK finalization 26; nonworkspace Python 2 pass |
| Root verify / typechecks | Stops with four TS2339 crowding diagnostics; separate Studio-server typecheck same | Every implementation gate reaches exactly those four errors; final complete diagnostic comparison equal. Unaffected typechecks pass |
| Later gates after verify stop | Root scripts, GraphQL schema and knowledge checker pass; workspace suites explicitly run | Root scripts, GraphQL schema and knowledge checker pass; workspace suites explicitly run |
| Generated artifacts and frontend builds | All three production builds pass;20 fingerprints captured | All three builds pass; all 20 generated fingerprints identical; no hand edits |
| Browser desktop/mobile/keyboard | Studio, client and tester flows captured with synthetic local fixtures | Final 56/56 existing Sightline/Agent browser cases pass in 45.9s with unchanged goldens; manual Playwright MCP and separate DevTools sessions pass the flows below |
| Local fixture integration | Client API fixture, tester echo and offline task run pass | Same flows pass;34 parser compatibility cases byte-identical; security exploit behavior intentionally changes |
| Database live/application/migrations | Not run; prohibited | Not run; prohibited. Database mocks/unit tests do not establish live DB behavior |
| Offline local/prod synth |5 local/11 prod stacks pass with isolated credentials/metadata and synthetic inputs | Same stacks and every template field unchanged except the two expected task image asset hash fields; no AWS requests |
| Docker build/runtime | Exact Dockerfile.dev image builds; network-disabled invocation task passes; gzip/dependency exploits reproduce | Exact Dockerfile.dev image builds; same task logs/order;4 compressed-body controls and 5 dependency tests pass on Linux Node 24; image contents inspected |
| Container OS/base-image scan | Scout requires login; no result | Not run successfully; documented coverage gap, no account change |
| Windows/native runtime matrix | Not run | Not run; required cross-platform native lock records preserved, Windows path expectations checked statically |
| Deployed/AWS/real remote auth | Not run; prohibited | Not run; prohibited |

Synth comparison permits only `/Resources/DbMigrate5AD6F72D/Properties/ContainerDefinitions/0/Image/Fn::Sub` and `/Resources/InvocationTestTaskF562C16D/Properties/ContainerDefinitions/0/Image/Fn::Sub` in the production EcsTasks template. Source/dependency/test/document changes in the root image context explain these asset hashes. Logical IDs, stack names, AsynchronousLambdaFunctionsStack identity, outputs and network identities remain unchanged. Assemblies include the final runtime implementation; finishing this report changes documentation in the context only.

## Unrelated bugs, retained candidates and human decisions

The exact 22 baseline failures and four related type diagnostics are itemized below, with causes and uncertainty. No assertions, goldens or baseline behaviors were changed to pass them. Existing GC lifetime, manifest spelling and unavailable lint-tooling issues remain outside scope.

Human decisions remain for Zod schema-projection compatibility (fixed 4.6.6 changes supported diagnostics and 3.x needs a major), Hono adapter2.x ownership compatibility, minimatch 11 ownership/major compatibility, and glob's residual stat-after-abort behavior/upstream fix. Their current reachability and failed/unsupported remedies are documented below. No approval is needed to retain these findings; this report does not silently accept a future migration.

Other skipped optimization candidates are deliberate retentions: public getters and FrontendRelease preserve supported capabilities; JSON-viewer prewarm preserves loading UX; replay validation and snapshot setup deduplication lack sufficient measured benefit/equivalence proof; routeKey copies are low-value churn; orphan lock metadata survives npm 11's own cleanup and has no installed dependency impact; OpenSSL removal is unproven. The two candidate tables give each reason.

## Completion and remaining limitations

Both complete passes cover all 35 workspaces plus root scripts, declarations, nonworkspace workloads, Docker and generated/documentation ownership. Accepted changes are committed independently; no new unexplained test failure remains. No implementation blocker is open. Remaining limits are the independently reproduced baseline failures, four advisories above, unavailable OS scanner, unrun Windows/live database/deployed integrations, and inconclusive end-to-end startup timing. These are recorded limitations, not green checks.

Owned services and coordinators are stopped, task browser sessions are closed, both disposable images were removed without force after label/container-reference checks, and synthetic environment copies were removed. Original Studio PID 82689 still listens on 4590; owned ports 3091/3092/3093/4591/4592/4593 are free. Original checkout branch/HEAD/tracked state remain unchanged. No private input was copied. Baseline/control and implementation worktrees plus ignored evidence are retained for review; user images, build caches, `.cache/`, `.framework/`, historical reports and database volumes were not purged. No AWS, database application, deployment, push, merge or publication occurred.

## Advisory investigation before remediation

Authoritative advisory and release research was independently checked by a fresh read-only boundary/compatibility investigator. Six proposed updates fit existing owners without forcing major versions:

| Package / locked paths | Proposed version | Exposure and compatibility disposition |
| --- | --- | --- |
| Express 5.2.1 → body-parser 2.3.0 | 2.4.0 | Concrete compressed-body parsing before route auth in local API/raw proxy, runner and example service; Studio Host guard precedes parser, token guard follows, with loopback-only listener. Preserve inflation and ordinary raw/JSON responses. Minor also adds Zstandard support; test charset/encoding/error behavior. |
| jsdom 28.1.0 / Prisma Composer→Alchemy / OpenAI optional peer → undici 7.30.0 | 7.30.1 | Eight advisories; no authored npm-undici client configuration found. jsdom exercises installed transport. Node global fetch and browser EventSource/WebSocket are separate; npm patch cannot establish their status. |
| Express/body-parser → qs 6.16.0 | 6.16.1 | Affected comma stringify path not found; installed server paths use parse. Verify hostile-own-toString comma serialization and normal parse/stringify. |
| TanStack router-core / Solid → seroval 1.6.8 | 1.6.11 | SPA createRoot entries, no authored SSR JavaScript serialization sink; package presence still merits patch. Check typed-array constructor injection and RegExp script-close escaping with legitimate roundtrips. |
| client-app and ws-tester → Vitest/mocker 4.1.11 | 4.1.12 | Standalone mocker/interceptor WebSocket plugins absent; ordinary Vitest Browser Mode excluded by upstream. Patch both workspace owners and coordinated Vitest packages; retain root transitive 5.0.3. |
| Prisma compute/Composer→NFT 1.11.0 → glob 13.0.6 | 13.0.7 | Official same-major abort backport released November 6; NFT calls inspected omit AbortSignal. Count filesystem work after cancellation and retain normal traversal control. Published advisory range may still flag patched 13.x. |

Sources: [body-parser 2.4.0](https://github.com/expressjs/body-parser/releases/tag/v2.4.0), [undici 7.30.1](https://github.com/nodejs/undici/releases/tag/v7.30.1), [qs 6.16.1](https://raw.githubusercontent.com/ljharb/qs/v6.16.1/CHANGELOG.md), [Seroval changes](https://raw.githubusercontent.com/lxsmnsyc/seroval/seroval@1.6.11/packages/seroval/CHANGELOG.md), [Vitest security backport](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12), [glob backport](https://raw.githubusercontent.com/isaacs/node-glob/v13.0.7/changelog.md).

- **Zod:** downloaded 4.6.6 into ignored evidence without changing dependency resolution. Injected that exact package for the two existing AgentCore schema/generation suites: 6 pass, 2 fail because primitive unions now report `Gateway tool schemas have no type ["string","number"]` instead of the established union/nullable error. This independently reproduces incompatibility of the proposed fixed version, rather than relying on historical 4.6.7 evidence. Preserve current compatibility pin and separate browser Zod 3. A schema-projection migration and its complete public diagnostics/generated-output compatibility require a human decision. The security fix bounds constrained collection processing; it does not bound arbitrary unbounded arrays. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [fix scope](https://github.com/colinhacks/zod/pull/6652). Evidence: `zod-4.6.6-compatibility.log`.
- **Hono node-server:** root override and Prisma→Composer/Alchemy→@prisma/dev resolve 1.19.15, while its owner declares exact 1.19.9. Fix 2.1.3+ crosses an unsupported major. Inspected Prisma dev code uses `serve`, not affected `serveStatic`; no exploit path established. Retain with decision required. [Advisory](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), [release](https://github.com/honojs/node-server/releases/tag/v2.1.3).
- **minimatch:** 10.2.5 plus CDK-bundled 10.2.6; fixed 11.0.1 crosses every owning 10.x constraint. Current CDK 2.275.0, graphql-config 6 and NFT 1.11.1 do not remove the chain. CDK/GraphQL callers inspected do not set optimizationLevel 2; glob does. Source-derived NFT patterns may be attacker influenced in build tooling; exploitability not demonstrated. Retain major migration/unsupported override decision; do not downgrade CDK/Codegen/Prisma to npm audit suggestions. [Advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249), [breaking maintainer changes](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.1/changelog.md).

Image scanning: Docker Engine/CLI 29.8.0 and Scout 1.24.0 are installed. One-off `docker scout cves local://36288ff0cb79 --format sarif` refused because Docker login is required; no scan result exists. Account login/change is outside this task. Existing image metadata is inventory only, not an exact current-source baseline. No image, container or account changed during this attempt. Evidence: `scout-existing-dev.log`.

## Baseline timing and browser receipts

Three process-cold snapshot/startup samples and three warm refreshes per snapshot process were collected serially after all tests/builds and owned browser services stopped. These are OS-cache-warm local runs, not cold disks. `baseline-startup-snapshot.json` retains every sample; `baseline-candidates.json` records seven alternating samples per side against an independently installed fixed baseline. Full-output equality and SHA-256 checks occur outside timed intervals.

Browser checks used synthetic inputs and no AWS profile. Studio Map/resource permissions, Sightline, Add menu Escape/focus and all primary workspace routes were exercised; desktop/mobile client login by keyboard, empty projects, project creation and deliberate HTTP error passed against a local API fixture. Tester connected to a local echo service, rejected malformed JSON, sent/echoed a message and disconnected. At 390px all recorded pages have document scrollWidth 390. Screenshots visually inspected; tester preserves its pre-existing cramped two-column mobile layout. DevTools Studio/client pages had no console errors; client deliberate 503 was expected. Network cancellation from StrictMode initialization was followed by successful responses. These checks do not validate real auth, AWS or database integration. Tool path restrictions required initial browser capture inside the shared checkout’s ignored evidence directory; only exact task-owned captures were moved into the owned worktree.

## Framework candidate implementation evidence

Existing fresh `createTargetAvailability` replaces repeated whole-config predicate calls. CDK registration groups declared IDs once, preserving lambda/service/task/workflow/agent order and per-kind declaration order, then reuses them for reverse validation. Literal canonical routes compare directly; wildcard semantics retain segment parsing. No cache outlives one invocation; declarations are literal per the repository contract. Added tests cover input/registry mutation between calls, exact first missing-registration errors, unregistered entries, literal/root/wildcard/case/method routing. Focused suite: 25/25 pass. Public task/service/workflow getters remain: the actual application has one workflow, and further getter rewrites have no demonstrated material actual-workload benefit.

| Computation / synthetic targets | Before median ms (range) | After median ms (range) |
| --- | --- | --- |
| normalize / 20 | 0.412 (0.298–0.604) | 0.332 (0.289–0.439) |
| input-template-check / 20 | 7.926 (7.322–9.666) | 0.511 (0.472–0.631) |
| cdk-registry / 20 | 12.481 (12.294–14.186) | 0.450 (0.426–0.482) |
| normalize / 100 | 1.355 (1.224–1.497) | 1.067 (1.017–1.241) |
| input-template-check / 100 | 223.661 (220.316–229.017) | 1.983 (1.815–2.183) |
| cdk-registry / 100 | 343.221 (340.639–352.556) | 1.923 (1.854–1.973) |
| normalize / 250 | 4.595 (4.514–5.067) | 2.794 (2.610–2.965) |
| input-template-check / 250 | 2333.507 (2319.631–2339.269) | 5.498 (4.685–5.854) |
| cdk-registry / 250 | 3550.297 (3541.046–3593.416) | 5.691 (5.270–6.644) |

These are computation-only synthetic scaling results, not claims about browser paint or whole-system latency. All complete output comparisons passed with unchanged dependency versions. The fixed control is the separate exact-revision baseline worktree.

Baseline Docker: a network-disabled build could not obtain absent Debian apt layers; a normal package-download build then passed. No AWS request was made. Exact `Dockerfile.dev` output is independently tagged/labeled for this audit, with its immutable image metadata captured. Network-disabled invocation-test-task completed all existing logs in order and exited0 with synthetic input and no callback. OS/base-image vulnerability scanning remains unavailable because Scout requires account login.

## Studio projection evidence

Permission lists index enriched edges per invocation, retaining one occurrence per target per edge, duplicate edge IDs, self-loop cardinality, independent target wrappers, and implicit/explicit policy order. Sightline reuses fresh mode indexes within one focus build and uses a Set only for island membership checks; current-mode fallback, first matching direct edge, displayed duplicates and omission order remain. No model/cache/transport/subscription lifetime changes. Full-output comparisons passed for actual Dev/Prod permission models and synthetic fixtures. Focused tests 31/31 pass; existing Sightline/Agent browser suites 56/56 pass on light/dark desktop/mobile with unchanged goldens. Manual Playwright inspector/Sightline checks and DevTools console/network/DOM checks passed; 390px document has no overflow, keyboard reaches Copy JSON.

| Computation / fixture | Before median ms (range) | After median ms (range) |
| --- | --- | --- |
| authorization / actual-dev | 0.1341 (0.1222–0.1608) | 0.0862 (0.0725–0.2685) |
| authorization / actual-prod | 0.1151 (0.1110–0.1261) | 0.0673 (0.0600–0.0727) |
| authorization / 100-entities | 0.1023 (0.0947–0.1173) | 0.0527 (0.0412–0.0602) |
| authorization / 500-entities | 1.7640 (1.7105–2.0090) | 0.2249 (0.2071–0.3044) |
| authorization / 1500-entities | 16.6712 (15.6893–17.9113) | 0.6774 (0.6420–0.7309) |
| sightline-target / 25 | 0.1076 (0.0903–0.1791) | 0.0857 (0.0793–0.1494) |
| sightline-island / 25 | 0.1057 (0.1003–0.1135) | 0.1095 (0.1031–0.1171) |
| sightline-target / 100 | 0.2249 (0.2176–0.2582) | 0.1291 (0.1243–0.1365) |
| sightline-island / 100 | 0.1996 (0.1932–0.2376) | 0.2006 (0.1959–0.2118) |
| sightline-target / 500 | 1.0582 (1.0384–1.0930) | 0.4773 (0.4323–0.9869) |
| sightline-island / 500 | 0.9310 (0.9077–1.3429) | 0.7512 (0.7179–0.7740) |

Small-island results at 25/100 entities are inconclusive/slightly slower (microseconds); the500-entity island gains about 0.18ms. Target focus and authorization scaling improve; these computation measurements exclude React rendering and paint.

Verification correction: initial framework implementation logs contained two new fixture type errors (inferred never config return and widened string[] HTTP methods), initially missed in the tail-only summary. Fixtures now use explicit FrameworkConfig and nonempty HttpMethod tuple types; framework typecheck passes. The complete diagnostic comparison now confirms only the original four errors remain (`final-verify-diagnostic-comparison.json`). Source behavior/tests were not weakened.

## Accepted private cleanup and tester investigation

`effc7d6` removes unused tileTopPoints/eventTone/sourceWriteInProgress/acquireInitializationLock helpers, an equivalent negative-time branch, two private reexport modules and four unused imports. The database advisory transaction lock remains in studio-migrations and existing lock assertions pass. The log-store test imports its canonical owner with all assertions retained. Current Board references are corrected; historical documentation/evidence remains unchanged. Cross-source/test/docs/package-export/script/dynamic-entry tracing found no remaining consumers; public framework APIs, retained FrontendRelease and database timestamp helpers stay. Focused database/log-store tests 25/25 pass; root scripts typecheck/knowledge checker pass. Full verify exactly reproduces baseline type errors.

Tester typography directive removal alone yields byte-identical production JS/CSS assets (`tester-typography-equivalence.json`). Its declaration and exclusive parser override are removed; npm 11 lock refresh removes exactly4 package records (typography, cssesc, postcss-selector-parser, util-deprecate), changes only ws-tester ownership and upgrades/adds nothing. Unused template color variables have no source consumers; existing font/background rules remain; the final computed-style comparison passes.

## Exploit/control baseline before dependency upgrades

The exact detached baseline installation fails all 5 bounded dependency probes for the expected reasons: qs comma conversion throws; Seroval emits the typed-array constructor canary and unescaped RegExp HTML delimiter; npm Undici accepts an uppercase SRI mismatch; glob performs9 directory reads after cancellation instead of 1. Tests use mocked HTTP and a temporary bounded filesystem tree. Separate child-process gzip trailer probes crash both Express JSON and raw parsing with an unhandled incorrect-header error. Deflate sibling-consumer controls pass. An initial probe responded before its own downstream hash completed and timed out; it was corrected to await downstream completion, and those invalid harness runs are retained but excluded as vulnerability evidence. `baseline-dependency-probes.log` and `baseline-body-parser-probes-final.json` are the decisive receipts. No network outside loopback/mock transports and no secret input is involved.

Tester cleanup gates: clean offline installation1114 packages succeeds; production build and 4/4 token-handoff tests pass. Full verify reproduces exactly the same 4 baseline diagnostics. Playwright desktop1280/mobile390 keyboard connection, invalid-payload suppression, valid echo and disconnect pass; all computed non-custom CSS properties across 116 DOM elements match the original stylesheet at both widths. DevTools independently reproduces echo with no console warnings/errors. CSS shrinks13767→12546 raw and 3802→3446 gzip bytes; JS unchanged. Removed custom variables had no consumers, and every rendered property remains equivalent.

## Security candidate validation and review

Committed security versions are body-parser 2.4.0, its required iconv-lite 0.7.3, qs 6.16.1, seroval 1.6.11, undici 7.30.1, glob 13.0.7, and the two owning Vitest declarations4.1.12 with coordinated4.1.12 packages. Root transitive Vitest/mocker 5.0.3 and all protected pins/native binding records remain. The complete npm 11 lock diff changes only these packages and relocates each4.1.12 mocker one level up inside its same workspace. No new package names or final overrides/declarations were added. Initial unconstrained resolution selected newer qs/seroval/undici releases and was rejected; npm 11 exact temporary resolution declarations were removed before the final normal lock refresh and clean install. npm install scripts/generation passed.

The five original dependency exploit/control probes now pass. Both raw and JSON gzip trailer child processes survive, preserve the decoded body and complete a sibling stream hash; deflate controls remain green.34 ordinary JSON/raw/text/urlencoded parser cases, including gzip/deflate/Brotli/identity, UTF16, malformed JSON,413 and 415 diagnostics, match the detached baseline byte-for-byte. Permanent regression tests live with the existing local API and CDK tooling suites;25 focused tests pass and CDK typecheck passes. The first new fixture typing error was corrected without weakening assertions. Required iconv-lite 0.7.3 adds charset aliases and corrects UTF32 chunk-boundary handling ([maintainer notes](https://raw.githubusercontent.com/ashtuchkin/iconv-lite/v0.7.3/Changelog.md)); body-parser 2.4 also accepts Zstandard. No authored caller declares either as an application rejection policy; ordinary supported application cases above remain equivalent. Real AWS/remote authentication and Windows execution are not covered by these checks.

A fresh read-only bypass/regression reviewer found a Windows path separator issue in the new glob test; expected paths now use path.join. Windows execution remains unrun. The reviewer also identified a remaining cancellation path in upstream glob 13.0.7. Root independently reproduced it: with stat:true and an abort while readdir is pending, baseline 13.0.6 performs9 directory reads (8 after abort) and 17 metadata reads (16 after abort);13.0.7 performs1 directory read (0 after abort) but9 metadata reads (8 after abort). Thus this backport is **partial mitigation, not complete remediation**. The persistent regression is named narrowly for recursive directory reads. The residual stat path remains a finding; NFT's inspected calls use neither stat:true nor signal. No unsupported upstream patch/major migration is introduced. Evidence: baseline-glob-abort-stat.json, cve-glob-abort-stat.json. The published advisory continues to include13.0.7, so it is not suppressed or reported eliminated.

The final audit removes14 of 18 unique advisories, adds none, and retains4: Hono adapter, minimatch, Zod and partially mitigated glob. Initial full-tree npm result was19 package/meta records. A contemporaneous rescan of the unchanged baseline now reports26 (9high/17moderate), versus final 19 (7high/12moderate); production remains11 (7high/4moderate) versus final 7 (5high/2moderate). Added full-view parent findings propagate the same existing Zod advisory; package contents and unique advisory IDs did not change in the baseline. Both initial and contemporaneous results are retained. Use unique IDs and the same-time comparison rather than misrepresenting registry/metavulnerability recalculation as a code change.

## Complete advisory and dependency-path inventory

Ranges/severities below come from this run's original authoritative advisory records. Both means the advisory appears in both npm audit views, not demonstrated deployed exploitability. Package presence and reachable vulnerable operations are distinguished.

| Key | Exact baseline installed paths and owner chain | Candidate/final path/version |
| --- | --- | --- |
| H | `node_modules/@hono/node-server` 1.19.15; root dev pin and Prisma→Composer/Alchemy→@prisma/dev | Same 1.19.15, deferred |
| V | client-app and ws-tester/node_modules/vitest/node_modules/@vitest/mocker 4.1.11; each workspace Vitest owner | Each workspace/node_modules/@vitest/mocker 4.1.12; owning Vitest 4.1.12. Root optional-peer Vitest/mocker 5.0.3 unchanged |
| B | node_modules/body-parser 2.3.0; Express 5.2.1 shared by local API/runner/Studio/example-service | Same path 2.4.0; required iconv-lite 0.7.2→0.7.3 |
| G | node_modules/glob 13.0.6; Prisma→compute-sdk/Composer→Alchemy→@vercel/nft 1.11.0 | Same path 13.0.7, partial mitigation |
| M | node_modules/minimatch 10.2.5 (glob/GraphQL config); node_modules/aws-cdk-lib/node_modules/minimatch 10.2.6 | Both unchanged; production audit lists CDK-nested copy |
| Q | node_modules/qs 6.16.0; Express and body-parser | Same path 6.16.1 |
| S | node_modules/seroval 1.6.8; TanStack router-core and Solid | Same path 1.6.11 |
| U | node_modules/undici 7.30.0; jsdom 28.1.0, both Prisma Composer Alchemy copies, optional OpenAI peer | Same path 7.30.1; Node 26 bundled undici 8.12.2/global fetch is separate and unchanged |
| Z | `node_modules/zod` 4.4.3 (framework/agents/models/tooling) and `packages/api-contract/node_modules/zod` 3.25.76 (browser contracts) | Both unchanged |

| Advisory / CVE | Package key; severity; affected range; scan scope | Exposure / prerequisites | Result / reason |
| --- | --- | --- | --- |
| [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) / CVE-2026-118663 | H; moderate; `>=1.19.10 <2.1.3`; full only | Static serveStatic double decoding; no authored call, Prisma tooling configuration uncertainty. | Deferred: protected 1.19.15; fix 2.1.3 crosses owner major. |
| [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) / CVE-2026-112949 | V; moderate; `>=2.1.0-beta.7 <4.1.12`; full only | Standalone mocker/interceptor plugin socket injection; plugins absent from authored Vite configuration. | 4.1.12; absent from final audit. |
| [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) / CVE-2026-112950 | V; moderate; `>=4.1.11 <4.1.12`; full only | Same plugin prerequisite plus Windows path handling; ordinary Browser Mode excluded upstream. | 4.1.12; absent from final audit; Windows execution not run. |
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) / CVE-2026-111181 | B; high; `>=2.0.0 <2.4.0`; both | Compressed input reaches preauth JSON/raw parsers in local API, runner, Studio and example service; listener/ingress access required. Baseline process crash demonstrated. | 2.4.0; original crash absent, ordinary controls equal; absent from final audit. |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) / CVE-2026-118773 | G; moderate; `>=9.0.0 <=14.0.1`; full only | Cancellation as a resource budget for hostile traversal. NFT calls omit signal/stat; residual metadata work after abort reproduced. | 13.0.7 partial mitigation; still flagged and not fully remediated. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) / CVE-2026-118764 | M; moderate; `>=7.0.0 <11.0.1`; both | Hostile patterns with optimizationLevel≥2; glob requests2, CDK/GraphQL omit it. Untrusted build-source influence uncertain. | Deferred:10.2.5/10.2.6; fix 11.0.1 is unsupported major for all owners. |
| [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) / CVE-2026-110816 | Q; moderate; `>=6.7.0 <=6.16.0`; both | Comma stringify of data-owned noncallable toString; actual Express owners parse, no authored affected stringify. | 6.16.1; exploit/control regression passes; absent from final audit. |
| [GHSA-f86p-h4j2-7qgj](https://github.com/advisories/GHSA-f86p-h4j2-7qgj) / CVE-2026-116583 | S; moderate; `>=1.6.0 <1.6.11`; both | Untrusted typed-array constructor serialized to JavaScript; no authored sink established. | 1.6.11; constructor-canary and legitimate roundtrips pass; absent from final audit. |
| [GHSA-9wx9-5pv9-3349](https://github.com/advisories/GHSA-9wx9-5pv9-3349) / CVE-2026-116582 | S; moderate; `>=1.5.5 <1.6.10`; both | RegExp serialization embedded in HTML script; inspected applications use createRoot, no SSR sink. | 1.6.11; HTML delimiter escaping and regex controls pass; absent from final audit. |
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) / CVE-2026-109924 | U; moderate; `>=7.0.0 <7.30.1`; both | Hostile npm EventSource stream; no authored use, browser-native EventSource is separate. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) / CVE-2026-109841 | U; moderate; `>=7.15.0 <7.30.1`; both | Mixed/uppercase SRI metadata and hostile response; no authored npm fetch/SRI path. | 7.30.1; mismatch/strongest-hash/control tests pass; absent from final audit. |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) / CVE-2026-109869 | U; high; `>=7.18.0 <7.30.1`; both | Malicious response content encodings reaching npm transport; dependency-internal lower-trust response reachability uncertain. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) / CVE-2026-109829 | U; high; `>=7.0.0 <7.30.1`; both | Redirect plus shared-cache interceptor composition; no authored composition. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) / CVE-2026-109383 | U; high; `>=7.0.0 <7.30.1`; both | Function-valued custom TLS validation through Agent; no authored Agent, Studio domain checks use node:https/tls. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) / CVE-2026-87018 | U; high; `>=7.0.0 <7.30.1`; both | Malicious contacted TLS1.2 peer renegotiation; exact attacker-controlled npm connection not established. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) / CVE-2026-109932 | U; moderate; `>=7.0.0 <7.30.1`; both | Malicious WebSocket PING traffic; jsdom consumes client, inspected fixtures local; tester uses browser-native socket. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) / CVE-2026-87029 | U; moderate; `>=7.15.0 <7.30.1`; both | Decompression interceptor plus throwing downstream handler; no authored composition. | 7.30.1; maintainer fix/source reviewed, absent from final audit. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) / CVE-2023-54404 | Z; high; `<4.6.6`; both | Oversized constrained collections; current arrays reviewed lack collection bounds, exact path unproven. Generic unbounded arrays remain outside fix. | Deferred:4.4.3 pin and 3.25.76;4.6.6 compatibility experiment changes public schema errors (6pass/2fail),3.x requires major. |

Metavulnerability rows add no advisory IDs. Full scan propagates through aws-cdk-lib, graphql-config, @graphql-codegen/cli, @vercel/nft, alchemy, @prisma/composer, @prisma/composer-cli, @prisma/compute-sdk and prisma. Zod propagates through @langchain/core, @langchain/langgraph, @langchain/openai, openai, @tanstack/router-generator and @tanstack/router-plugin in the contemporaneous full view. Glob still carries both its own abort advisory and minimatch's advisory; changing cancellation handling does not remediate minimatch. Both Alchemy paths are node_modules/@prisma/{composer,composer-cli}/node_modules/alchemy. The final audit's seven production package records represent two unique advisories (Zod and minimatch).

Evidence for source exposure: local-api-dev-server/lib/routeProxyHelpers.ts82–92; framework-studio/server/server.ts330–335 and guards.ts15–40; local-invocation-runner/src/index.ts384–390; example-service/src/index.ts18–19; createRoot entrypoints in each of three frontends; codegen.ts patterns; packages/framework/src/runtime/agentcore.ts and protocol/tool-schema.ts. Installed owner paths and exact before/after lock records are captured in cve-lock-diff.json. No empirical reproduction is claimed for seven Undici variants that lack an authored path; maintainer patch/source and dependency integration verification support the narrow update, while their application reachability remains uncertain.

## Second full pass and remaining candidate decisions

Three independent read-only audits revisited all 35 actual workspaces and cross-cutting areas after the initial implementations. Scope included framework/CDK/root/runtime 30-workspace coverage, server/data/application 28-workspace coverage, and all three frontend inventories. Overlapping reviews found no new production regression in accepted optimizations. Studio frontend/shared 282 files include 278 reachable from main and 4 server/test/documented consumers; client 52 includes 41 runtime/type dependencies,10 tests and one intentional typecheck fixture; tester 8 includes 7 application files and one test. No newly unowned frontend module was found. Server review covered 164 server and 52 shared files,51 database,9 API-contract,9 models,5 agents,85 Lambda and 15 ECS files.

Cross-cutting review covered literal workload composition, resources/networks/database/construct identities;43 root script files; nonworkspace db-migrate and stdlib Python example; Docker/Compose watch/context/label/generated ownership; package exports and dynamically constructed subprocess paths; current knowledge versus preserved historical documentation. Current auth, source/recovery/transaction guards, public repository methods, SQL owner predicates, request-local GraphQL memoization, model providers and compatible persisted formats retain active consumers. No new source/data/cache/concurrency abstraction is justified.

| Second-pass candidate | Evidence and disposition |
| --- | --- |
| CDK dev resource finalization loop | Implemented in `b2d7690` after quiet repeated baseline/proposed-loop comparison. Actual application filtering13.095→0.921ms median; identical target order. Existing native/resource tests and both synths preserve output identities. |
| Replay-source checks | check-local.ts88–93 repeats section/target/source resolution. Retain pending a dedicated source-validation benchmark and error-order/containment argument; replacing it would touch safety-relevant path validation, while it runs once per command. |
| Ten orphan lock records | Absent historical workspace manifests, no installed links/descendants, unchanged baseline metadata. Both normal npm 11 refresh and isolated npm 11 prune --package-lock-only leave them unchanged. Retain; do not hand-edit lock or claim package/CVE savings. |
| Docker comments | The syntax frontend is digest-pinned, while Node/Docker FROM tags float; comments incorrectly claim all images pinned and an active Prisma engine. Implemented comment corrections in `51869f0`; OpenSSL remains until runtime/CLI/TLS evidence supports removal. |
| Three WebSocket routeKey copies | Unused local copies in custom/default/disconnect handlers save only 3 properties; retain as low-value source churn, with exact wire/error/log behavior preserved. |
| Tester hidden JSON-viewer prewarm | Live mount loads lazy viewer before first message. Retain: removal changes loading/first-message UX and has no equivalent workload measurement. |
| Snapshot inputSetupProblems duplication | Two graph projections evaluate it; retain unmeasured minor lead because freshness/order need proof. |
| Test GC lifetime | Existing explicit 10-minute query GC timers survive JSDOM teardown. Retain as unrelated test-lifecycle bug; do not weaken/skip suites. |

The ten retained metadata paths are services/langgraph; lambda_functions/{cognito-custom-message,cognito-pre-signup-trigger,ws-connect-route,ws-custom-action-route,ws-default-route,ws-disconnect-route}; http_functions/test-agentcore; tool_functions/{agentcore-echo-tool,echo}, each under cdk-app's appropriate former workspace prefix. They are not part of the35-workspace inventory. nodemon/ts-node names in those records have no installed lock entries. Evidence: stale-lock-prune-probe.json/log.

## Independently reproduced unrelated baseline failures

These are from this run’s exact baseline, not historical assumptions. Existing assertions/goldens remain unchanged. Four opacity failures share scene/connections.ts outOfLens 0.15 while adjacent comment/tests specify a quarter. Rendering/spacing mismatches need product intent or fixture diagnosis; no unrelated fixes were made.

| Exact baseline failure | Source under framework-studio/test | Cause / uncertainty |
| --- | --- | --- |
| every Studio test asserts through the bounded module | `bounded-assert.test.ts:57` | Sightline freshness fixture imports node:assert directly instead of bounded helper. |
| the card checks Docker before enabling the preview and its status follows it | `compose-preview-ui.test.ts:68` | Fixture lacks required StudioProvider. |
| nothing moves before the first turn-on, and each turn-on plays the launch once | `compose-preview-ui.test.ts:82` | Fixture lacks required StudioProvider. |
| with motion off the switch changes state without any animation | `compose-preview-ui.test.ts:100` | Fixture lacks required StudioProvider. |
| starting Docker keeps the switch off until a separate click on the switch | `compose-preview-ui.test.ts:111` | Fixture lacks required StudioProvider. |
| Docker without Desktop offers manual instructions and a fresh check | `compose-preview-ui.test.ts:133` | Fixture lacks required StudioProvider. |
| a failed Docker start stays off and can be retried | `compose-preview-ui.test.ts:150` | Fixture lacks required StudioProvider. |
| closing while detection is pending ignores the late response | `compose-preview-ui.test.ts:164` | Fixture lacks required StudioProvider. |
| a missing required value links from its connection straight to its open, focused row in CDK environment | `draft-ui.test.ts:949` | Dereferences readiness row after successful input removes it. |
| header rename stages beside input settings and Escape restores only its opening names | `draft-ui.test.ts:2215` | Expected accessible name Value in development differs from Value for ENABLE_WEB_SOCKET_API. |
| an input group's hover counts its entries per graph and names what reads them and what they feed | `hover.test.ts:168` | Expected4 client inputs; current declaration has3. |
| the composition objective prefers breathing room to legal but tightly packed islands, while bounding sprawl | `island-composition.test.ts:44` | Spacious cost 6629.951 exceeds compact 3449.587; intended objective needs design decision. |
| the composition objective uses horizontal room according to the viewport rather than demanding the same shape everywhere | `island-composition.test.ts:55` | Wider arrangement does not reduce cost as expected; design intent unresolved. |
| preferred spacing responds to labels and connection density even before painted elements overlap | `island-composition.test.ts:66` | Obsolete LayoutQuality.crowding metric also causes4 type diagnostics. |
| fresh compositions retain visible separation across sparse and dense topology and desktop aspects | `island-composition.test.ts:78` | Sparse4:3 median gap 64 misses requested extra breathing room; hard clearance passes. |
| new WebSocket creation labels its guarded handshake condition and retains Off | `isometric-ui.test.ts:425` | ENABLE_WEB_SOCKET_API label differs from expected catalog name enableWebSocketApi. |
| missing required connections paint red X markers and clicking the marker selects its guidance | `isometric-ui.test.ts:1017` | Expected red marker absent before picking assertion; rendering/fixture cause unresolved. |
| the real renderer draws resting connections a little stronger, and those outside the viewed environment at a quarter of that | `isometric-ui.test.ts:1204` | Out-of-environment alpha 0.045 versus0.075 expected. |
| in Development the real renderer strokes the unbuilt VPC as one deck with a single violet rim | `isometric-ui.test.ts:1422` | Expected violet VPC deck rim absent; rendering/fixture cause unresolved. |
| every connection shares opacity and thickness across provenance, relationship types, environments and zoom | `isometric-ui.test.ts:2100` | Same outside-environment alpha mismatch across edge/zoom fixture. |
| a connection outside the viewed environment rests at a quarter of the strength it has inside it | `landscape.test.ts:1041` | Out-of-environment alpha 0.045 versus0.075 expected. |
| an enabled connection reads clearly in its own view and recedes where it is disabled | `landscape.test.ts:1138` | Same alpha mismatch in Production. |

Other retained baseline issues: some Lambda lint scripts refer to unavailable ESLint tooling; the API-contract package deliberately remains on a different Zod major from authored server contracts. Neither was altered. Studio QueryClient teardown leaves explicit 10-minute GC timers alive; final wall time must not be described as improved test execution.

Additional runtime receipts: both exact-baseline and final nonworkspace Python handler unittest suites pass 2/2 without bytecode writes or AWS access. Baseline Docker Node 24.22.2 independently reproduces the same two gzip child-process crashes and all 5 dependency probe failures; both deflate sibling controls pass. Docker probes use --rm --network none, no ports/volumes/credentials, and only the task-owned labeled image. Final 20 generated artifact fingerprints still exactly equal baseline after clean install/build/verify.

## Second-pass finalization measurement and validation

This candidate was identified during the second full audit, measured before editing, then checked again by the framework reviewer. Targets are normalized first, then availability is created inside the development branch after pending attachments, database validation and trigger attachment. All native getters, requirement checks, resource references, deduplication, parameters, output IDs and output order remain in their original loop. Unconditioned selection never calls inputs.holds. Current authored native getters do not mutate declarations; custom mid-finalization mutation is outside the documented literal-declaration/operation-snapshot contract. No cache survives a call.

| Target-filtering computation | Before median ms (range) | After median ms (range) |
| --- | --- | --- |
| actual-application | 13.095 (12.616–13.688) | 0.921 (0.868–1.007) |
| 20-targets | 3.913 (3.614–3.980) | 0.377 (0.339–0.440) |
| 100-targets | 87.738 (84.910–91.560) | 1.721 (1.605–2.135) |
| 250-targets | 592.551 (590.631–593.517) | 4.812 (4.636–4.976) |

Two warmups and 7 alternating samples use identical installed dependencies/current normalization code; SHA/full target-reference/order checks are outside timing. These measure filtering computation, not whole CDK synth. Resource/stateful13 tests plus actual registry/native13 tests pass. The first command included a nonexistent framework-target-registry.test.ts pattern, which Node silently ignored; the actual target-registry.test.ts ran in the second command. Both normal synth modes passed; local 5/prod 11 stacks retain all template fields except the DbMigrate and InvocationTestTask container asset hashes. Required verify and knowledge check pass their unaffected gates, with exactly the4 baseline type errors retained.

The final full-workspace run completes in 1095.63s overall. Studio totals 1673 tests/1647 pass/22 fail/4 skipped versus baseline 1669/1643/22/4. Exact failure-name sets match, with no new or disappeared failures. All other workspace suites pass. Root scripts and GraphQL schema suites pass separately after the known verify stop; Studio-server typecheck reproduces the same 4 diagnostics. Later CDK-only source changes receive focused resource/registry tests, full verify and both synth modes rather than rerunning unrelated17-minute Studio fixtures without a new hypothesis.


## Final browser, runtime and cleanup receipts

Final browser work uses Playwright MCP for interaction and a separately reproduced Chrome DevTools session for DOM/CSS, console and request diagnosis. Studio Map→Resources→GraphQL inspector retains its three permissions, Agent→Sightline loads, and keyboard Tab reaches Copy JSON. Client keyboard login reaches empty Projects, keyboard submission creates a synthetic project, and a deliberate 503 renders its error state. Tester keyboard connect, invalid-JSON suppression, valid echo and disconnect pass. At1280px and 390px, the recorded pages have no horizontal overflow; tester retains its existing cramped two-column mobile layout. Visual screenshots were inspected. Studio/tester have no console errors; client's deliberate 503 is the only expected error. StrictMode's initial canceled reads are followed by successful responses. This is fixture verification, not remote auth/database validation.

Evidence paths under `output/playwright/optimization-2026-11-06-01/` include final-studio-{permissions,mobile}.png, final-client-{desktop,mobile}.png, final-tester-{desktop,mobile}.png, corresponding JSON DOM measurements, and `final-suite/`. Baseline/after captures and the116-element style comparison remain there as well. MCP path restrictions briefly required exact task-named ignored captures in the original checkout; those captures were moved, with original source untouched.

Raw receipts under `.framework/artifacts/optimization-2026-11-06-01/`:

- `final-later-gates-status.json`, `final-workspace-tests.log`, `final-failure-comparison.json`, `final-verify-diagnostic-comparison.json`, `docker-comments-verify-status.json`, `cve-reviewed-gates.json`.
- `baseline-verified-metrics.json`, `final-metrics.json`, `baseline-startup-snapshot.json`, `final-startup-snapshot.json`, `framework-candidates.json`, `studio-after-candidates.json`, `finalization-candidate.json`.
- `baseline-audit-{full,production}.json`, `comparison-baseline-audit-{full,production}.json`, `final-audit-{full,production}.json`, `advisory-dispositions.json`, `cve-lock-diff.json`, and before/after dependency owner trees.
- `final-synth-status.json`, `final-synth-summary.log`, normal synth logs/assemblies; `final-focused-browser.log`; `python-checks.json`.
- `baseline-docker-image.json`, `final-docker-image.json`, `final-docker-contents.json`, `final-docker-checks.json`, `final-docker-task.log`, and baseline/final build and exploit logs. Baseline image ID 7b3d4faf696a; final 9bdc50869513. Resolved Node base01d566e8d94d and Docker CLI base625d9431a9f5 are equal in both builds.
- `final-image-cleanup.json`, `final-process-cleanup.json`, `final-input-cleanup.json` and `final-ownership-check.json` preserve ownership checks and cleanup outcomes. No broad cleanup command was used.

The report is committed separately from the seven implementation/documentation commits so each change remains independently reviewable. Raw logs, synthetic fixtures, temporary assemblies and screenshots are intentionally ignored rather than committed.
