# AWS Studio maintainability campaign — October 30, 2026

This is the audit, execution checklist and evidence record for the architecture
stabilization campaign. Current architecture belongs in the [knowledge router](../aws-studio-knowledge/README.md)
and its canonical subsystem pages; this dated record explains what changed and why.

## Baseline and preservation

The starting revision is `a33453f29a7ae110d2d0987b0f90405df39dcba4`, with 45
pre-existing modified files and additional naming implementation/tests. The current
working tree, rather than HEAD alone, is the behavioral baseline. Existing source
editing, naming continuity, infrastructure and documentation changes must survive.

The local baseline under `.framework/artifacts/studio-maintainability-2026-10-30/baseline/`
contains the original status, patch and SHA-256 manifest plus copies of 567 authored
source/test/documentation files. Environment files, credentials, generated database
artifacts and dependencies are excluded. These ignored artifacts support local review;
the canonical campaign facts and verification results are recorded here.

Planning checks passed Studio typechecking/build, the documentation checkers, 122
Inspector draft tests, four command tests and ten deployment-service fixture tests.
The earlier aggregate unit attempt was interrupted by sandbox IPC/listener restrictions;
four frontend-release failures were unclassified. That attempt is not a passing baseline.
Read-only map/Inspector inspection captured desktop and 390px states and confirmed
keyboard return to Resources, without console errors or document overflow. The formal
fixture visual baseline and complete offline verification are being established now.

## Architecture inventory

| Surface | Entry / ownership | State and integration boundary |
| --- | --- | --- |
| Shared application | `src/main.tsx`, `src/studio.tsx`, `src/views/Shell.tsx` | Router selection, accepted draft baseline, source mode, shared stream, toasts and health |
| Map `/` | `src/views/Isometric.tsx`, `src/scene/` | Derived scene, camera/gesture/hover state, Resources panel and Inspector |
| Database `/database` | `src/views/Database.tsx`, `src/database-session.ts` | Independent exact-text Prisma session; explicit database target and approvals |
| Deploy `/deploy` | `src/views/Deploy.tsx`, `src/views/deploy/`, `src/deploy/` | Named target/profile/account/region, query evidence, reviewed operations and log store |
| GraphQL `/graphql` | `src/views/GraphQL.tsx` | Existing placeholder, retained as such |
| Authentication `/cognito` | `src/views/AuthenticationWorkspace.tsx` | Four persistently mounted subsections, context-keyed observations and source draft |
| Domains `/domains` | `src/views/IdentityWorkspace.tsx` (baseline name) | Production input intent, explicit inspection and separately reviewed domain operations |
| WebSockets `/websockets` | `src/views/websockets/` | Two explicit connection/message sessions; no automatic runtime actions |
| Retained Board | `src/views/Board.tsx`, `src/layout.ts` | Unrouted implementation, retained in test gallery |
| Inspector | `src/views/Inspector.tsx` and specialized editors | Entity dispatch, relationship traversal, per-visit/per-mode presentation and shared draft |
| Shared presentation | `src/ui/`, `InspectorUI`, `FieldRow`, `DocumentUI`, `WorkbenchUI`, `WorkspacePanel`, `NavigationStrip` | Native controls, existing recipes/tokens, workflow-specific focus and modal policies |
| Browser integration | `src/api.ts`, `src/events.ts`, `src/deploy/api.ts`, `src/identity-api.ts` | Token/protocol transport, query evidence, reference-counted EventSource and explicit operations |
| Backend authority | `server/snapshot.ts`, `server/edits/`, operational services | Evaluated declarations, bounded review/apply, source journal and distinct operational approvals |

The configuration lifecycle remains declaration → evaluated snapshot → staged draft →
server review → guarded apply → rebuilt snapshot/event invalidation. A dirty draft
retains its visible baseline and records new source as a conflict. Scene/view state
never becomes another configuration authority. Private environment values remain
outside graph snapshots and use their separate review path.

## Evidence-based audit

Severity below describes maintainability, not a claim of a runtime vulnerability.

| Finding and source anchor at baseline | Severity | Regression risk / selected remedy |
| --- | --- | --- |
| `views/Inspector.tsx:118–428` combines unrelated entity families | Medium | Low: move existing component boundaries into three cohesive modules, preserving DOM/keys |
| `views/Triggers.tsx:52–1123` combines form coordination, setup steps and field dispatch | High | Medium: characterize undercovered inputs, retain parent state and extract rendering |
| `views/Isometric.tsx:98–932` combines workspace composition and sensitive Canvas lifecycles | High | Extract toolbar/navigator only; lifecycle restructuring remains deferred |
| `draft.ts:439–470` produces only batch/environment reviews but retains a resource-only arm | Medium | Low: remove unreachable frontend transport/UI, retaining server compatibility APIs |
| `draft.ts:328–349,441–460` mixes pure transformations with session coordination | Medium | Low–medium: explicit pure resource normalization and request conversion helpers |
| Repeated source/context retry notices and identical source-edit gates | Medium | Low: share only equivalent behavior; retain caller-specific restrictions |
| `api.ts:28–143` and `deploy/api.ts:23–100` mix transport, hooks and streams | Medium | Low–medium: separate HTTP, query identity and subscription ownership |
| Repeated overview/identity-source query definitions across operational pages | Medium | Low: share key/fetch definitions without changing observer policies |
| `scene/build.ts:52–179` hides scene contracts inside construction | Medium | Low: type-only separation, preserving existing type exports |
| Duplicate path envelopes in Isometric/render despite `layout-geometry.pathBounds` | Low | Low: reuse the existing helper without altering geometry or tolerances |
| `inspector-navigation.ts:131–163` restores child-index DOM paths | Medium | High for DOM changes: preserve structure and verify browser history/focus |
| Parent presentation recipes intentionally style descendants | Medium | Preserve exact selectors/specificity and markup; document ownership |

The scene engine already has deterministic bounded layout, cached vector rendering,
coalesced hover and an accessible navigator. The design system already has four CSS
owners and reusable native primitives. Neither needs a replacement framework.

## Execution checklist and batch records

Each batch records exact affected files, preserved contracts, focused validation and
diff review before it is marked complete. Independent review follows the Inspector/
trigger and map/integration changes. Source implementation waits for the baseline.

- [x] Baseline: complete offline checks, classify prior failures, capture fixture visuals.
- [x] Draft contract: remove dead frontend review and extract pure transformations.
- [x] Inspector: separate workload, resource and relationship ownership.
- [x] Triggers: characterize inputs, then extract setup/field rendering.
- [x] Shared behavior: equivalent retry notices and common source-edit gate.
- [x] Integration: HTTP/query/live ownership, Domains filename and dependency guard.
- [x] Map: scene contracts, existing bounds helper, toolbar and navigator.
- [x] Documentation: canonical ownership/state/styling/extension guidance.
- [x] Final integration: required gates, visual/keyboard review, independent diff review.

### Baseline — complete

The complete baseline used permissions for fixture IPC/listeners and existing
offline/mocked authorities. Studio passed 1,144 tests with two explicit live-database
skips. The four previously unclassified frontend-release cases passed. Other clean
suites covered schema, client, local API, runner, database, framework and WebSocket
tester. One CDK assertion hit ENOENT while scanning a browser artifact directory
that the parallel browser runner removed; its isolated startup-secrets rerun passed
4/4. The original aggregate exit remains recorded as 1, not silently relabeled.
Final offline/browser checks run sequentially to avoid this artifact-walk race.

The original browser-reference run completed **123 passed / 31 failed**: 26 stale
screenshot failures, four obsolete `/resources/plan` test assertions, and one WebKit
host crash before page launch (`Bus error: 10`). The old Inspector captures omit the
now-existing GraphQL navigation and reflect earlier controls/section ordering;
these are pre-existing reference age, not nondeterministic Canvas noise. The input
tests must inspect the existing batch `resourceConfig` intent instead; their value
and private-input assertions remain applicable.

After inspecting those differences, a separate current-tree capture passed all 28
screenshot-bearing Chromium cases and wrote 36 light/dark reference images. Original
checked-in references were retained. The ignored campaign directory contains frozen
app/gallery builds, original results/report/logs, `references-sha256.json` and
`playwright-campaign.config.ts`. That config compares subsequent runs with these
current references, disables snapshot updates and enables the Chromium sandbox.

### Implemented batches and review

Implementation was prepared in isolated temporary trees while original-source
verification finished, then integrated after checking protected file hashes. Only
explicit manifest files were copied. Root's manifest and the original-source
fingerprints are in the ignored campaign artifacts; source changes stay visible
as ordinary repository diffs alongside the preserved pre-existing work.

| Batch | Exact ownership / structure | Staged evidence |
| --- | --- | --- |
| Draft | `draft.ts`, new `draft-entries.ts`, `studio.tsx`, `EditDialog.tsx`, removed unused API methods and corresponding test mocks; browser input assertions follow batch `resourceConfig` | 29 draft and 93 draft-UI tests pass; existing output/error ordering retained |
| Inspector / triggers | `Inspector.tsx`, `Triggers.tsx`, three `views/inspector/` modules, three `views/inspector/triggers/` modules and `trigger-ui.test.ts` | Browser typecheck; 6 characterization cases pass both before and after extraction; 17 Inspector function bodies identical |
| Map | `scene/types.ts`, build type exports, scene type consumers, `render.ts`, `Isometric.tsx`, `views/map/MapToolbar.tsx` and `MapEntityNavigator.tsx` | 211 focused tests pass; browser typecheck; 11 type/import changes emit identical JS |
| Integration / shared UI | New `http.ts`, `snapshot.ts`, `editing-state.ts`, `identity-queries.ts`, `deploy/live.ts`, `deploy/queries.ts`, `RetryNotice.tsx`; endpoint catalogs/callers; Domains filename and test imports | HTTP and dependency guard: 5 tests pass; authentication/deployment/domain UI checks pass in the staged run |

Independent reviews found no map DOM/class/key/callback drift and no draft/transport/
query behavior drift. A separate trigger review verified component identity, keyed
fields, source/settings/confirmation transitions, focus and equivalent gating. The
trigger state owner is 468 lines and Inspector's dispatch/lifecycle entry 85 lines.
The integrated draft/trigger suites pass 128/128. Browser/server typechecks and the
knowledge/link checks pass. No framework/server/shared source, manifest or lockfile
differs from its protected starting bytes because of this campaign.

### Visual baseline review and promotion

The integrated browser run passed 153 cases across Chromium light/dark and Firefox,
with all 36 frozen pre-refactor references unchanged and no visual diffs. WebKit
repeated its baseline host binary `Bus error: 10` before loading an application page.
All four input-source/creator workflows pass with their batch-intent assertions.
Live Playwright/DevTools checks confirmed Inspector selection, 390px containment,
one source selector, keyboard return to the originating Resources row, clean console
and successful snapshot requests. All owned browser sessions/previews were closed.

Root and an independent reviewer inspected all 36 captured states (plus full-size
dialog, control and narrow-map cases). After the refactored app matched them, the exact
frozen-before bytes were manually promoted to the normal snapshot paths: 34 stale
references changed and two already-identical control references stayed unchanged.
No snapshot was generated from refactored output or accepted to conceal a difference;
comparison settings and the narrow existing accessibility exception remain unchanged.
The normal browser config now explicitly enables Chromium's sandbox.

The protected pre-refactor browser-source fingerprint is
`f40520d1eb472255b85cc7e22e4eec38e4a440e328846c3e69b98be2fc3676e0`.
The local `reference-promotion.json`, `references-sha256.json` and browser receipts
record individual source/reference hashes and provenance.
The production entry CSS is byte-identical to the frozen pre-refactor build
(`index-ip53jEaF.css`). Bundle-size warnings remain profiling targets; this campaign
does not claim an FPS or loading-time improvement.

## Deferred debt and stable extension boundaries

| Recommendation | Why it is deferred / evidence needed |
| --- | --- |
| Replace Inspector navigation transition bookkeeping | Render-time alias/history continuity and DOM presentation restoration need their own characterized design |
| Extract camera/renderer/gesture lifecycle controller | Empty-graph recovery, before-paint resize, RAF cleanup, aspect debounce and rename continuity are tightly coupled |
| Split broad Studio context or memoize graph selectors | Profile actual commits/recomputation first; broad subscriptions alone do not establish a defect |
| Further split large entry/Database bundles | Build warnings are evidence of size, not interaction cost; preserve mounted draft/editor lifecycle |
| Restructure backend planning/transactions | Operation-specific identity, source allowlists, hashes and rollback safeguards are intentional |
| Unify dialog/tooltip implementations | Similar markup conceals different focus, cancellation, measurement and portal policies |
| Worker layout / bitmap caching | Requires separate cancellation/loading or pixel-equivalence evidence; existing algorithms remain authoritative |

New UI should compose existing primitives and feature modules. New data/operation
capabilities must extend the existing typed contract and owning server service;
rendering code cannot assume source-save approval authorizes deployment, database,
identity, DNS or release operations. No external API, framework DSL, persistence,
resource relationship or deployment behavior changes are part of this campaign.

## Verification receipts and handoff

The final complete `npm run verify` passed with exit 0: **2,121 passed, 0 failed,
3 intentional live-test skips** across 2,124 tests. The final run was exclusive
of browser cleanup, and the earlier artifact-walk race did not recur. No test or
comparison tolerance was weakened. The added boundary test also distinguishes
empty executable import/export clauses from actual type-only contracts.

| Verification category | Actual result / limit |
| --- | --- |
| Unit / workspace gates | Lockfile, framework/generated and GraphQL checks, all workspace typechecks and schema suites passed. Studio: **1,154 passed, 2 skipped, 0 failed** (1,156 tests); framework: 513 passed |
| Offline integration / CDK | **292 passed, 1 intentional persistence skip, 0 failed**. Mocked source, generator, lifecycle and synthesis fixtures passed; no real AWS/Docker operation was used |
| Focused integrated Inspector / triggers | **128/128 passed**; added trigger characterization passed before and after extraction |
| Browser / visual / accessibility | **153 passed, 1 pre-existing host failure**. All Chromium light/dark and Firefox checks passed; 36 pre-refactor references matched without diffs. WebKit remains unverified because its cached binary exits with Bus error 10 before page launch |
| Production build / styles | Studio production app and isolated gallery builds passed through browser verification. Production entry CSS is byte-identical to baseline; existing large-chunk warnings remain |
| Documentation | Knowledge check: 36 pages, 769 local links, 251 source references. Repository links: 114 Markdown files, 1,487 local links, 66 heading references; all passed |
| Database | Database unit suite passed 28/28 and ignored Prisma artifacts regenerated through the prescribed gate. Two live Studio database cases explicitly skipped; no live database operation or migration application |
| Application synth / deployed checks | No campaign infrastructure change; full application dev/prod synthesis, deployment, live cloud verification and Docker lifecycle checks were not performed |

The final receipts and full logs are under the ignored campaign artifact directory.
The later [repository hygiene pass](../REPOSITORY-HYGIENE.md) pruned duplicate preview
builds, raw browser reports/results, contact sheets, duplicate reference copies and
one-off preview adapters. Baseline source copies, patches, hashes, receipts and logs
remain. Use the normal browser configuration and tracked golden images for future
regressions; the old temporary campaign preview configuration is no longer retained.
Fifteen existing TanStack CommonJS `replaceRouteChunk` circular-dependency warnings
remain visible in the final log; no warning or assertion was suppressed.
`campaign-source.patch` separates campaign text changes from pre-existing working-tree
work. Protected backend/shared/framework patches and package manifests were compared
with the starting snapshot and retained. No infrastructure mutation, deployment,
publication, push or merge was performed.

For ongoing work, use the [source ownership map](../aws-studio-knowledge/REPOSITORY-MAP.md#where-to-change-studio)
to locate rendering/state/transport/tests, the [interface guide](../aws-studio-knowledge/studio/interface.md)
for route and state ownership, [editing](../aws-studio-knowledge/studio/editing.md) for
Inspector transactions, [rendering](../aws-studio-knowledge/studio/rendering.md) for
map boundaries, and the [design system](ui-design-system.md) for shared controls and
styling isolation. Deferred items above remain recommendations, not unreported
implementation work or implied authorization for later operational changes.
