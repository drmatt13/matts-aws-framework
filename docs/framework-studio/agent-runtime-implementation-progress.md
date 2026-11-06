# Actionable agent runtime implementation

## Objective and safety boundary

Implement milestones M0–M6 of the final architecture decision: native Codex/Claude
coding in private copies of saved source, durable independent tasks, immutable
review and explicitly approved integration, recovery, self-modification,
Sightline/architecture previews, and bounded concurrency.

The existing dirty checkout and Studio on port 4590 are preserved. Runtime tests
use disposable projects/instances. Approval is simulated only in disposable
tests. No deployment, live database migration, production mutation, or credential
copying is authorized by this implementation. Native restrictions must fail
closed; a private workspace alone is not a sandbox.

## Status — 2026-11-06

Implementation resumed against the full M0–M6 goal. The intervening architecture
review is complete; the latest goal continuation explicitly authorizes implementation.
The user also explicitly authorized disposable native CLI probes with saved login.
The earlier automatic-approval restriction on those probes is resolved.

| Milestone | State | Evidence / remaining work |
| --- | --- | --- |
| M0 Native execution proof | Passed on this macOS host | Codex repaired a test in current saved monorepo/private dependencies; linked package execution passed. Both providers passed fake credential/network/process/filesystem sentinels. Linux remains unverified here; every task must pass its native boundary probe. |
| M1 Complete coding path | Passed disposable acceptance | Real browser → native Codex → two-file diff → independent validation → explicit fixture approval → source import → graph revision/route refresh. Detached state survived fixture restart. |
| M2 Recovery/evaluation | Passed focused and native checks | Journaled restoration/conflicts, source gate/publication, restricted live evaluation and dependency-bound import. Native full source projection succeeded in both modes. |
| M3 Claude/capabilities | Passed on this macOS host | Native Claude uses only its in-process MCP shell bridge; commands execute through model-free Codex sandbox. Repair, independent validation, same-session resume and cancellation passed. |
| M4 Self-modification | Passed bounded disposable acceptance | Final26/26 host/recovery checks cover corrected-source replacement, durable launch ownership, retained-release reconnect and preserved tasks/approvals. The real relocated Studio server also restarted to a new PID/nonce/version and retained tasks through intentional startup failure. Full copied Studio build activation is not claimed. |
| M5 Context/architecture | Passed focused and native checks | Inspectable Sightline input, trusted structured handoff and frozen semantic previews; native preview6/6 and actual full-copy framework checks pass. |
| M6 Concurrency/conflicts | Passed focused checks | Bounded tasks, serial imports, three-way preparation/fresh approval and terminal cleanup tests passed. |

## Implementation ownership

- Workspace capture/manifests/private dependencies: `server/agent-runtime/workspace.ts`.
- Shared source-write gate and importer: `server/edits/source-gate.ts`, `server/agent-runtime/integration.ts`.
- Native provider adapters and policy: `server/agent-runtime/providers/`, `policy.ts`.
- Task protocol, persistence, host/client/API and UI integration: primary implementation.

## Test log

- Baseline: inspected current Git status and source; substantial pre-existing dirty
  and untracked work is present and retained.
- Earlier focused implementation runs: task store 7/7, workspace 5/5,
  importer 8/8, provider transport/policy 7/7, workspace/presentation 8/8.
  These are narrow fixture results, not an integrated product acceptance result.
- Authorized native Codex probe: initial policy failed closed before assertions
  because Homebrew Node v26.13.0 requires shared libraries, symlink metadata and
  OpenSSL configuration. Disposable in-memory runtime-library permissions plus
  `OPENSSL_CONF=/dev/null` allowed the probe to execute. No repository policy was
  changed during the investigation; production toolchain policy must now be fixed.
- Adjusted native command boundary passed: sibling read/write, symlink escape,
  descendant read, localhost TCP, Unix socket and unrelated disposable process
  signalling were denied. This does not prove all tool routes or platforms.
- Real Codex app-server native turn passed in an ordinary non-Git fixture:
  `node --test math.test.cjs` exited 1; native edit changed subtraction to addition;
  unchanged test then exited 0 (one pass); structured command/file/message events
  streamed and final source/test bytes were independently read.
- Fixture: `/private/var/folders/t7/98l6_10s48jf_mt2b99pjyvm0000gn/T/studio-review-probe-bGBJ8p`.
- Full repository verification, browser coding acceptance, Claude inference,
  live graph integration and restart acceptance remain unverified.
- Task store/service: 12/12 focused tests passed, including current dirty/untracked
  source capture, immutable proposal bytes, explicit approval, failed validation,
  stale baseline rejection, cancellation/resume and restored-import outcomes.
- Detached host: 2/2 actual child-process tests passed. Observer reconnect retains
  the host PID; exact approval imports disposable source; host restart replays
  durable state; SIGKILL during a task marks it interrupted and requires resume.
- Coding UI browser fixtures: 5/5 Chromium tests passed at desktop and mobile
  widths, including keyboard tabs, diff/approval/reload, cancellation, validation
  failure, rejection and retry. Backend responses were mocked; this is UI evidence,
  not yet real provider-to-import acceptance.
- Provider/toolchain work still fails closed on a Homebrew llhttp dylib alias in
  the narrow production policy. A trusted canonical-library-path experiment is
  next; no broad host filesystem permission is being assumed safe.
- The source gate now shares SQLite ownership/recovery across Studio writers;
  importer tests include guarded restoration, dead-owner takeover and explicit
  keep-current recovery. External editors and persistent Compose/Vite observers
  are outside this cooperative gate and may still observe filesystem batches.
- Production Codex library policy now passes the native macOS sentinels using
  host-owned, read-only Node/npm launchers and audited canonical dynamic-library
  paths. It does not grant the entire Homebrew prefix.
- Actual saved-project probe captured 2,346 source files (including dirty and
  untracked work) and private dependencies. Native Codex observed the failing
  math test, edited the isolated source, and independent sandboxed validation
  passed that test. Two copied source-diff tests also passed; the third failed
  because its Git subprocess could not start under the restricted tool policy.
  The real source digest remained unchanged. This is partial M0 evidence;
  explicit linked framework-package execution remains to be checked.
- Retained actual-project fixture:
  `/private/var/folders/t7/98l6_10s48jf_mt2b99pjyvm0000gn/T/studio-native-agent-probe-LEQWEz`.
- Native restricted architecture preview: 5/5 tests passed, including denied
  frozen-source writes and outside sentinel reads in both modes; compatible
  framework self-edits used each revision's own framework singleton.
- Native Claude preflight failed without editing its source. The production
  Claude coding adapter remains disabled until that boundary is demonstrated.
- Current task/host/store tests: 14/14 passed. Three candidate-refresh tests
  passed: clean same-file three-way merge, overlapping/new-path conflict, and
  renewed validation with old-approval rejection. Git merge-file is used solely
  as a bounded text algorithm over private files; no refs/index are involved.
- Backend typecheck still reports only the existing LayoutQuality.crowding test
  errors at island-composition.test.ts:66–67. Frontend typecheck passed.
- Large-project cost measured: one full installed-dependency hash takes about
  34 seconds; eliminating redundant passes and using bounded parallel reads is
  underway without substituting timestamps for byte verification.
- Follow-up M0 native validation on the same retained actual-project copy passed
  2/2: math repair and deployment-availability, which imports the copied linked
  `@repo/framework/config` package. The earlier Git-dependent check remains a
  documented unavailable capability, not a passed test.
- Model-free Codex command execution with an isolated configuration home passed
  native sentinels without copying or using saved authentication.
- Pinned runtime release test passed: the bundled host starts outside source with
  no checkout TypeScript loader or node_modules dependency, and modified release
  bytes are rejected. Managed Studio restart is still outstanding.
- M6 concurrency/cleanup tests passed 2/2: two bounded parallel executions,
  serialized approvals with a stale second candidate rejected, terminal-only
  private-file cleanup retaining review evidence, and bounded replay pages.
- Actual browser acceptance on owned port4594 reached a real two-file Codex diff
  and ready architecture preview. Independent npm validation failed, so approval
  stayed disabled. The cause was sandboxed npm shell resolution; a canonical
  system-shell launcher fixed it and the same candidate subsequently passed
  independent npm validation. Restarting only that fixture to verify retained
  state and renewed validation is in progress; no import acceptance claimed yet.
- Updated mocked-backend UI suite: 7/7 Chromium tests passed, including typed
  recovery and exact-digest candidate refresh. New validation/cleanup UI adds an
  eighth case which remains to be run.
- Restricted live evaluation after an agent import is being implemented with a
  durable marker and sanitized source capture. It must never fall back to the
  privileged legacy evaluator. Large streaming results exposed a transport issue;
  finite bounded evaluation commands are replacing that unnecessary streaming path.
- Native Claude now reaches the explicit host permission bridge but its shell
  preflight still aborts under the restricted filesystem policy; coding remains
  disabled. Codex user MCP configuration merge behavior is also being audited
  before admitting further model turns; empty configuration tables are not assumed
  to disable existing integrations.

- Real native browser acceptance completed on disposable port 4594: retained task
  `b253d873-0c02-49be-87db-258a41ded9dc` survived backend/host restart, renewed
  validation passed, explicit fixture approval imported exactly math.cjs and its
  declaration route, and graph revision changed to `2-12f6a1906ce2` with `/sum`.
  Evidence is under `output/playwright/agent-native/`. Owned instances were closed.
- UI browser report: 11/11 expected, zero unexpected/flaky/skipped. Chrome
  inspection showed no console warnings/errors after reload; two earlier transient
  504 observer requests recovered and remain a reliability follow-up.
- Native Claude SDK MCP bridge passed real failed-test → edit → passing-test and
  independent validation in `studio-native-agent-probe-Y0ln36`. Only
  `mcp__studio_shell__run` was enabled. Native Bash and file tools stay disabled;
  command restrictions are enforced by model-free Codex execution.
- Codex effective MCP configuration is audited and process-locally disabled before
  model work; a native turn passed that gate. Empty config tables are not sufficient.
- Approved dependency admission tests 4/4 and importer tests 10/10 passed; corrected
  source-lock/snapshot recovery tests 6/6 passed. Installed dependency identity is
  checked around import, without privileged execution of candidate scripts.
- Managed activation tests 2/2 passed on disposable control planes. Review found
  and fixed a source lease race during restart; multi-process provider ownership is
  now retained until each execution phase has closed all tethers.
- Full verification initially stopped at sandboxed tsx socket creation. Automatic
  approval review then applied the obsolete read-only restriction. The user
  explicitly authorized repository verification; that run is now in progress.
- Knowledge checker passed: 36 pages, 857 links, 351 source references. General
  documentation link checker still reports 50 existing temp_report path:line links.

- Native Codex effective-config gate and independent validation passed in
  `studio-native-agent-probe-HOXmCk`; the model's final claim alone was not used
  as validation evidence.
- Native Claude resumed session `1bbba72a-bdfd-475b-9d41-b98a072cbd06` without
  source changes. Cancellation initially exposed a paused-stdout drain deadlock;
  the transport now drains failed consumers and terminates the owned native
  command before closing its connection. Repeat cancellation passed: command
  exit137, both owned tethers stopped, source unchanged. Claude coding dispatch
  is now enabled through the single restricted SDK MCP shell tool.
- Current focused runtime regression: 129 passed, zero failed, one optional native
  preview skipped. Its separate native preview run passed 6/6, including frozen
  source/outside-read denial and large artifact receipts.
- Structured service tests now pass4/4, including interruption after staging,
  fresh capture on resume, preserved earlier partial bytes, zero model calls and
  final structured provenance attached to the exact reviewed artifact.
- `npm run verify` completed lockfile/framework checks, ignored database generation,
  GraphQL generation checks and workspace typechecks until the existing four
  island-composition LayoutQuality.crowding errors. The independent remaining
  workspace-test stage is still running; work-related fixture regressions are
  being repaired without changing unrelated layout/UI behavior.
- Expanded browser run:22 passed; two theme variants of the new host restart
  case failed only because its mock emitted an unintended proposal request.
  Fixture corrected; focused rerun pending. Earlier real native browser/import/
  graph acceptance remains separate evidence from these mocked UI tests.

- Actual private-IPC pinned host upgrade passed: old owned process stopped, the
  exact new release became ready under a new identity, and awaiting-review,
  approval, completed-task and event records survived. No repository source changed.
- Explicit Studio activation race tests3/3 passed: cooperative writers are blocked
  during restart; an external editor's later change is detected without overwrite
  or a false ready claim. Existing deployment inputs now use a read-only startup
  fast path so this lease does not create false initialization errors.
- The corrected host restart UI case passed in both themes (2/2), completing
  coverage of all12 cases across light/dark in the current two runs.
- Codex exact-session resumption passed with both owned tethers stopped and source
  unchanged. Its explicit native cancellation repeat remains in progress.
- The bounded-assert sweep now identifies only the existing
  sightline-freshness.test.ts import; the new disposable browser fixture was
  corrected to avoid introducing an unbounded assertion import.

- Broad remaining workspace stage completed:2,564 tests,2,507 passed,52 failed,
  5 skipped. Studio accounts for the52 failures. Eight known source-gate/editor/
  journal cases and the deployment fixture were repaired; the targeted eight-case
  editor/recovery run passed. Another16 source-gate/fixture failures and six server
  lifecycle failures are being investigated. Twenty-two apparent unrelated UI,
  assertion and layout failures remain to classify precisely. These are not
  reported as a clean repository check or as all unrelated.
- Pinned-host real IPC handoff passed1/1; post-change service shutdown/cleanup
  tests passed7/7. Host close now joins cleanup/recovery promises before releasing
  task storage, including when an HTTP observer disconnects.
- Codex native cancellation passed with exact session retained, source unchanged,
  and all owned tethers stopped. Both provider lifecycle paths now have direct
  native evidence on this macOS host.
- Provider output is chunked before durable events; file events carry metadata
  while immutable proposal blobs own diffs.32KiB stream truncation is reported.
  Provider suite25/25 passed; installed Codex recognizes and disables nested
  browser/app/subagent features. Final native smoke with these changes is running.
- Actual Studio restart acceptance fixture initially failed missing express before
  any self-change. Module resolution was corrected. Its next launch hit an
  automatic-review timeout (not a safety rejection); one permitted retry is pending.

- Actual Studio server restart probe passed in private fixture
  `studio-native-browser-Mir5Vk`, ephemeral port57150: reviewed fixture version2
  source imported, explicit restart changed PID76195→76332 with matching nonce and
  fresh browser token, and prior task remained available. A second intentionally
  broken startup retained accepted source and the earlier task, reporting activation
  failed. All owned fixture processes closed. This relocates actual server.ts with
  trusted live helper imports/minimal Vite page and deterministic provider; it is
  not a claim that a complete copied Studio toolchain was rebuilt.
- Targeted source-gate retries/journal recovery passed8/8 after fixes. Real
  deploy-service fixture passed12/12 with test sockets available. Full-suite
  additional source-gate16 and server-lifecycle6 failures remain under investigation.
- Final provider smoke attempts stopped safely before model work because installed
  Node library inspection failed under load. Earlier real coding/resume/cancel
  proofs remain valid; improve diagnostic specificity and repeat after load settles.

- Final Codex smoke passed sequentially with nested browser/app/subagent features
  disabled and bounded events. Earlier simultaneous attempts stopped before model
  work during toolchain inspection; the same narrow policy now completed without
  relaxing filesystem/network permissions. Final Claude smoke is running.
- Operations-process verification passed6/6 applicable checks, one existing
  optional live check skipped. Killed-worker recovery now asserts the durable
  shared source gate, rather than expecting the older lock-message wording.
- Additional full-suite gate failures were isolated to shared-root/legacy fixture
  contracts; navigation now captures public source privately, resource recovery
  resolves its journal before refresh and asserts stale publication is refused.
  Those targeted fixture runs remain in progress. No unrelated layout/UI behavior
  has been edited to force a green suite.

- Final native framework command uncovered the tsx CLI's mandatory IPC socket,
  blocked by the offline policy. The standard framework preset now runs exactly
  the same two scripts through node --import tsx, only for the exact canonical
  script and no npm pre/post hooks. Custom scripts keep npm behavior. Both scripts
  passed natively against the retained actual-project copy; no sandbox grant changed.
- Validation sequences bind the complete final candidate, rerun all checks once
  if generation changes source, and stop on failure. Explicit **Repair validation
  failures** resumes an ordinary native task's exact session/candidate with the
  independent failure evidence, discards old approval eligibility, and requires a
  fresh passing proposal. Structured edits cannot invoke this native repair path.
- Incomplete capture can be explicitly retried in a fresh private directory while
  retaining the incomplete attempt. Shared package/control-plane input changes
  conservatively require a pinned runtime and separate activation.
- Final focused agent regression:141 tests,140 passed,zero failed,one opt-in native
  preview skipped (separately6/6 native pass). State/repair sequence22/22 passed;
  repair browser checks4/4 passed across themes. Final full coding UI run pending.
- All24 source-gate/fixture failures from the broad workspace run were repaired and
  verified in targeted runs. Resources17/17, navigation11/11 (settled exit0),
  operations6 applicable pass/one skip, and scoped server lifecycle10/10 passed.
  The six broad-suite lifecycle deadline failures did not reproduce. The22 remaining
  broad-run failures concern unchanged UI/layout/assertion paths; our contributor
  to its mixed bounded-assert failure was fixed. No complete workspace rerun was
  performed after these repairs.

## Completion audit

- Final native Claude smoke completed successfully with the exact retained session,
  unchanged source and all owned tethers stopped. Both native providers now have
  final smoke, resume and cancellation evidence; the two canonical framework
  validation entries each exited0 in the native sandbox.
- The corrected-source host restart UI passed4/4 scoped browser cases across both
  themes, including durable replacement identity, transport failure, reload without
  automatic mutation and exact-pair retry after replacement startup fails.
- Final M4 review also required journaling a launch before spawn and retaining the
  owned process identity: a host that hangs before publishing its IPC metadata must
  not cause another host to launch on retry. Unknown launch outcomes fail closed.
- Final controller recovery checks passed17/17. Automatic approval review initially
  rejected the disposable process run under the earlier read-only restriction.
  The user explicitly authorized it; the final host/recovery group then passed26/26
  with zero failures/skips. It includes actual private-IPC failed-exit23→corrected
  release recovery, exact-pair retries and retained history, owned client startup,
  reconnect to retained ready bytes, pinned release tamper refusal, task-host restart,
  and managed activation. All owned fixture processes closed. Evidence:
  `output/agent-host-recovery-final.log`.

M0–M6 implementation is complete for the guarded local workflow, with native macOS
coding/repair/resume/cancel, browser approval/import/graph refresh, crash recovery
and managed runtime handoffs verified within the scopes above. The final M4 audit
gap is resolved: corrected-source replacement retains failure history and exact
retry identity; launch ownership prevents duplicate unverified processes. The full
coding browser suite passed26/26 before that additional recovery action, and its
four final browser checks passed across both themes. Final `npm run verify` completed
its lockfile/framework checks, ignored database generation and GraphQL generation
checks, then exited2 at the four unchanged LayoutQuality.crowding type errors in
`framework-studio/test/island-composition.test.ts:66–67`. No new type errors were
reported. Final knowledge checks passed36 pages/857 links/351 source references;
`git diff --check` passed. No verification or fixture process remains running.
The repository is not claimed clean: verification retains existing layout type
errors and the broad suite contains unrelated failures.

Readiness limits are deliberate: Linux remains unverified, native Windows is
unavailable, Claude coding requires the installed Codex command executor, and
binary or dependency-manifest integration remains blocked pending dedicated review/
provisioning capabilities. External editors and filesystem batches are optimistic,
not atomic; native sentinels do not exhaust every OS channel or detached daemon.
Retained-release crash recovery applies after a managed upgrade has been recorded;
before the first managed upgrade, a fresh host startup pins current Studio source.
The real Studio on4590, Git branch/index, AWS and live databases were not changed.
Load the new backend by restarting Studio when convenient, then use Agent → Coding.
The Framework checks preset or explicit offline test paths provides a useful scope
when full project checks require unavailable services or hit existing failures.
