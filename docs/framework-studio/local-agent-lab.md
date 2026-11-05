# Local coding agents

## Agent panel

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

This first version provides general guidance with a short built-in Studio overview.
It does not inspect the current graph, source files or operation logs. The request
contains a bounded recent conversation; the agent has no tools or source-write access.
`src/agent-chat.ts` owns session state, `views/agent/AgentPanel.tsx` owns chat presentation,
and `POST /api/agent-lab/chat` uses the existing bounded CLI runner. The request is
aborted when the browser stops it or disconnects. No API-key setup is required.

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

## Extending this into framework development

For controlled domains, add explicit operations with schemas and deterministic
writers, or translate agent proposals into Studio's existing typed review/apply
services. Domain ownership, source hashes, affected invariants and required checks
belong to each operation. A prose plan is a proposal, not an execution boundary.

For general code editing, use a separate supervisor and disposable checkout outside
the running Studio tree. A Git worktree separates files but does not isolate host
credentials, network access or processes; constrain those separately. Produce an
immutable patch, reject protected/generated/secret paths, run the applicable checks
there and review the full resulting diff. Import only that reviewed patch after
checking the original source still matches, with explicit restart and recovery
handling. Deployment and migration application retain their separate authorization.
Keeping that worker independent prevents edits from killing its own supervisor.

The prototype lives in `framework-studio/server/agent-lab.ts` and
`framework-studio/src/views/AgentLab.tsx`. CLI contracts were checked against
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
alongside the installed versions' help.
