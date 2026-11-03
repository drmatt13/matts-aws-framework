# Repository maintainability audit — November 3, 2026

Start with the [product overview](../AWS-STUDIO.md) and
[source ownership map](../aws-studio-knowledge/REPOSITORY-MAP.md) for current architecture.
This dated record describes this cleanup and its evidence, not a new roadmap.

## Scope and preservation

The starting revision was `f96e5481218235c12d250316e93feb334f8d7c8b`, with two existing
deletions: `FRAMEWORK_STUDIO_ISOMETRIC_PHASE_PROMPT.md` and
`UNIFIED_AWS_FRAMEWORK_VISUAL_EDITOR_HANDOFF.md`. Neither was restored. There were no
initial untracked files. Independent audits covered Studio frontend, backend/source
editing, framework/runtime/infrastructure, manifests, examples, scripts and documentation.
The working plan was inventory → evidence-backed cleanup → focused checks → offline gate
and independent diff review.

Concurrent changes to `src/views/map/ComposePreview.tsx`, `src/styles/theme.css` and
`test/compose-preview-ui.test.ts` under `framework-studio/` appeared during verification.
They were preserved and are outside this cleanup. Verification describes that shared,
changing working tree; the Cognito comparison builds preceded those edits.

## Improvements

| Maintenance problem | Change and preserved boundary |
| --- | --- |
| Large Cognito route mixed orchestration and read-only evidence | Extracted three existing components and their class recipes into [AuthenticationEvidence.tsx](../../framework-studio/src/views/AuthenticationEvidence.tsx). The route retains state, effects, requests, approvals, keys and mount positions; moved component bodies are unchanged. |
| Two literal metadata readers repeated the same AST scan | Added [source/string-map.ts](../../framework-studio/server/source/string-map.ts), retaining separate description/display-name validation, public wrappers, error text, null-prototype maps and original AST nodes/offsets. Reused the exactly equivalent existing `unwrap` in stateful source editing. |
| Source-editable Agent Lab message caused TS2367 after a reviewed edit | Widened only its comparison with an erased type assertion. Emitted JavaScript is equivalent; the fixed declaration format recognized by the source writer remains untouched. |
| Local server configs buried active options in compiler-template comments | Removed inactive boilerplate from two tsconfigs. TypeScript-parsed configuration and resolved compiler options remain identical. |
| Startup/diagnostic comments described retired workflows | Corrected Compose, database identity CLI and runner comments. Parsed Compose and emitted executable JavaScript remain identical. |
| Missing ownership guidance and broken historical references | Expanded the existing source map with UI/style/import/test/generator ownership; repaired seven links to the already-deleted briefs; corrected source-input status and labeled old architecture artwork as historical. |

## Removals and retained candidates

Removed `local-api-dev-server/events/websocketEvents.ts`: 123 lines of static, masked
example payloads with no consumers in imports, scripts, documentation, package entry
points or discovery. HTTP dispatch uses normalized declarations; the active WebSocket
event factories remain in `local-ws-dev-server/events/websocketEvents.ts`. This was
obsolete example data, not a duplicate of those factories.

Removed 365 ignored `.playwright-mcp/console-*.log` and `page-*.yml` captures totaling
5,167,096 bytes. These are tool-generated disposable output under the
[hygiene policy](../REPOSITORY-HYGIENE.md), with no maintained consumers or open files.
An exact path/size/mtime/hash manifest was recorded and rechecked before removal;
captures created during this task were excluded. No screenshot baseline, reusable
test, fixture, source copy, environment file, recovery journal or deployment state was removed.

Retained deliberately: the unrouted Board used by the browser gallery; compatibility
re-exports and CLI aliases with consumers/tests; child-process shims and CDK bundle
entries addressed by file paths; parsers accepting deliberately different expression
shapes; source-only reference examples; migration history, fonts/icons/licenses and
historical evidence. Mixed `.cache/` and `.framework/` trees remain protected.

Apparently unused dependency declarations/pins and old lockfile workspace paths need
clean-install/tooling evidence before removal. Manifests and the lockfile were unchanged.
Splitting the large framework normalization module remains a separate task requiring
public-export, bundle and identity characterization; no infrastructure declarations,
construct identities or generated contracts changed here.

## Verification

| Evidence | Result |
| --- | --- |
| Baseline framework check and lockfile platform check | Passed; initial sandbox IPC restriction resolved by running the same offline command with local-process permissions. |
| Local API/WebSocket typechecks; API tests | Passed; 16 API tests. |
| Metadata differential comparison | 66 accepted/refused cases matched original outputs, diagnostics and source-node properties. |
| Focused metadata/stateful and disposable source transactions | 28 passed, including read → review → apply, stale-source refusal and rollback. Three characterization tests were added. |
| Cognito DOM; Agent Lab | 15 Cognito tests passed before and after extraction; 16 Agent Lab tests passed. |
| Production and browser-gallery builds | Passed. |
| Cognito browser suite | 2 passed, 4 screenshot failures; an isolated original-component build reproduced all four. Provider actual images were byte-identical; management actuals differed at 3 dark/15 light edge pixels, with all 16 measured DOM geometry/style entries identical. Goldens were not changed. |
| Playwright MCP / Chrome DevTools | Desktop light and 420px dark, unverified/populated evidence, keyboard navigation/disclosure and independent table scrolling checked; no page overflow, console errors/warnings or failed fixture requests. Owned sessions/previews closed. |
| `npm run verify` | Stopped at existing graph-test type errors described below. Lockfile/framework checks, database artifact emission and GraphQL generation check passed. |
| Remaining offline gate stages | Schema: 23 passed. Root script typecheck passed separately. Complete workspace run: 2,272 passed, 22 failed, 3 skipped; breakdown below. |
| Documentation and final diff | All 116 Markdown files reachable, 1,572 local links and 71 heading references passed; wiki 36 pages/822 links/264 source references and 11 checker fixtures passed. Whitespace check passed. Independent reviews found no behavior change in the cleanup. |

Workspace results: client 67 passed; API 16; runner 27; CDK 320 passed/1 failed/1 skipped;
database 28; framework 525; WebSocket tester 4; Studio 1,285 passed/21 failed/2 skipped.
Including the separate schema run gives **2,295 passed, 22 failed, 3 skipped**. The
failures below were retained; this is not a passing integrated gate. Final fingerprints
confirmed all 36 reviewed visual baselines and protected committed generated outputs,
manifests, lockfile and declaration composition remained unchanged. Only the original
Studio listener remained after owned tests and browser previews closed.

Browser, unit/fixture integration, full application synthesis, Docker, live database
and deployed checks are separate evidence categories. No full application synth,
Docker lifecycle, live database or AWS/deployed operation was performed. Compose
comments were verified by parsed-data equivalence, not a container run.

## Functional issues deferred

- [island-composition.test.ts](../../framework-studio/test/island-composition.test.ts)
  references `LayoutQuality.crowding`, absent from the current interface and evaluator.
  Both files match HEAD. Correcting the graph objective/test contract requires a
  behavior decision; no assertion was removed or weakened.
- The simulated `--create-secrets` deployment test fails when describing an absent
  secret. A focused rerun reproduces it. The existing network-error regex matches
  `ENOTFOUND` inside `ResourceNotFoundException` without word boundaries, so the CLI
  adapter reports a generic failure instead of absence. The relevant scripts/tests
  match HEAD; error handling was left unchanged.
- Six Studio deployment-service failures reproduce separately: two stop at the same
  simulated secret lookup, and four depend on the missing plans, exports or jobs.
- Unchanged inspector tests expect a readiness row after it has intentionally been
  removed, and an older enum-control label. Other unchanged graph/UI assertions expect
  four client inputs instead of three, a catalog key instead of its environment name,
  older spacing objectives, or quarter-strength connections instead of the current
  `0.15` multiplier. Focused reruns reproduce these mismatches; changing the assertions
  or behavior was outside this cleanup.
- The primary-navigation test still expects seven links; the unchanged shell includes
  the additional **Agent test** experiment. Current navigation documentation now links
  that bounded experiment explicitly.
- Required-connection-marker and VPC-rim checks failed in the full suite but passed
  focused reruns. Their full-suite failure cause remains unresolved; source/test files
  match HEAD, and the concurrent Compose theme edits do not control canvas rendering.
- Existing Cognito golden drift reproduces with the original module. Snapshot
  approval or a visual change is separate work.

Temporary manifests and logs are under `/tmp/aws-studio-maintainability-20261103-y03l1pdm/`
and `/tmp/aws-studio-*-20261103.log`; browser comparison evidence is under ignored
`output/playwright/maintainability-audit/`. These are local receipts, not durable
repository inputs. No commit, push, migration application or deployment was performed.
