# Studio verification fixes — November 6, 2026

The complete required offline `npm run verify` gate passed on merged `main`: **2,703 passed, zero failed, five existing conditional skips**, with a normal exit after **942.96 seconds**. All four TypeScript diagnostics and all 22 audit failures are fixed. The separate browser run has four confirmed pre-existing screenshot failures; that browser result is not green.

Started from `audit/optimization-2026-11-06` at `44cb7581ee02a38229b7217d371793f5fa49b3cc`. Implementation was isolated on `fix/studio-verification-2026-11-06` in `/private/tmp/matts-studio-verification-2026-11-06`. At the user's subsequent request to merge everything into main and continue there, local `main` fast-forwarded from `70caeb2` to `30358d0`, including the feature history, optimization/security work, and all three fix commits. Work continues in `/private/tmp/matts-main-2026-11-06`. The original `feature/studio-sightline` checkout and audit/fix branch tips were preserved. Nothing was pushed.

## Commits and scope

| Commit | Change |
| --- | --- |
| `cde475e` | Repair Studio test providers and fixture inputs; reconcile current labels/readiness behavior; explicitly fit rendering fixtures; dispose owned QueryClients, DOMs and timers. |
| `d73ac98` | Correct composition tests to the documented layout objective and existing geometry contracts. |
| `30358d0` | Restore the documented quarter-strength multiplier for connections outside the active lens. |

The only production change is `EDGE_ALPHA.outOfLens: 0.15 → 0.25`. Resting opacity remains `0.30`, so an ordinary out-of-lens connection now rests at `0.075` instead of `0.045`. The common multiplier also applies to tag filtering and missing-input connections/markers. No production cache, garbage-collection policy, layout algorithm, infrastructure, dependency, generated contract, or golden image changed. The optimization and security commits remain ancestors of main; the four deferred advisories were not addressed.

## Reproduction and classification

Read current AGENTS.md and the [optimization audit](optimization-audit-2026-11-06-01.md), then reproduced before editing. A detached control worktree at exactly `44cb758` used its own offline lockfile installation. Its environment files were copies of tracked public templates, matching the prior audit's synthetic inputs; no private environment files were copied.

The original seven affected test files reproduced **303 tests: 281 passed, 22 failed**, with no skipped or cancelled tests, and exited naturally after **686.60 seconds**. An initial reproduction without those template inputs also exposed environment-dependent fixture failures; that non-equivalent run is retained but is not the authoritative 22-failure comparison. The repaired snapshot suites now create and remove their own source-manifest fixture with public template inputs, independent of ignored/private checkout files.

Classification: **11 incomplete/incorrect setups; 7 stale assertions; 4 failures caused by one implementation defect; no unresolved in-scope design intent.** In the table, **F** is `corrected-fixtures.log` (320/320 passing), **L** is `layout-focus.log` (5/5 passing), and **V** is the final complete `npm run verify` receipt. All raw receipts live under `.framework/artifacts/studio-verification-2026-11-06/`; final gate results are recorded below.

| # | Original failing test | Cause / classification | Fix and evidence of intended behavior | Commit | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | every Studio test asserts through the bounded module | 1 — Incorrect assertion-helper import | `sightline-freshness.test.ts` imported `node:assert/strict` directly. Use the repository's bounded assertion module; preserve the guard. | `cde475e` | F, V |
| 2 | the card checks Docker before enabling the preview and its status follows it | 1 — Missing provider and obsolete prototype fixture | Mount Router, StudioProvider and QueryClientProvider; seed compatible deployment/profile/runtime state and model real local-start/local-stop operations. Runtime integration already exists in `868fcaf`. Retain state assertions and add exact operation/parameter checks. | `cde475e` | F, V |
| 3 | nothing moves before the first turn-on, and each turn-on plays the launch once | 1 — Same Compose setup defect | Same provider/runtime fixture; await completed start/stop transitions before replay assertions. Original animation/remount checks remain. | `cde475e` | F, V |
| 4 | with motion off the switch changes state without any animation | 1 — Same Compose setup defect | Same fixture; retain no-animation assertions with real asynchronous runtime state. | `cde475e` | F, V |
| 5 | starting Docker keeps the switch off until a separate click on the switch | 1 — Same Compose setup defect | Same fixture; retain dialog, focus and separate-start assertions, including Docker-start alone never starting application compute. | `cde475e` | F, V |
| 6 | Docker without Desktop offers manual instructions and a fresh check | 1 — Same Compose setup defect | Same fixture; retain manual instructions, no Desktop action, refresh and subsequent explicit runtime start. | `cde475e` | F, V |
| 7 | a failed Docker start stays off and can be retried | 1 — Same Compose setup defect | Same fixture; retain error, stopped state and retry checks. | `cde475e` | F, V |
| 8 | closing while detection is pending ignores the late response | 1 — Same Compose setup defect | Same fixture; retain the deferred response and dismissed-dialog assertion. | `cde475e` | F, V |
| 9 | a missing required value links from its connection straight to its open, focused row in CDK environment | 2 — Stale success-message assertion | `0c621b2` removed “Every required value is set”; `DeploymentInputs.tsx` hides resolved readiness warnings. Assert disappearance after entry and restoration after clearing, retaining focus and attention checks. | `cde475e` | F, V |
| 10 | header rename stages beside input settings and Escape restores only its opening names | 1 — Wrong input fixture | `5c8a445` made the application flag environment-linked. Use the existing `useStandaloneFlagFixture()` for the source-value editing scenario. Preserve rename, description, value and Escape assertions. | `cde475e` | F, V |
| 11 | an input group's hover counts its entries per graph and names what reads them and what they feed | 2 — Stale input count | `593646c` removed `client.apiUrl`. Current declarations contain apiPort, webSocketPort and webSocketTesterPort. Correct four to three; retain exact names and consumer checks. | `cde475e` | F, V |
| 12 | the composition objective prefers breathing room to legal but tightly packed islands, while bounding sprawl | 2 — Assertion contradicts documented objective | Guide and `layout-quality.ts` penalize long routes/unused space. Check compact route length/fill/cost, collision priority and sprawl cost. No layout source change. | `d73ac98` | L, V |
| 13 | the composition objective uses horizontal room according to the viewport rather than demanding the same shape everywhere | 2 — Assertion conflates aspect improvement with longer routes | Isolate viewport preference on disconnected islands; separately assert that connected expansion improves utilization but increases route length/cost. | `d73ac98` | L, V |
| 14 | preferred spacing responds to labels and connection density even before painted elements overlap | 2 — Nonexistent `LayoutQuality.crowding` contract | Assert the implemented left-flank title envelopes and angular congestion, including unchanged terrain bodies. No crowding field exists in source/history. | `d73ac98` | L, V |
| 15 | fresh compositions retain visible separation across sparse and dense topology and desktop aspects | 2 — Unsupported 84px median-gap contract | Preserve established 56px hard clearance, zero overlaps, all six sparse/dense/aspect fixtures and 720-evaluation bound. Replace unsupported median spacing with seed-quality, complete placement and integer/parity lattice checks. | `d73ac98` | L, V |
| 16 | new WebSocket creation labels its guarded handshake condition and retains Off | 2 — Stale source-symbol label | `d09a0b5` prefers `fromEnv` labels; `5c8a445` linked this flag to `ENABLE_WEB_SOCKET_API`. Assert that current label; retain lane restrictions and Off. | `cde475e` | F, V |
| 17 | missing required connections paint red X markers and clicking the marker selects its guidance | 1 — Viewport setup omitted intentional remembered camera | Camera persists between mounts since `fe7084c`. Invoke the existing Fit action before checking the visible marker; retain actual red paint, hit-testing and guidance assertions. | `cde475e` | F, V |
| 18 | the real renderer draws resting connections a little stronger, and those outside the viewed environment at a quarter of that | 3 — Wrong opacity multiplier | Restore `.25` per adjacent comment, rendering guide and unchanged tests. `c5d7c3f` introduced `.15` while retaining quarter-strength documentation. | `30358d0` | F, V |
| 19 | in Development the real renderer strokes the unbuilt VPC as one deck with a single violet rim | 1 — Viewport setup omitted intentional remembered camera | Explicit Fit makes the whole deck visible. Preserve rim paint and Development/Production topology assertions. | `cde475e` | F, V |
| 20 | every connection shares opacity and thickness across provenance, relationship types, environments and zoom | 3 — Same opacity defect | Shared multiplier corrected; original uniform-style assertions unchanged. | `30358d0` | F, V |
| 21 | a connection outside the viewed environment rests at a quarter of the strength it has inside it | 3 — Same opacity defect | Shared multiplier corrected; original direct quarter-strength assertion unchanged. | `30358d0` | F, V |
| 22 | an enabled connection reads clearly in its own view and recedes where it is disabled | 3 — Same opacity defect | Shared multiplier corrected; original environment-availability assertion unchanged. | `30358d0` | F, V |

The four original TS2339 diagnostics were `island-composition.test.ts(66,23)`, `(66,45)`, `(67,18)` and `(67,40)`: all four `.crowding` reads in failure 14. They are corrected by `d73ac98`, not by adding a fictional production property or suppressing TypeScript.

Layout intent was established before editing: `7dde794` introduced the compact graph-aware objective; `fc37eea` refined it; `a58faec` later added these tests without changing implementation or guidance. See [graph-layout Objective](../docs/framework-studio/graph-layout.md), `src/scene/layout-quality.ts` and `layout-shape.ts`. No established threshold was relaxed. The 84px median expectation was explicitly removed as an unsupported contract, not silently lowered. The separate determinism, reuse, pin and incremental stability test remains unchanged.

Opacity intent comes from [rendering](../docs/aws-studio-knowledge/studio/rendering.md) and [isometric view](../docs/framework-studio/isometric-view.md), as well as the source comment and surrounding renderer tests. No design decision is needed for the 22 original failures.

## Test-owned timers

`cde475e` tracks every QueryClient created by draft, isometric and WebSocket test mounts. Teardown unmounts consumers, cancels queries, then clears each owned client. Activity and Compose tests also cancel before clearing; their JSDOM windows close. Compose's mocked operation timers are individually tracked and cleared. Snapshot builders dispose before their exact owned fixture directories are removed, including failure paths.

This releases the query timers that survived unmount despite test-level `gcTime: 0` (individual production query options can set longer GC times). Production query configuration is unchanged. No forced process exit, global timer monkeypatch, Infinity GC override, skipped test, or reduced production cache lifetime was used. The authoritative baseline seven-file run took 686.60s; the corrected expanded nine-file run passed 320 tests and exited naturally in 84.31s. Those sets differ, so this is evidence of normal teardown, not a controlled performance benchmark.

## Verification receipts

Final main verification: **PASS**, exit 0 at code revision `30358d0da3c6f786d71980ecb32542d6f884a196`; see `verification-final.log`, `verification-final.json` and `verification-summary.json`. The report-only handoff commit does not change that tested code.

The root gate includes lockfile-platform verification, framework generation/local checks, ignored database-artifact generation, GraphQL codegen checks, every workspace typecheck and root scripts typecheck, the executable GraphQL schemas, and all workspace test scripts. The following later suites actually executed; they were not bypassed after typechecking:

| Offline suite | Main result |
| --- | --- |
| Executable GraphQL schemas | 23 passed |
| Client | 67 passed |
| Local API server | 20 passed |
| Local invocation runner | 27 passed |
| CDK application | 338 passed; 1 existing opt-in live PostgreSQL test skipped |
| Database package | 28 passed |
| Framework package | 527 passed |
| WebSocket tester | 4 passed |
| Studio | 1,669 passed; 4 existing conditional skips; zero failures |

These include both unit assertions and offline integration tests using child processes, reviewed source edits, rollback, fake CLI transports and mocked services; no separate integration total is claimed. Database-package checks are offline contract/schema checks, not live database verification. Browser, live database, dedicated synth and deployed checks are reported separately below.

Focused layout tests: **5/5 pass**. Expanded affected fixture/UI suites: **320/320 pass**, zero skips/cancellations, normal exit. The final full gate also covers the tiny failure-path fixture cleanup refinement made after that focused run.

The first complete gate attempt on the fix worktree used an unnecessary global `AWS_ENDPOINT_URL=http://127.0.0.1:9` in the external harness. A CDK SDK test with a custom mocked request handler failed URL construction after the CloudFront KeyValueStore endpoint resolver prepended the account to that numeric host. No AWS request occurred. Removing that harness override makes the complete `frontend-routing-handler.test.ts` pass. Application source and the SDK test were not changed. Final verification retains empty AWS configuration/credentials and disabled instance metadata without the endpoint override.

The knowledge checker passes: 36 Markdown files, 857 local links, 351 source references, 36 reachable pages. `git diff --check` passes. Protected-file comparison matches all 59 captured hashes: 36 goldens, 20 generated artifacts and package.json/package-lock.json/Dockerfile.dev.

## Browser checks and remaining limitation

The production-entry browser run exercised `map-editing`, `map-second-pass`, `input-source`, `cdk-environment` and `local-runtime` in Chromium light and dark: **106 passed, 4 failed**. It covers keyboard, narrow layouts, forms, loading/error/recovery and runtime state changes using explicit mock transports. This was a targeted browser run, not the entire cross-browser suite.

The four failures are the desktop and 380px inspector full-page screenshots, each in light and dark themes. Running those exact cases on unchanged `44cb758` reproduces all four failures. Each actual PNG is byte-for-byte identical between baseline and fixed source; `browser-baseline-comparison.json` records their SHA-256 values. Visual inspection shows pre-existing differences in the activity bar, local-runtime controls/status, environment indicators and resulting canvas geometry. These are not evidence of an opacity regression. No reference image or screenshot threshold was changed. The two desktop failures stop before their later source-review screenshot and accepted-write assertions; those later assertions are not reported as executed. The 380px cases end at their screenshot assertion.

Playwright MCP separately exercised the real Studio with a disposable public-template repository: Development/Production switching, Fit, environment connections, motion control, 1280px desktop and 390×844 mobile, and keyboard focus. Captures show no horizontal overflow. Chrome DevTools reproduced the scenario in its isolated session, found no console warnings/errors, and observed loopback API traffic only (initial cancelled requests were followed by successful responses). Its narrow viewport was 500px; the 390px evidence comes from Playwright. A temporary canvas stroke probe did not produce usable literal-alpha counts and is excluded as opacity evidence; the unchanged actual-renderer unit assertions provide that evidence. Browser sessions and the owned port-4591 server/workers were closed.

Browser evidence is retained under `output/playwright/studio-verification-2026-11-06/`; raw logs and the byte-identity comparison are under the receipt directory above. The browser result is **not green**. Resolving the existing screenshot drift requires separate visual-reference review; preserving the existing goldens and current established behavior leaves those four failures visible.

## Boundaries and handoff

No infrastructure behavior changed relative to the audited revision, so dedicated local/prod synth was not required or rerun. No AWS requests, database application, deployment, cloud teardown or push was performed. The user's later instruction authorized the local main fast-forward. Existing opt-in live tests remain opt-in; none was newly skipped. No additional dependency upgrades or deferred-advisory work occurred.

Final preservation checks retain the original checkout clean on `feature/studio-sightline` at `40d3cb2`, the audit worktree clean at `44cb758`, and the fix worktree clean at `30358d0`. Main contains the fixes plus this report. All 35 main workspace links resolve inside its own installation. All 59 protected hashes match after verification. The original Studio still listens on port 4590; task browser ports 4591/4592/4593 are free. Only owned temporary fixtures, template-input copies and browser services were removed. No existing user service, database volume, image, cache tree or private input was deleted. Worktrees and ignored evidence are retained for review.
