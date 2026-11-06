# Local coding agents

## Coding tasks

Choose **Agent → Coding** in the bottom tray for source development. This is separate
from **Conversation** and the fixed-message `/test` experiment below. A task starts
from the project's actual saved files, including uncommitted and untracked source;
unsaved inspector/editor drafts are not included. Studio creates a private copy
outside the checkout, runs the selected native coding CLI there, captures its progress,
runs a host-selected final validation command, and retains an immutable file proposal.
**Approve and apply** is a separate action bound to that proposal's digest.

The provider/model selectors reuse native CLI discovery and login. Coding execution
requires the installed CLI's restricted execution capabilities and boundary checks;
an available conversational CLI does not guarantee an available coding runtime.
The agent supplies its own investigation, edits and development commands. Studio owns
workspace preparation, permission boundaries, supervision, validation evidence and
source integration rather than implementing another model/tool loop.

Codex coding uses its native app-server protocol for the model loop, edits, commands,
streaming, saved sessions and interruption. Studio explicitly disables inherited MCP
entries and verifies the effective configuration before starting a model thread;
an empty MCP configuration table alone does not remove inherited entries.

Claude coding requires **both the Claude and Codex CLIs**. Claude retains its native
model loop, saved login and sessions, but all native tools, including Bash and file tools,
are disabled. Its only tool is the host's fixed `studio_shell` SDK MCP bridge, which runs
commands through Codex's verified, model-free `command/exec` sandbox. This avoids
Claude's native macOS shell sandbox's credential-service permissions. The bridge accepts
only a command string; the host fixes its directory, environment, permissions, timeout
and output limits. Codex needs no model authentication for this executor. Final validation
for either provider uses the same model-free boundary. Studio never copies CLI credentials
or provisions API keys; the authenticated native controller remains trusted.
The submitted task authorizes commands inside that verified offline boundary, so routine
commands proceed automatically. Unsupported capabilities remain denied. Approving source
integration is a separate user action and never authorizes deployment or database changes.

Both paths must pass actual disposable filesystem, symlink, process-signal, environment,
loopback, external-network and Unix-socket boundary checks before receiving the source
task. macOS native coding and test/repair have been exercised with Codex 0.166.0 and
Claude 2.1.318; both providers' saved-session resume and cancellation passed native probes.
Linux uses the same per-run fail-closed checks but has not been empirically verified
in this session. Native Windows execution
is unavailable. These checks do not claim that every possible OS credential channel or
daemon-detachment technique has been exhaustively tested.

**Final validation** selects project `verify`/`test`, `framework:check`, or up to twenty
explicit repository-relative source test paths. The selected scope is shown as evidence;
passing a subset does not mean the complete project passed. These commands retain the
execution restrictions, including unavailable network and operational resources. A
test requiring local servers, Docker, AWS or a database may fail under those restrictions.
For this repository's exact standard `framework:check` script, Studio invokes its two
authored check entries through `node --import tsx`, preserving the arguments while
avoiding the `tsx` launcher’s local IPC socket. Both checks passed in the native sandbox
against a private full-project copy. A custom script or npm pre/post hook keeps the npm
execution path; no check or lifecycle hook is silently discarded.
If final validation fails on a native coding task, **Repair validation failures** resumes
the same task and retained working copy with the failure evidence. It produces a new
validated proposal requiring new approval. Missing validation capability does not enable
this action, and structured Inspector handoffs do not invoke an LLM repair.
Buffered command output is capped at 32 KiB per stream and reports truncation;
larger native captures stalled in the installed CLI. Architecture results use bounded
scratch artifacts and small receipts instead of large protocol responses.

**Include current Studio context** captures bounded [Sightline](sightline.md) JSON at
submission. Inspect it before starting. A retry keeps the same request key, context and
validation choice. Context distinguishes declared source, cached observations and their
freshness; it grants no AWS, database, deployment or source-write authority. It does not
silently include private environment values, logs, database rows or unsaved draft text.

Tasks and sequence-numbered events live in a separate pinned host with SQLite state.
Closing the browser, changing views or restarting the Studio observer does not cancel
the task. Reopening Coding replays progress and restores the selected task. Native process
identity and interruption records support recovery; an uncertain side effect is not
automatically replayed. Cancellation, permission answers, rejection, refresh and approval
are explicit actions. Default execution concurrency is one; the host accepts a bounded
queue and supports up to four configured execution slots, with source imports serialized.

Review covers added, modified and removed files, content and mode changes, validation,
and available architecture previews. Saved-source changes refuse stale approval.
**Refresh candidate from saved source** attempts a clean three-way merge, validates
the result and produces a new proposal requiring new approval. Overlapping edits remain
conflicted. Integration uses the shared source gate, exact baseline checks and a durable
journal; normal filesystems do not provide an atomic multi-file transaction. Interrupted
writes require explicit, fingerprint-bound **RESTORE SOURCE** or **KEEP CURRENT SOURCE**
decisions. User edits are not silently overwritten during recovery.

After approved application changes, Studio refreshes its source graph. For approved
Studio implementation changes, **Restart Studio** is a separate action available only
after source integration; it restarts the registered managed observer, then **Reload
Studio** reconnects the browser. The pinned agent host remains independent. Dependency
manifest changes remain blocked from integration until a separate private installation
and validation workflow is available; a runtime restart is not a dependency installation.

The **Agent host** disclosure beside task controls manages the independent coding host.
Opening it reads restart status; **Restart agent host** is a separate explicit action
after active tasks finish or are cancelled. It loads a newly pinned implementation while
retaining task history and proposals. It neither applies source nor restarts the Studio
interface. A transport retry reuses the same retained request UUID, including after a
browser reload; reading status never automatically resubmits a restart.
After a failed host upgrade, **Restart agent host** retries the same pinned version.
After saving a correction, **Restart from corrected source** explicitly creates a new
version and retains the previous failure record. Its new request identity and the
failed request it replaces remain paired across transport retries and browser reloads.
Superseded requests remain in the task database's upgrade history; replaying an old
request cannot select newer source. A late-starting failed target is reconciled before
replacement. Once a managed upgrade is recorded, an ordinary host crash restarts
that retained pinned version. Before the first managed upgrade, a fresh host startup
pins the current Studio implementation.
The controller records its launch intent before spawning and retains the verified child
identity afterward. An unknown launch outcome or a live, unresponsive child blocks a
duplicate launch; it requires inspection rather than a forced process kill. A matching
live endpoint can reconcile an interrupted observer. These restart actions do not replay
coding tasks or their development commands.

Inspector batch review also offers **Review as coding task**. It transfers the trusted
reviewed source changes into the same private validation/proposal pipeline without an
LLM call. The original inspector draft remains available, and Coding still requires
explicit source approval. The existing **Apply All** flow remains supported.
If a structured task is interrupted after staging, explicit resume captures a fresh
private directory, rechecks the trusted before-bytes against current saved source and
reruns validation. The previous partial directory remains retained for inspection.

Workspace copies exclude private inputs, Git metadata, runtime output and tool hooks.
Dependencies are private copies with internal workspace links rebased; escaping links
and source symlinks/hardlinks are refused. Copies are filesystem staging, not the security
boundary: native process restrictions separately constrain writes, credentials and
network access. Copy admission uses a disk estimate and minimum free space; it is not an
OS quota. **Clean up temporary task files** releases terminal working/runtime copies while
retaining review and recovery evidence. Rejection cannot undo an external side effect;
operational capabilities must remain outside the coding policy.

Architecture previews compare frozen baseline/candidate declarations in both modes
through the pinned projector and each revision's own framework instance. Read-only source,
scratch-only writes, synthetic mode inputs and bounded verified result artifacts isolate
evaluation. Unknown private-input conditions remain labeled unknown. The result is an
advisory declaration diff, not CloudFormation synthesis, effective IAM analysis, observed
AWS state or deployment approval. Incompatible framework/dependency changes can make it
unavailable without manufacturing an empty graph.

Implementation owners: [task service](../../framework-studio/server/agent-runtime/service.ts),
[workspace](../../framework-studio/server/agent-runtime/workspace.ts),
[provider adapters](../../framework-studio/server/agent-runtime/providers/),
[integration](../../framework-studio/server/agent-runtime/integration.ts),
[runtime activation](../../framework-studio/server/agent-runtime/activation.ts),
[preview runner](../../framework-studio/server/agent-runtime/architecture-preview-runner.ts)
and [Coding panel](../../framework-studio/src/views/agent/CodingPanel.tsx).

Current acceptance evidence and remaining gaps are recorded in the
[implementation progress log](agent-runtime-implementation-progress.md). A disposable
native Codex browser task has demonstrated edit → validation → explicit approval →
two-file import → graph refresh from `/add` to `/sum`. A separate
[managed restart probe](../../framework-studio/test/support/agent-studio-restart-probe.ts)
uses the actual relocated Studio server with trusted source helpers, a minimal page and
deterministic provider/validation fixtures. It demonstrated explicit source approval,
separate restart approval, a new PID and activation nonce, retained task history, and
retained source/history after an intentional startup failure. These checks do not
establish full copied-repository self-modification, full Claude browser parity, Linux
behavior, AWS behavior or a green repository-wide verification gate.

## Conversation

Choose **Agent** beside **Activity** in the bottom bar on any Studio page, then use
the summary or chevron to open the panel. Mode buttons preserve its open or closed
state. The panel slides open and closed, with instant changes under reduced motion.
The question-and-answer conversation uses the selected standalone Codex or Claude CLI
and its saved login. Starter questions fill the composer so they can be edited before
sending. Enter sends; Shift+Enter adds a line. Answers support Markdown, code examples
and copying. **Stop** cancels the active request; failed or stopped replies can be retried.

The model selector lists the choices reported by the selected CLI using its saved
login. **CLI default** leaves the choice to that CLI; explicit choices are remembered
separately for Codex and Claude until reload. Catalog discovery initializes a session
without asking a model to generate a reply. If discovery fails, the default remains
usable and **Refresh models** retries. The server validates explicit choices against
the CLI catalog and passes them through its `--model` option.

Activity and Agent keep their state when switching modes, collapsing the panel or
navigating. A background answer marks the Agent tab without switching modes. Explicit
operation launches still reveal Activity. Escape collapses the panel and returns focus
to its mode tab. **New chat** asks before clearing the conversation and preserves a
draft. Conversation state lasts until the page reloads; it is not stored on disk.

Conversation provides general guidance with a short built-in Studio overview.
It does not inspect the current graph, source files or operation logs. The request
contains a bounded recent conversation; the agent has no tools or source-write access.
`src/agent-chat.ts` owns session state, `views/agent/AgentPanel.tsx` owns chat presentation,
and `POST /api/agent-lab/chat` uses the existing bounded CLI runner. The request is
aborted when the browser stops it or disconnects. No API-key setup is required.

Choose **Sightline** beside **Conversation** in the bar of the open Agent panel to inspect
what Studio can see from the current location and selection. This is a read-only JSON debug view;
Conversation does not receive it. Coding can include an explicit captured projection as described above.
Conversation, draft and scroll survive switching back. Expand/collapse and
Copy JSON affect only its display/export. The JSON updates while visible from existing
source, workspace and cached deployment/operation evidence, with no new data requests.
`GlobalActivity` owns the display choice, `views/agent/AgentViewTabs.tsx` presents it in the
bar, `src/sightline/AgentViews.tsx` shows the chosen view, `useSightlineInputs()` gathers
existing inputs only while visible, and pure `buildSightline(inputs)` builds the bounded
allow-listed object. Workspaces publish small fragments one way and remove them on
unmount; they retain ownership of every selection and draft. See the canonical
[Sightline design](sightline.md) for the contract, privacy policy and future pull-model
analysis. The chat request body and fixed server overview are unchanged.

## Fixed-message experiment

Open `http://127.0.0.1:4590/test` or **Agent test** in Studio. The dropdown
uses the installed `codex` and `claude` CLIs and their saved login. It does not
provision API keys or run a local model; inference uses the provider account.
Sign in through the selected CLI in a terminal, then **Check installation**.
Studio searches absolute PATH entries and `~/.local/bin` for standalone CLIs.
Editor extension bundles are excluded, including PATH entries and symlinks to
those bundles. Login storage stays with each native CLI; Studio does not read
or copy credentials. Its curated child environment preserves `HOME`, `USER`,
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`; Claude needs `USER` to locate its saved
macOS Keychain login. Installation and sign-in are checked separately; finding
a binary does not imply a saved login. Restart Studio after changing
its server code; **Check installation** refreshes discovery without another restart.

The current experiment supports one operation: change the string exported by
`framework-studio/src/agent-lab-message.ts`. Ask for a new demo message, choose
**Generate plan**, inspect the steps and exact diff, then separately choose
**Apply reviewed change**. Apply makes no model request. Vite updates the displayed
message after the save. This demonstrates a real source edit in Studio, with a
deliberately small authority; it does not implement general framework development.

## Enforced boundary

- Planning receives only the demo source and a prompt of at most 2,000 characters.
  It runs outside the repository in a disposable directory, with a curated environment.
  Codex uses read-only mode, ignored user config, disabled shell/hooks/apps/plugins/
  subagents/web search. Claude uses safe/plan mode, no tools and no MCP servers.
- The host validates structured output and generates a single TypeScript string
  declaration using JSON escaping. The agent supplies neither a destination path nor
  executable source, shell commands or deployment intent.
- Apply accepts only a server-owned plan ID. Plans are single-use, replaced by the
  next planning attempt, expire after ten minutes and are lost on restart. Saved
  source must still match the reviewed bytes. Custom source shapes, symlinked paths
  and hard-linked files are refused.
- One plan runs at a time. CLI output is bounded to 128 KiB and generation to 45
  seconds plus process shutdown. Existing tethered process ownership stops children
  when Studio exits. CLI diagnostics are not returned to the browser.
- Claude has a $0.10 budget setting and one-turn limit. Codex has no dollar cap here;
  its short prompt, low reasoning setting and timeout limit work, not exact spend.
  These CLI controls are layered restrictions, not proof of a hostile-code sandbox.

## Investigation result, November 2, 2026

Installed versions were Codex `0.164.0-alpha.11.1` and Claude Code `2.1.175`.
Codex reported a saved ChatGPT login; Claude reported no login. One live Codex
request through the frontend generated a plan without writing source. Keyboard
activation of Apply saved the reviewed declaration and the UI updated to
“Hello from my local coding agent”. No live Claude inference was attempted.

The source/refusal tests use injected proposals and fake CLIs, without provider
usage. Browser checks cover the plan/apply path, mobile layout, keyboard Apply,
empty prompt, provider availability and source-shape refusal. The repository-wide
`npm run verify` currently stops at existing `LayoutQuality.crowding` references
in `framework-studio/test/island-composition.test.ts`; the changed feature's
focused checks are reported separately.

## Extension boundaries

For controlled domains, add explicit operations with schemas and deterministic
writers, or translate agent proposals into Studio's existing typed review/apply
services. Domain ownership, source hashes, affected invariants and required checks
belong to each operation. A prose plan is a proposal, not an execution boundary.

General source editing now uses the Coding runtime described above. Keep model execution
delegated to the native CLI and retain the common immutable proposal/integration boundary
when adding providers or structured operations. A Git worktree or private directory alone
does not isolate credentials, network access or processes. Deployment and migration
application retain their separate authorization.

The prototype lives in `framework-studio/server/agent-lab.ts` and
`framework-studio/src/views/AgentLab.tsx`. CLI contracts were checked against
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
alongside the installed versions' help.
