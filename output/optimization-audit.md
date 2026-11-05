# Monorepo optimization audit — November 5, 2026

Status: baseline captured; first workspace audits complete; implementation beginning. This report is updated during the work;
pending checks are not passes. Branch: `chore/monorepo-optimization-20261105`.

## Scope and controls

All 35 npm workspaces, root scripts/configuration, framework declarations, Docker
recipes and current documentation are in scope. Priorities are identical behavior,
readability, deletion, then measured speed. No dependency additions, AWS actions,
database actions, public framework vocabulary removals or historical evidence deletion.

The starting checkout has 40 pre-existing Studio source/test/documentation changes.
Their path/hash inventory and original diff are recorded privately under
`output/optimization/`. These files belong to another task and remain protected.
Port 4590 and the existing dev stack remain untouched; owned Studio checks use 4591.
Existing cache, state, environment files, image/volume data and goldens are retained.

Evidence scripts and raw logs are in `output/optimization/`; disposable browser
evidence is in `output/playwright/monorepo-optimization/`. Initial revision and status
are recorded before edits. Measurements include the existing working-tree changes.

## Ranked first-pass audit

| Priority | Candidate | Impact | Risk / decision |
| --- | --- | --- | --- |
| 1 | Unrouted Studio Board and exclusively owned helpers/tests | Remove a large obsolete view and reading/test burden | Prove transitive reachability first; retain shared styles/helpers and protected docs |
| 2 | Unused dependency declarations in app, handlers and local servers | Fewer declared dependencies; possibly less install output | Trace imports, scripts, Docker and package ownership; npm 11 only; preserve bundler pin/native records |
| 3 | Unreferenced client error component and obsolete internal Button options | Small, clear source deletion | Check all calls, routes, docs, test and string references; preserve rendered output |
| 4 | Framework, Studio projection/rendering and runtime repeated work | Potential runtime improvements | Existing caches/ordering are contracts; require exact-output proof and before/after measurements |
| 5 | Workspace build/test and Docker duplication | Potential faster development | Script output, ordering and declared interfaces constrain changes; no speculative concurrency |

These are candidates, not accepted changes. Read-only audits are running for Studio;
framework/CDK/agents; and app/data/local runtimes/root tooling. Each workspace will
receive a second pass after accepted changes to catch newly exposed dead code.

## Baseline

- Node `26.13.0`, npm `11.20.0`.
- 35 workspaces plus the root; 321 direct dependency declarations (including dev
  declarations), 1,331 lockfile package records.
- 190,600 tracked authored code lines (physical lines in TS/TSX/JS/JSX/CJS/MJS/CSS/
  Prisma/GraphQL/Python, including tests, excluding generated directories/route tree).
  Nested workspaces count separately, never twice. Final per-workspace table follows.
- Generated projection fingerprints recorded before verification (19 files, including
  ignored database output). Fresh build measurements pending; stale dist sizes are
  recorded for provenance but are not a build baseline.
- Initial sandboxed `npm run verify` failed before source checking because tsx could
  not open its local IPC socket (`EPERM`). Required gate rerun with native permission.
- Baseline verify fails on four existing `LayoutQuality.crowding` TypeScript errors
  in `framework-studio/test/island-composition.test.ts:66–67` (58.31 s). No test was
  changed. Fresh client, Studio and ws-tester builds pass (1.21 / 1.16 / 0.83 s).
  Offline normal-bundling synth passes: dev 5 stacks / 3.83 s, prod 11 stacks /
  9.87 s, through the real CDK entrypoint with synthetic inputs and no AWS calls.
  Startup on 4591: 4.80 s. Snapshot refresh: first 3598 ms, then 548 / 546 /
  526 ms. Baseline browser captures taken for live Studio and client preview.
  First synth attempt used an output inside its Docker source tree and recursively
  copied itself; the owned output was removed and the harness corrected to use /tmp.
  This was a measurement harness error, not an app change. No source edited yet.

## Changes by commit

`db5fc10` — Studio legacy removal: removes the unrouted Board/layout,
exclusive Board helpers and five tests, unused deployment Rail implementation, and
uncalled private helpers. 35 clean files, 1,006 net lines removed. Current editable
docs updated; historical evidence, goldens and all 40 protected files unchanged.
Studio build and knowledge check pass. Required verify repeats only the four
baseline TypeScript errors. Focused suite: 201 passed / 4 failed; the exact initial
tree independently reproduces all four failures. Generated artifacts are identical.
Browser checked empty search and Add menu open/Escape/focus return on port 4591.

## Verification ledger

| Category | Baseline | After / final |
| --- | --- | --- |
| `npm run verify` (unit, schema, mocked integration, types, generation drift) | Running | Pending |
| Generated artifacts, exact file hashes | Captured | Pending |
| Local and production synth, no AWS calls | Pending | Pending |
| Production client and Studio bundles | Pending | Pending |
| Studio and client browser main screens / keyboard / responsive | Pending | Pending |
| Knowledge links / source references | Pending | Pending |
| Live database, deployed AWS, Docker execution | Not run; excluded | Not run; excluded |

## Bugs found, intentionally not fixed

Baseline `npm run verify` fails: `island-composition.test.ts:66–67` expects the
`crowding` metric absent from `LayoutQuality`. The failing test and layout behavior
are retained. This blocks the requested green final gate without an out-of-scope fix.

## Needs human decision

- Studio route/snapshot/deployment/AWS connection source and several current guides
  contain pre-existing edits. Optimizations needing those files are deferred unless
  an independent change avoids them. The original status and fingerprints establish
  ownership; no edits from that task will be staged here.
- Framework public exports, convention-discovered entrypoints and compatibility
  surfaces require evidence beyond this application's callers; retain uncertain ones.
- Cross-request caching, lazy imports with effects, changed execution order, altered
  errors/logs/defaults and visual changes are outside this behavior-preserving pass.

Additional pre-existing focused failures, reproduced in an isolated copy of the
initial revision plus all protected edits: two draft-ui selectors (required-input
readiness and Value in development) and two landscape opacity expectations
(actual 0.045 versus expected 0.075). Tests and behavior remain unchanged.

`d096aff` — unused-source cleanup: removes unused client PageError,
Cognito schema types and GraphQL error predicate; unmounted tester ThemeToggle;
three unused private framework/CDK/GraphQL helpers, two internal types, obsolete
comment and unused imports. Replaces tester JSON validation with native JSON.parse
(the thrown error is discarded; 45-case acceptance equivalence passed). All existing
assertions unchanged. Client/Studio/tester builds pass; client 65, tester 4 and
GraphQL schema 22 tests pass. Verify repeats baseline TS2339 only. Both synths pass: 
dev templates are exact, prod differs only in two Docker asset image digests.
Generated files remain exact. Import-only edits emit byte-identical JS.
Tester JS: 437,746 -> 423,286 bytes; gzip 140,183 -> 132,113; CSS 16,671 -> 13,767.
Client built assets remain byte-identical. No startup/FPS speedup claimed.

Dependency cleanup (commit being recorded): 46 unused direct declarations across
19 manifests removed. npm 11.20 offline lockfile-only resolution removed 27 package
records (1,331 -> 1,304), added none and changed no retained version. All 128
OS/CPU/libc-specific records are byte-identical; root/CDK esbuild pins remain.
The running checkout node_modules is deliberately not replaced. Exact removal
ledger and lockfile proof are in output/optimization/. Required verify has only
the baseline TypeScript errors; both synths still match after normalizing only
container asset image digests. Generated files are unchanged.
