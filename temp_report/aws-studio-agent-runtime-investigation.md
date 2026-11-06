# AWS Studio — Independent Agent Runtime Architecture Investigation

**Recommendation: build a small, Studio-owned agent runtime around ordinary isolated workspaces, native Codex/Claude execution, and recoverable file integration. Git worktrees are optional. A custom virtual filesystem is unnecessary.**

The hypothesis is technically sound. More significantly, this repository already contains much of the required foundation: reviewed multi-file edits, a durable source journal, isolated declaration evaluators, and an independent operations coordinator.

The difficult parts are dependency resolution, command permissions, concurrent edits, and activating changes to Studio itself. Those deserve more attention than inventing a new filesystem abstraction.

This investigation reflects the current working tree on **November 5, 2026**, including its pre-existing changes. A Node process was listening on `127.0.0.1:4590`; I did not assume it had loaded every current on-disk change. No source was edited, workspace or branch created, dependency installed, build/test/generator executed, container started, service restarted, or AWS operation performed.

**1. Current implementation findings**

Studio’s existing components provide a stronger starting point than the conversational agent suggests.

| Area | Verified behavior | Architectural implication |
|---|---|---|
| Agent conversation | `useAgentChat()` keeps conversation state in React memory and submits bounded history to `/api/agent-lab/chat`. Unmount aborts the request. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/src/agent-chat.ts:16) | Navigation persistence exists; durable tasks and reload recovery do not. |
| Agent execution | `AgentLabService` disables coding tools, runs outside the repository, limits execution to 45 seconds and output to 128 KiB, and owns tethered children. Chat disconnect cancels execution. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/agent-lab.ts:276) | This is intentionally a bounded conversational adapter, not a general coding worker. |
| Demo editing | The agent proposes one string. Studio generates the source, stores a short-lived plan, verifies original bytes, and applies that exact change. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/agent-lab.ts:255) | The proposal/review/application separation already exists in miniature. |
| General Studio editing | `BatchEditor` reviews multiple changes, validates both modes, checks source fingerprints, journals writes, refreshes the model, and conditionally restores on failure. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/edits/batch.ts:585) | There is already a non-Git transaction foundation. |
| Durable source recovery | `SourceJournal` records complete before/after contents, serializes participating writers with `source.lock`, and preserves later user edits during recovery. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/edits/journal.ts:85) | Extend this foundation instead of creating a competing rollback system. |
| Independent execution | `OperationsClient` launches a detached coordinator. Closing Studio’s client stops observation, not that coordinator. Detached workers own their command pipes. [Client](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/operations/client.ts:14), [worker](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/operations/worker.ts:13) | Independent agent supervision can reuse an established lifecycle pattern. |
| Proposed-source evaluation | `EvaluatorPool` accepts a repository root and source overrides, running Development and Production evaluations in separate processes. [Source](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/evaluator/pool.ts:158) | Architecture preview is feasible without first changing live source. |
| Sightline | It produces a bounded projection of selected Studio context; the agent currently receives none of it. [Contract](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/docs/framework-studio/sightline.md:1) | Reuse it as contextual evidence, with freshness and omission labels. |

Several qualifications matter.

**The existing transaction machinery is specialized.** Its write authorities cover supported declaration, creation, resource, and related source operations. It is not yet an arbitrary repository editor. Journals are text-oriented, reviewed plans are generally held in memory, and not every legacy write path uses precisely the same transaction flow.

**Studio already materializes proposed source for generation.** `generateCreationArtifacts()` copies selected inputs, applies proposed edits, runs generation against that copy, and collects the resulting artifacts. However, it inherits the host environment and uses the running Studio’s generator implementation. It is useful precedent, not sufficient isolation for arbitrary agent code. [Implementation](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/edits/creation-generation.ts:43)

**Watchers provide continuity, not transaction isolation.** Studio watches selected declarations, infrastructure, handlers, configuration and database paths, with a 200 ms debounce and five-second hash-poll fallback. This is not a complete repository change recorder. Failed configuration loading can retain the last successful graph marked stale/error. Own-write hashes suppress duplicate refreshes. Other editors, Vite instances and application watchers remain independent. [Watcher](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/watch.ts:24), [snapshot behavior](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/snapshot.ts:165)

**Studio’s architecture revision is not a complete source version.** Its declaration fingerprints do not cover every React file, handler, test, asset or dependency manifest. Agent tasks need a separate source manifest.

**2. Independent architecture proposals and comparison**

The proposals are largely complementary. A workspace determines where code runs; a supervisor determines who owns execution; a transaction manager determines how results enter the project.

The following ratings are engineering judgments, not measured benchmarks. “Isolation” distinguishes separate source files from restrictions on host access.

| Workspace approach | Complexity | Isolation | Performance | Reliability | Portability | Implementation cost |
|---|---|---|---|---|---|---|
| Ordinary private copy + reviewed integration | Medium | Strong source separation; host restrictions separate | Source copying reasonable; dependencies expensive | Straightforward, inspectable recovery | High | Medium |
| Same design with optional COW copying | Medium | Same as ordinary copy | Potentially much faster preparation | Reliable with ordinary-copy fallback | High with fallback | Small addition |
| Mandatory filesystem snapshots/overlay mounts | High | Strong source separation; host restrictions separate | Excellent where supported | More platform and cleanup cases | Variable | High |
| Custom VFS/filesystem interception | Very high | Depends on every access path being covered | Potentially efficient | Native tools and subprocesses are difficult | Low–medium | Very high |
| Git worktree + reviewed integration | Low–medium | Separate working files; shared host capabilities | Usually efficient | Mature Git tooling; dirty/untracked state needs care | High | Low–medium |
| Direct live edits + checkpoints | Low initially | No source isolation | Excellent | Difficult recovery during long tasks | High | Low initially; higher recovery cost |
| In-memory structured edits, materialized for commands | Medium | Good for supported operations | Fast until commands need files | Good within a narrow editing model | High | Medium |

**A. Ordinary copies with optional copy-on-write acceleration are the best default.**

Native development tools expect real paths, real files and conventional module resolution. A private directory provides all three. Studio can determine changes by comparing manifests and contents; it does not need to intercept every write.

Node’s `COPYFILE_FICLONE` attempts a copy-on-write copy and falls back to ordinary copying when unavailable. Copying is not an atomic directory snapshot. Treat cloning as an optimization, with manifest verification supplying consistency. [Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html)

The workspace should be temporary in lifecycle but retained durably while a task is active or awaiting review. An automatically purged temporary directory is a poor place for the only recoverable copy of unfinished work.

**B. A Change Transaction Manager is justified, but should remain a file-integration service.**

It should own immutable proposals, source preconditions, review identity, coordinated application and recovery. It should not emulate a database filesystem or claim arbitrary multi-file atomicity.

The existing journal and `BatchEditor` supply much of its design.

**C. Independent supervision is justified and already partly implemented.**

Use the existing coordinator’s lifecycle principles: durable acceptance, idempotency, process identity, logs, cancellation and explicit uncertain outcomes. Add an agent-specific domain and restricted worker launch.

Do not expose arbitrary shell execution through the deployment operation registry. Sharing lifecycle infrastructure must not share deployment authority.

**D. Architecture preview is a valuable differentiator.**

The current evaluator and source index make it practical. Its execution boundary must be strengthened before evaluating unrestricted agent-authored declarations.

**E. Structured operations and general coding should converge on one candidate workspace.**

Structured operations can produce predictable declarations; the native agent can implement handlers, UI and tests. Their final outputs should enter one review artifact.

**F. Direct live editing has a legitimate narrow role.**

It is reasonable for a reviewed documentation edit, a small deterministic source operation, or an explicitly selected interactive mode where immediate feedback matters.

It is a poor default for autonomous refactors. Checkpoints cannot undo database writes, dependency installation, Docker actions, or intermediate source already consumed by another process.

A useful simpler alternative is therefore **structured proposals for small tasks, ordinary materialized workspaces for general tasks, and one shared integration mechanism**. No elaborate filesystem infrastructure is required.

**3. Native Codex and Claude integration**

Harmless version/help commands reported:

| CLI | Installed version | Locally verified interface |
|---|---|---|
| Codex | `0.166.0` | `exec --json`, `--cd`, `--skip-git-repo-check`, sandbox selection, resume, and `app-server` |
| Claude Code | `2.1.318` | Print mode, streaming JSON, session resume, tool controls, permission modes, host permission prompts, safe/restricted modes |

I did not run inference, test authentication, or exercise these sandboxes. Installed help establishes available controls; runtime compatibility remains an experiment.

**For Codex, use app-server for the intended Studio experience.** Its documented protocol includes threads, turns, streamed command/file activity, approval requests, interruption and resumption. Studio already uses its initialization and model-list protocol for model discovery. A short `codex exec --json` adapter is suitable for the first execution experiment, but app-server better matches a persistent interactive interface. [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server)

Codex can work without a Git repository through `exec --skip-git-repo-check`. Its native loop already explores, edits, executes commands and iterates. Studio does not need to implement those behaviors. [OpenAI non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)

Use explicit filesystem and network policy. Plain `workspace-write` should not be interpreted as credential isolation: app-server documents broad read access by default unless restricted read roots are configured. Its `thread/shellCommand` and experimental `process/spawn` APIs also run outside the ordinary sandbox; they should not become convenient shortcuts around task policy. [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server)

**For Claude, use native print/streaming execution with an approval adapter.** The documented CLI exposes the same coding loop, with JSON streaming and resumable conversations. Use the supported SDK permission callback if it proves more stable than handling the CLI’s host-control protocol directly; that still reuses Claude’s agent loop. [Claude programmatic execution](https://code.claude.com/docs/en/headless)

Permission mode and OS sandboxing are separate. Claude’s documented shell sandbox is off by default and does not encompass all file tools, hooks or MCP processes. Require sandbox availability, disable unsandboxed retries, and separately constrain non-shell capabilities. macOS and Linux use different enforcement mechanisms. [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing)

Retain native login ownership. Do not copy credentials into workspaces. Also, do not select Claude’s `--bare` merely for configuration isolation: current documentation says it skips subscription OAuth/keychain authentication. The existing safe-mode approach preserves authentication while disabling customization. [Claude programmatic execution](https://code.claude.com/docs/en/headless)

Both adapters should expose a small shared contract:

- Start/resume a task with an explicit workspace and policy.
- Stream messages, commands, edits, permission requests and terminal status.
- Interrupt and stop owned processes.
- Return provider session identity and usage where available.

Keep raw provider events privately for diagnosis. Use normalized events for the UI. **Final filesystem contents, rather than provider edit events, determine the proposed change set:** shell commands and generators can change files without emitting dedicated edit events.

**4. Recommended design**

Build four cooperating components.

| Component | Responsibility |
|---|---|
| Studio interface/API | Prompts, task observation, contextual evidence, permission decisions, code/architecture review |
| Independent task coordinator | Durable task lifecycle, worker ownership, event replay, cancellation, scheduling |
| Isolated task workspace | Native CLI exploration, editing, commands, generation and validation |
| Source integration service | Immutable proposal, conflict checks, journaled application, recovery and accepted-model publication |

The coordinator should be an on-demand, user-scoped Node process using private local IPC. An installed system service is unnecessary initially. Existing operations code already demonstrates this model on macOS/Linux.

The workspace needs three distinct states:

- **Base:** the captured starting source.
- **Working:** files the agent and its commands may change.
- **Proposal:** frozen reviewable bytes and metadata, inaccessible to further agent modification.

Capture the actual working directory, including existing modifications and relevant untracked source. A Git commit is not an adequate baseline for this user experience.

Record relative paths, file type, content hash, relevant mode bits and absence. Detect source changes during capture and retry before declaring the workspace ready. This provides a verified captured state, not an instantaneous filesystem snapshot.

Exclude credentials, runtime data, deployment state, journals and disposable output. Define generated-output policy explicitly: committed generated files may belong in the proposal; ignored database artifacts may be needed only for validation.

**Dependencies require a deliberate policy.**

Read-only inspection found approximately **2.1 GB** in root `node_modules`, with links including:

```text
node_modules/@repo/framework -> ../../packages/framework
node_modules/@repo/database  -> ../../packages/database
```

Symlinking the entire live dependency directory into the workspace would cause workspace packages to resolve back into authoritative source. It could produce misleading validation and expose live files.

Initially, copy or clone a private dependency tree, preserving or rebuilding internal workspace links so they point into the candidate. Audit outbound and absolute links. Do not hard-link writable task files to live originals.

Start with unchanged dependency manifests and lockfiles. Later, add private installation with controlled lifecycle scripts, network access and npm-version requirements. Shared immutable dependency storage is an optimization to consider after measuring preparation costs.

**Integration should use optimistic concurrency and a write-ahead journal.**

The proposal should contain:

- Project and task identity.
- Base manifest digest.
- Exact proposed bytes, deletions and relevant metadata.
- Candidate digest.
- Validation and architecture evidence tied to that digest.
- Approval identity.

Use complete contents for correctness and recovery; generate unified diffs for review. Initially, represent renames as delete/create operations and infer rename relationships for display.

Before applying, confirm that target files still match their expected base state. A new file must still be absent.

Also distinguish file conflicts from stale validation: a changed file outside the proposal can still affect imports, tests or architecture. The simplest initial policy is to reject a stale baseline and offer a refreshed proposal. A later version can rebuild **current source plus candidate changes**, detect overlaps, rerun checks and obtain renewed review where needed. Automatic three-way merging is unnecessary for the first release.

During application:

1. Acquire the shared source-integration lock.
2. Recheck preconditions.
3. Persist the full journal before writing.
4. Replace files individually.
5. Verify resulting bytes and architecture.
6. Complete the journal and publish the accepted revision.

Existing replacement is atomic per file, not across files. Its source comparison followed by rename is not an OS-level compare-and-swap. External editors do not obey Studio’s lock. [Current file writer](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/edits/io.ts:22)

The correct promise is **conflict-checked, recoverable integration with a short application window**. Absolute prevention of concurrent external saves would require cooperating editors or a stronger filesystem arrangement.

**Permissions must be independent of source approval.**

| Capability | Default task policy |
|---|---|
| Read selected project source | Allowed |
| Edit candidate source | Allowed within task scope |
| Execute offline development commands | Allowed within enforced task restrictions |
| Read credentials/private inputs | Denied unless specifically required and granted |
| Access live databases or Docker | Separate, scoped authorization |
| Install dependencies | Separate preparation capability |
| Apply source to authoritative project | Explicit approval of immutable proposal |
| Apply migrations or perform AWS mutations | Separate environment-specific operation approval |

Sanitized environment variables are useful but insufficient: credentials can be read from files, sockets or local services. Restrict live source writes, credential reads, Docker access, Studio IPC and unnecessary network access.

The native CLI parent may need provider authentication. Commands, plugins and preview code should not inherit equivalent access. Disable unneeded hooks, MCP servers and automatic integrations, then prove the remaining boundary experimentally.

A temporary directory cannot provide these guarantees alone. Stronger containment may require an outer OS sandbox or another execution backend. Keep that backend replaceable; do not make containers the defining architecture.

**5. Concrete execution lifecycle**

The intended experience can follow this sequence:

1. **Submit.** Studio sends the instruction, provider choice, task scope and bounded Sightline context. Captured context includes its source revision and freshness.
2. **Accept durably.** The coordinator assigns a task ID and records intent before launching work. Closing the browser only detaches observation.
3. **Prepare.** Capture source and dependency state into the private workspace; verify links, inputs and policy.
4. **Execute.** Start the native CLI in that workspace. It explores, edits, runs commands and repairs errors.
5. **Observe.** Stream persisted events with sequence cursors. Reconnected clients replay missed progress.
6. **Validate.** Run applicable checks inside the workspace and record commands, exit codes, output, environment profile and candidate identity.
7. **Freeze.** Stop or detach all writers from the review artifact and capture final bytes. If validation changed reviewable files, rerun affected checks against those bytes.
8. **Preview.** Produce Development and Production architectural differences when supported.
9. **Review.** Show code changes, architecture changes, checks, limitations and required activation. Approval binds the exact proposal.
10. **Integrate.** Recheck live source, journal and apply the approved changes, then publish the refreshed architecture. Conflicts preserve the proposal for revision.

Validation should follow repository requirements, including `npm run verify` and relevant browser or infrastructure checks. Here, `verify` regenerates ignored database artifacts, so it cannot be treated as a universally read-only command.

The trusted runtime should distinguish an agent’s claim that tests passed from recorded execution evidence. Evidence proves what ran against which bytes; it does not prove that agent-modified tests are sufficient.

**6. Architecture-aware review concept**

**Current Architecture → Proposed Architecture is feasible with substantial reuse.**

`projectModel()` already exposes normalized targets, routes, resources, networks, relationships, fields, permission facts and diagnostics. Full snapshots add source indexing and inferred native CDK relationships. Existing batch comparisons provide precedent for comparing semantics while excluding incidental source locations. [Projection](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/model/project.ts:648)

For the Lambda/API/queue example, review could show:

| Proposed change | Evidence Studio can reasonably display |
|---|---|
| Lambda added | Target identity, handler, runtime/configuration and deployment placement |
| API route added | Public path and target relationship |
| Queue added | Declared resource/member and recognized native source |
| Binding or trigger added | Connection, direction and provenance |
| Permission changed | Known principal/action/scope facts |
| Unsupported dynamic CDK code | Explicit uncertainty requiring further review |

Keep source identities, public paths and deployed construct identities distinct. A rename in the graph must not silently imply an unchanged CloudFormation identity.

The interface should pair focused graph differences with code diffs, keeping unchanged nodes positioned consistently. Show added/removed/modified relationships and a separate list of unknown or unsupported effects.

**Current evaluation is not safe enough for unrestricted proposals.**

The evaluator imports `framework.config.ts`, and its child inherits `process.env`. Synthetic inputs avoid normal secret loading; they do not stop authored TypeScript from performing filesystem, network or process operations. [Launch environment](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/evaluator/pool.ts:63), [configuration import](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/evaluator/evaluate.ts:83)

Use a dedicated preview worker under enforced restrictions, with task-local scratch files and bounded resources. Supply permitted deployment-condition outcomes from a trusted component rather than copying private `.env` files. Unsupported conditions should remain unknown.

Do not assume changing `cwd` selects a completely independent toolchain. The evaluator executable is located relative to the running Studio, while candidate imports may resolve elsewhere. Application-only previews can use a pinned evaluator version; changes to framework semantics require explicit candidate-toolchain handling.

If safe dynamic evaluation is unavailable, provide static source analysis and mark the dynamic preview unavailable.

Architectural evidence also has limits:

- Declared architecture is not deployed state.
- Inferred edges are not a complete dependency proof.
- Declared permissions are not complete effective IAM analysis.
- Graph equality does not prove logical-ID stability, absence of replacement, successful deployment or runtime correctness.

A separate CDK synthesis comparison can add evidence. It still executes application code and may need context; `--no-lookups` refuses missing context lookups, but does not sandbox arbitrary application behavior. [AWS CDK CLI documentation](https://docs.aws.amazon.com/cdk/v2/guide/cli.html)

Historical repository measurements report a 3.39-second cold snapshot and roughly 1.4–2.4-second representative source reviews. These are older workstation measurements, not timings collected here. They favor previews at checkpoints or on request rather than on every file write. [Performance record](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/docs/framework-studio/job4-performance-2026-10-23.md:68)

**7. Failure, recovery and Studio self-modification**

| Event | Recommended behavior |
|---|---|
| Browser reload/disconnect | Task continues; browser reconnects and replays persisted events. |
| Studio HTTP restart | Independent worker continues; new server reconnects after protocol/workspace checks. |
| Coordinator loss | Reconcile durable state and worker identity. Never blindly launch the task again. |
| Agent crash or timeout | Preserve workspace, logs and partial changes; mark interrupted. |
| Cancellation | Request provider interruption, terminate owned commands after a grace period, retain partial work. |
| Validation failure | Return diagnostics to the agent or preserve a failed proposal; never auto-apply. |
| Concurrent source edit | Reject stale/conflicting application and offer refresh/review. |
| Crash during integration | Recover from the journal, classifying original, written and conflicting files. |
| Later user edit during rollback | Preserve it; restore only files still matching the transaction’s written bytes. |
| Disk/persistence failure | Stop accepting further work and preserve uncertain execution state. |
| Machine reboot | Recover history and artifacts; running processes do not survive. Resume explicitly. |

The existing operations store already contains durable acceptance, replay and process-identity concepts worth reusing. Its tests cover several failure scenarios, but those tests were inspected rather than executed during this investigation. [Operations store](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/operations/store.ts:26)

Cancellation and rollback apply to different things. Stopping a task cannot undo an already completed external side effect. That is another reason to separate ordinary coding from database, Docker and AWS capabilities.

**Studio’s own changes require separate activation.**

The root command uses plain Node with `tsx`, without automatic backend restart. Vite runs inside the server. Changing backend files therefore does not automatically replace the running backend, while frontend changes can trigger HMR. [Launch command](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/package.json:22), [Vite integration](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/server.ts:538)

| Change category | Activation policy |
|---|---|
| Application source | Integrate and refresh architecture; ordinary application watchers may react. |
| Studio frontend | Validate separately; expect HMR or a deliberate reload, with durable task recovery. |
| Studio backend/shared protocol | Controlled restart with compatibility checks. |
| Supervisor/framework/toolchain/dependencies | Drain affected work or keep its old runtime available before activation. |

Today’s independent operations processes still load code and tools from the checkout. Independence from the HTTP process does not make them independent of source or dependency replacement.

Initially, defer runtime-affecting activation until tasks finish. Later, use a small versioned runtime bundle outside editable project source so existing tasks can finish with their original implementation.

**Normal isolated agent work can leave Studio operational. Backend activation can preserve tasks, but cannot honestly promise uninterrupted HTTP service.**

**8. Phased implementation plan**

| Milestone | Deliverable | Completion criterion |
|---|---|---|
| **1. Native execution and containment proof** | One provider, one ordinary candidate workspace, unchanged dependencies, offline commands | A real multi-file edit/test loop succeeds; live source and forbidden host resources remain inaccessible |
| **2. First useful agent** | Durable task domain, streaming progress, cancellation, immutable diff, journaled application | A task survives browser reload and Studio restart; approval applies exactly reviewed bytes |
| **3. Architecture review** | Restricted candidate evaluator, both-mode semantic differences, explicit unknowns | A workload/resource/binding example previews correctly without touching live source |
| **4. Second provider and structured tools** | Claude/Codex parity where practical; small framework operation set | Both editing paths produce the same proposal and integration contract |
| **5. Advanced lifecycle** | Dependency changes, concurrent tasks, candidate refresh, controlled self-update | Resource contention, stale evidence and runtime activation have tested recovery behavior |

The fastest useful first release should support:

- One active coding task per project.
- Ordinary private source and dependency copies.
- Native exploration, multi-file edits and offline tests.
- Durable progress and cancellation.
- Full file review and conflict-aware application.

Architecture preview can follow immediately, but general coding should not wait for a comprehensive graph-diff interface.

For structured tools, start with a small set: create workload/resource, connect or bind, and change a declaration. Existing creation supports substantial coverage, but batch review currently requires creation to be handled separately from other edits. Compose those operations inside the candidate workspace, then review the final result together. [Creation types](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/shared/creation.ts:12), [batch constraints](/Users/matt/Desktop/code/framework-fix/matts-aws-framework/framework-studio/server/edits/batch.ts:134)

**9. Targeted proof-of-concept experiments**

These are proposed experiments; none were performed.

| Experiment | Highest-risk assumption tested | Acceptance evidence |
|---|---|---|
| **Workspace resolution** | A copied monorepo actually uses candidate packages | Resolve `@repo/*`, generators and generated artifacts; demonstrate candidate changes affect execution while live files remain unchanged |
| **Copy cost and consistency** | Preparation is practical without mandatory filesystem snapshots | Measure ordinary/clone copying, disk use and capture retries on macOS/Linux |
| **Native CLI task** | Saved-login CLI execution works outside Git with useful controls | Complete a fixture refactor and repair a failing test; capture streaming, approvals, cancellation and resume |
| **Permission boundary** | Configuration produces actual isolation | Fixtures attempt forbidden writes, credential reads, local-service/IPC/Docker access and network calls; all prohibited access fails |
| **Preview containment** | Declaration evaluation cannot escape | Fixtures attempt side effects, child processes, hangs and excessive output; restrictions and limits hold |
| **Graph fidelity** | Architecture differences are meaningful | Add Lambda, route, queue and grant; delete a module; change a condition; introduce unsupported CDK syntax; verify known changes and explicit unknowns |
| **Integration interruption** | Journaling protects recoverability | Stop application after each file boundary and inject external edits; recovery preserves later changes |
| **Validation mutation** | Reviewed bytes match validated bytes | Run generation/build steps that modify output; ensure evidence and proposal identities are refreshed |
| **Supervisor survival** | Execution ownership is independent | Disconnect browser, stop HTTP server, then stop coordinator separately; verify replay and absence of duplicate execution |
| **Self-update activation** | Runtime changes do not strand tasks | Exercise frontend, backend, protocol and dependency changes with controlled restart and recovery |

The first four experiments should precede substantial UI work. They determine whether the runtime is useful and trustworthy.

**10. Critical trade-offs and final recommendation**

The worthwhile complexity is concentrated:

- A real materialized workspace.
- A durable task and event model.
- Enforced execution permissions.
- Exact proposal bytes and content identities.
- Conflict checks and recoverable application.
- Candidate architecture evaluation with clear evidence limits.
- Explicit activation for Studio/runtime changes.

Avoid initially:

- A custom VFS or filesystem interception layer.
- Mandatory OS snapshot machinery.
- A new code-editing LLM loop.
- Automatic three-way merging.
- A duplicate supervisor framework.
- Reimplementing every Inspector action as an agent tool.
- Treating CLI edit events as a complete change ledger.
- Claiming transaction-like source application can undo external effects.

The central questions have direct answers:

| Question | Conclusion |
|---|---|
| Can temporary workspaces replace Git worktrees? | **Yes**, for task isolation and reviewed integration. Git can remain optional history/version-control tooling. |
| Can Studio own IDE-like change sets? | **Yes.** Existing editing and journaling already establish the model. |
| Is there a simpler equally useful approach? | **Yes:** ordinary copies, manifests and journaled application, with optional COW acceleration. |
| Should native agents perform coding? | **Yes.** Studio should orchestrate, constrain, observe and integrate. |
| Can architecture be previewed before application? | **Yes**, with restricted evaluation and explicitly bounded claims. |
| Is the hybrid editing model worthwhile? | **Yes**, if both paths share one workspace and integration contract. |
| Can execution survive Studio restarts? | **Yes**, with independent ownership and durable state; existing operations code provides precedent. |
| What is the fastest route? | One isolated native agent, offline validation, durable progress and exact reviewed application; then architecture previews and structured tools. |

**If I were designing this from scratch while preserving the useful implementation, I would build a branchless workspace-based coding runtime around the existing operations lifecycle and source journal. Native Codex and Claude would perform the coding; Studio would own permissions, evidence, architecture review and integration.**

That design delivers the intended live Studio experience without making Git, containers or a custom filesystem prerequisites—and it concentrates engineering effort on the boundaries that actually determine reliability.
