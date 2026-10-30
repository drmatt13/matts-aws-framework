# Job 4 independent performance, correctness and security review — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

The independent reviewer did not author the source-proposal, graph, canonical
validation or local-Lambda optimizations. This pass challenged their correctness
and replayed isolated failures. The command and evaluator lifetime repairs below
were discovered and implemented during this pass. The campaign lead owns the final integrated
verification and release decision.

## Confirmed shutdown defect and repair

An actual Studio instance in a minimal disposable checkout accepted the normal
authenticated `/api/commands/framework:check` request. Its allowlisted script was
replaced only inside that fixture with a holding command and child process.
After SIGTERM, Studio exited 0 in 43.14 ms, but the tsx wrapper, command and
descendant were all alive at the +200 ms observation. The harness then stopped
only those recorded owned PIDs. An unrelated owned control process remained
alive. This confirmed a P1 process-lifetime defect beyond the earlier idle-server
and Lambda shutdown probes.

`CommandRunner` now retains its active completion and supervised child, has an
idempotent terminal disposer, and joins the server's deferred cleanup. Commands
reuse the existing process-group/tether implementation. Shutdown stops the
command tree, waits for completion and refuses subsequent work or later command
steps. Fixed script arguments, the allowlist and generation confirmation remain
enforced. Inherited object keys are explicitly excluded from command lookup.

The exact actual-server replay exited 0 in 28.98 ms. All three recorded command
PIDs were absent at +200 ms; the unrelated control survived. These one-sample
observations prove cleanup in this scenario, not a meaningful shutdown-speed
improvement. Four automated tests additionally cover active disposal,
single-command concurrency, fixed argv and confirmation, normal success,
terminal closure, killing the owner outright and shutdown between successful
steps. The lead's review identified that last boundary: skipping a later step
must report cancellation rather than retaining the prior step's zero status.
The corrected suite passed 4/4 in 2.71 s.

Raw evidence is under `.framework/job4/qa/`: `command-shutdown.mjs`,
`command-shutdown-{before,after}.json`, and `commands-tests-final.log`.
Replay from the root with `node .framework/job4/qa/command-shutdown.mjs after`.
The fixture reserves an unused loopback port above 4600; it never touches the
existing Studio listener. A preliminary harness omitted the protocol header and
was corrected before the defect receipt. The first automated test run was
blocked by the local sandbox denying tsx CLI IPC; the loopback-enabled run passed.

## Startup, queued refresh and active-review supervision

The final lifecycle challenge confirmed four related P1 paths in private actual
Studio fixtures:

- During startup, both evaluators entered a controlled synchronous `Atomics.wait`.
  SIGTERM killed the parent before its late signal handler was installed, leaving
  both evaluator PIDs alive at the +200 ms observation. IPC disconnection cannot
  run a callback while the child is synchronously blocked.
- With a source-watch refresh already queued, cancelling the initial pair allowed
  the queued refresh to create a replacement blocked pair. The initial PIDs exited,
  but the replacement pair remained alive and Studio had not exited after 3 s.
- A blocked tag-review candidate created its own evaluator pool outside snapshot
  refresh ownership. Studio exited 0 while that review pair remained alive.
  The fixture's authored configuration bytes were unchanged.
- After configuration installed a SIGTERM handler and blocked its event loop,
  parent cleanup and both owned evaluators remained pending after 1.5 s. IPC
  disconnect and a catchable signal could not complete disposal.

Signal handlers now cover startup, remain registered throughout asynchronous
cleanup, and are removed afterwards. An intermediate `once`-handler repair still
failed because the dependency signal-exit handler could re-emit an apparently
unhandled SIGTERM after our listener removed itself; the persistent handler fixes
that ordering. Shutdown cancels acquired work, joins startup, drains late
acquisitions and suppresses readiness. Snapshot disposal is terminal and refuses
queued follow-ups. One explicit per-builder `EvaluatorLifetime` tracks all live
snapshot/batch/route/resource evaluators until their actual exit, refuses later
forks and cancels every owned pair. It adds no global registry, source cache or
coupling between Studio owners. Apply's trigger and generator hash dependencies
also retain independent checks rather than merging overlapping keys.
Evaluator disposal is idempotent and escalates after a one-second grace period to
SIGKILL against only its exact owned ChildProcess; the timer is cleared on exit.
The final ignored-SIGTERM replay exited 0 with both evaluator PIDs absent.

All four exact scenario replays passed after repair: parent exit 0, every
recorded evaluator PID absent, no replacement pair, and authored review source
unchanged. The before-fix harnesses cleaned only their recorded owned PIDs.
Receipts are `startup-blocked-before.json`, `startup-blocked-after-final.json`,
`startup-blocked-queued-{before,after}.json`,
`startup-blocked-ignore-{before,after}.json` and `review-blocked-{before,after}.json`;
the corresponding `.mjs` harnesses remain beside them. Observations include fixed
post-exit waits and do not establish a shutdown-speed improvement.

The combined command/server suite passed 9/9 in 11.85 s
(`owned-evaluators-final.log`), covering ordinary command success and cancellation,
port collision, partial startup failure, both interrupted-startup variants and
active source-review shutdown. The Studio server/test TypeScript check passed
(`evaluator-lifetime-types.log`). Ordinary snapshot/recovery/watch replays passed
5/5 in 3.49 s (`evaluator-refresh-final.log`). A normal reviewed source edit,
snapshot refresh and byte-exact Undo passed 1/1 in 10.59 s
(`evaluator-edit-final.log`).
After adding the ignored-SIGTERM escalation, all six server lifecycle cases
passed in 12.47 s (`evaluator-escalation-final.log`). Apply now refuses failed
revalidation with the existing 422 message before comparing successful models'
creation/operation signatures; valid changed models retain their 409 guard.
The developer-acceptance specialist owns the focused diagnostic replay and the
campaign lead owns the final combined gate.

After the build specialist froze the shared tether repair, an independent replay
passed all four command tests in 2.06 s and all six server lifecycle tests in
12.72 s (`commands-after-tether-final.log`, `server-after-tether-final.log`). The
shared helper's cleanup targets only its recorded child's detached POSIX process
group and preserves the direct child's original exit status. Its dedicated
descendant, timeout and ordinary-output evidence belongs to the build specialist.
No Windows process-group execution is claimed. All QA-owned fixture processes
were stopped; no browser or preview remained.

## Invalidation and source safety

The new validation factories share resolved Lambda settings only within one
operation. The independent challenge mutated runtime, packaging and Cognito
environment inputs between operations. Fresh invocations observed every change
and rejected incomplete verifier inputs. The eager-resolution review compared
an invalid second Lambda against the existing normalization path: all operations
reported the same named invalid-build diagnostic. Normalization already resolves
every Lambda's network/build settings before implementation-health projection;
the factory does not introduce a new whole-model failure for this case.

The binding-signature tests preserve checks for grant destination, permission,
scope, invoker and invocation relation. Only source-location display evidence is
excluded from the declared-binding comparison. There is no new persistent source
cache or evidence-based authority shortcut.

Independent source fixtures verified POSIX permission preservation across atomic
replacement, expected-content conflict refusal, absence versus empty-file
semantics, normalized Windows separators, lexical traversal/absolute/UNC path
rejection, and symlink-parent refusal by both config and journal authorities.
The unchanged external bytes survived every rejection. Existing journal tests
also preserved separate native/generated recovery authorities and refused
incomplete locks and linked scratch directories. These focused suites passed
16/16 in 3.38 s. Windows path strings were tested on macOS; native Windows signals,
sharing violations and filesystem execution were not exercised.

## Additional source replay

The independent replay of obsolete snapshot proposals, external edits preventing
every batch write, and generator inputs changing during final validation passed
3/3 in 31.87 s (`obsolete-proposals.log`). The interrupted-journal recovery and
competing-process checkout-lock scenarios passed 2/2 in 6.41 s
(`journal-replay.log`). A killed writer's completed first file was restored while
a later user's edit was preserved. Recovery remained approval/fingerprint-bound;
live transactions were excluded, and dead-owner locks were never silently
reclaimed. This is direct current-source replay, rather than relying on the
earlier campaign's historical receipts.

## Second projection optimization review

The independent reviewer challenged the later repair for large `projectModel`
operations. `createTargetAvailability` captures fresh normalized targets and
delegates to the same exact deployment predicates used by the standalone APIs.
Cloud target/edge discovery uses those already-normalized targets. Projection's
temporary Lambda-spec batch scope is restored or deleted in `finally`, including
failure; the next projection re-resolves settings.

The independent oracle fixture contains all nine roles: HTTP, WebSocket,
WebSocket authorizer, event, service, task, workflow, agent and tool. It checks
every supported deploy token, both source modes, WebSocket API on/off,
shared/local/cloud/disabled/unlisted tool unions and the pre-existing unknown-ID
fallbacks. Expected results use an explicit role/deploy truth table, independently
of the new helper. That matrix, the author's projection scope/freshness regressions
and existing WebSocket cloud-edge regressions passed 6/6 in 1.51 s
(`projection-review-tests-corrected.log`). No correctness blocker was found.
Two preliminary matrix runs failed during fixture construction because workflow
timeout and service HTTP methods were missing; their preserved logs are fixture
failures, not product regressions. The final Studio server/test TypeScript check
passed (`studio-server-types-final.log`).

## Bounded browser continuation

A separate sandbox-enabled Chromium 155.0.8059.12 session opened the current
production build on its own loopback preview at port 4608, with the exact
500-entity presentation fixture and intercepted API responses. The first Board
module/navigation cycle was warmed before the initial sample. An initial ninety
Board↔Isometric/search cycles collected CDP heap usage after explicit GC every
ten cycles; the same page then continued for ninety more cycles. Every checkpoint
retained 2,129 DOM elements and one created/active/peak EventSource. The initial
ninety-cycle receipt recorded no page or console errors.

| Completed cycles | Retained JavaScript heap, decimal MB |
| ---: | ---: |
| 0 | 13.316 |
| 30 | 14.691 |
| 60 | 14.955 |
| 90 | 15.121 |
| 120 | 15.194 |
| 150 | 15.382 |
| 180 | 15.482 |
| 180, after 3 s idle and GC | 15.507 |

The later ninety cycles added approximately 0.36 MB. This finite, slow increase
does not establish a perfectly stable plateau, leak-free long-running behavior or
an unbounded leak. After idle/GC, CDP DOM counters were unchanged from the first
post-180 diagnostic: 33 documents, 9,080 total nodes and 1,244 listeners. Visible
DOM counts alone are therefore not used as proof of all retained DOM objects.
The endpoint reported history length 50 and these performance-entry counts:
250 resources, 200 long-animation-frame records and 50 soft-navigation records.
No custom long-task recording array was installed. These diagnostics record
browser/tooling state but do not attribute all remaining JavaScript growth to a
specific owner. An hours-long or allocation-snapshot study was not
performed; no speculative memory fix was introduced.

The preparation differs from the
earlier multi-size browser benchmark, so its endpoint heap values do not support
a before/after improvement claim. Independent correctness tests ran during this
window; no latency comparison is claimed. Raw receipts and the exact runner are
`heap-90.json`, `heap-followup-60.json`, `heap-followup-final30.json`,
`heap-post-idle.log`, `heap-end-diagnostics.log`,
`heap-performance-entry-types.log`, `heap-runner.js` and `prepare-heap.mjs`.
The named sandboxed browser session was closed. The Vite preview's exact command
and listener were verified before stopping only PID 13863 (exit 143); no existing
Studio process or unrelated listener was stopped.
The sole CLI-created snapshot was moved from the untracked `.playwright-cli/`
directory to `.framework/job4/independent-qa/page-2026-10-23T23-12-18-405Z.yml`.
The now-empty directory was removed; `qa/cli-cleanup.json` records the exact move.
No earlier or user-owned CLI artifacts were present or removed.

The server TypeScript check passed after the final command cancellation test and
projection changes. The campaign lead owns the final integrated gate.

## Scope and reproducibility

Commands and source fixtures are disposable, local and ownership-scoped. This
review performed no cloud write, publication, deployment, migration application,
Docker prune or shared-data deletion. Baseline and after receipts use actual
current source rather than assuming historical reports remain valid. Small
sample counts do not establish tail percentiles or hours-long stability.

Final repository verification, production build and any independent browser
outcome must be read from the integrated report once complete; this scoped record
does not substitute for those gates.
