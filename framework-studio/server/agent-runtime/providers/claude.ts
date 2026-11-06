import { claudeArguments, providerExecutable, type ExecutionPolicy } from "../policy";
import { createBoundaryFixture, type BoundaryFixture } from "./boundary";
import { JsonLinesProcess } from "./transport";
import type { ProviderOptions, ProviderResult } from "./types";
import { createRestrictedShell, shellInput, STUDIO_SHELL_TOOL, studioShellMessage, type RestrictedShell } from "./claude-shell";
import { commandSummary, emitText } from "./events";

export function claudePermissionAllowed(policy: ExecutionPolicy, tool: string, input: Record<string, unknown>): boolean {
  void policy;
  return tool === STUDIO_SHELL_TOOL && shellInput(input);
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap(entry => entry && typeof entry.text === "string" ? [entry.text] : []).join("\n");
  return "";
}

/** Native Claude owns the coding loop. The first controlled turn proves its
 * actual bridged shell boundary with disposable resources before user work.
 */
export async function runClaude(options: ProviderOptions, policy: ExecutionPolicy,
  dependencies: { fixture?: (policy: ExecutionPolicy) => Promise<BoundaryFixture>; shell?: RestrictedShell } = {}): Promise<ProviderResult> {
  let fixture: BoundaryFixture | undefined, sessionId = options.sessionId;
  let outcome: ProviderResult | undefined;
  let phase: "initializing" | "probe" | "coding" = "initializing";
  let currentResolve: ((result: Record<string, any>) => void) | undefined;
  let probeToolId: string | undefined, probeOutput = "", probeToolSucceeded = false;
  let initializedResolve!: () => void;
  const initialized = new Promise<void>(resolve => { initializedResolve = resolve; });
  let sessionReadyResolve!: () => void;
  const sessionReady = new Promise<void>(resolve => { sessionReadyResolve = resolve; });
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  const shell = dependencies.shell ?? createRestrictedShell(policy, options);
  const transport = new JsonLinesProcess(providerExecutable("claude", policy.environment), claudeArguments(policy, options.model, options.sessionId), policy.cwd,
    { ...policy.environment, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }, async message => {
      if (message.type === "control_response" && message.response?.request_id === "initialize") {
        if (message.response?.subtype !== "success") throw new Error("Claude initialization failed.");
        initializedResolve(); return;
      }
      if (message.type === "control_request") {
        const request = message.request ?? {}, input = request.input ?? {}, id = String(message.request_id);
        if (request.subtype === "mcp_message") {
          const response = await studioShellMessage(request.server_name, request.message, async command => {
            if (options.signal.aborted) throw new Error("Studio shell cancelled.");
            // The user's coding task already authorizes offline work within
            // this immutable boundary. Source import remains a separate action.
            const allowed = phase === "coding" || phase === "probe" && command === fixture?.shellCommand;
            if (!allowed) throw new Error("The host did not authorize this Studio shell command; no command ran.");
            return shell.execute(command);
          });
          transport.send({ type: "control_response", response: { subtype: "success", request_id: id, response: { mcp_response: response } } });
          return;
        }
        let allowed = false;
        if (request.subtype === "can_use_tool" && !options.signal.aborted) {
          if (phase === "probe") allowed = request.tool_name === STUDIO_SHELL_TOOL && shellInput(input) && input.command === fixture?.shellCommand;
          else if (phase === "coding") allowed = claudePermissionAllowed(policy, request.tool_name, input);
        }
        await options.onEvent({ type: "permission", data: { id, tool: request.tool_name, phase, decision: allowed ? "allowed" : "denied" } });
        transport.send({ type: "control_response", response: { subtype: "success", request_id: id, response: allowed
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "This action is outside the task's fixed offline coding permissions." } } });
        return;
      }
      if (message.type === "system" && message.subtype === "init") {
        if (!Array.isArray(message.tools) || message.tools.some((tool: unknown) => tool !== STUDIO_SHELL_TOOL)) throw new Error("Claude exposed capabilities outside the single restricted Studio shell; coding remains disabled.");
        if (typeof message.session_id !== "string" || !message.session_id || options.sessionId && message.session_id !== options.sessionId) throw new Error("Claude did not retain the assigned native session.");
        sessionId = message.session_id;
        await options.onEvent({ type: "session", data: { sessionId, provider: "claude" } });
        await options.onEvent({ type: "status", data: { phase: "native_initialized", provider: "claude", tools: Array.isArray(message.tools) ? message.tools.filter((tool: unknown) => typeof tool === "string").slice(0, 30) : [], permissionMode: message.permissionMode } });
        sessionReadyResolve();
      }
      if (message.type === "stream_event" && phase === "coding" && message.event?.type === "content_block_delta" && message.event.delta?.type === "text_delta")
        await emitText(options.onEvent, "message", {}, "text", String(message.event.delta.text));
      if (message.type === "assistant") for (const block of message.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        const input = block.input ?? {}; tools.set(block.id, { name: block.name, input });
        if (phase === "probe" && block.name === STUDIO_SHELL_TOOL && input.command === fixture?.shellCommand) probeToolId = block.id;
        if (phase === "coding") await options.onEvent({ type: "command", data: { phase: "requested", itemId: block.id, tool: block.name, ...commandSummary(String(input.command ?? "")) } });
      }
      if (message.type === "user") for (const block of message.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const text = toolText(block.content), tool = tools.get(block.tool_use_id);
        if (phase === "probe" && block.tool_use_id === probeToolId) { probeOutput = text; probeToolSucceeded = block.is_error !== true; }
        if (phase === "coding" && tool) {
          await emitText(options.onEvent, "command", { phase: "tool_output", itemId: block.tool_use_id, tool: tool.name }, "text", text);
          await options.onEvent({ type: "command", data: { phase: "tool_result", itemId: block.tool_use_id, tool: tool.name, status: block.is_error ? "failed" : "completed" } });
        }
      }
      if (message.type === "result") currentResolve?.(message);
    }, async () => {});
  // A dead model process must not leave its last command running until timeout.
  void transport.exited.then(() => shell.close());
  const abort = () => { transport.send({ type: "control_request", request_id: "interrupt", request: { subtype: "interrupt", cancel_queued: true } }); transport.stop(); void shell.close(); };
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => transport.fail(new Error("Claude coding task exceeded 30 minutes.")), 30 * 60_000);
  const initializationTimeout = setTimeout(() => transport.fail(new Error("Claude initialization timed out.")), 30_000);
  const turn = async (text: string) => {
    const result = new Promise<Record<string, any>>(resolve => { currentResolve = resolve; });
    transport.send({ type: "user", message: { role: "user", content: text }, session_id: sessionId ?? "", parent_tool_use_id: null });
    const value = await Promise.race([result, transport.closed.then(() => undefined)]);
    currentResolve = undefined;
    if (!value) throw transport.error() ?? new Error("Claude exited before completing its turn.");
    return value;
  };
  try {
    if (options.signal.aborted) return { status: "cancelled", sessionId };
    if (options.onExecution) await options.onExecution(transport.executionIdentity());
    transport.send({ type: "control_request", request_id: "initialize", request: { subtype: "initialize" } });
    // Native system/init is emitted only after the first user frame, including
    // resume. That first frame contains only the fixed sentinel command. The
    // actual source task remains withheld until its session event is durable.
    await Promise.race([initialized, transport.closed.then(() => { throw transport.error() ?? new Error("Claude initialization connection closed."); })]);
    clearTimeout(initializationTimeout);
    fixture = await (dependencies.fixture ?? createBoundaryFixture)(policy);
    phase = "probe";
    const checked = await turn(`Call ${STUDIO_SHELL_TOOL} exactly once with the command below as a sandbox capability check, without inspecting or modifying source or invoking any other tool. It touches only disposable sentinel resources owned by the host. Report completion afterward.\n${fixture.shellCommand}`);
    if (probeToolId && !probeToolSucceeded) fixture.assert(1, probeOutput);
    if (checked.is_error || !probeToolId || !probeToolSucceeded) throw new Error(`Claude did not complete the required native sandbox probe; coding remains disabled. Result=${String(checked.subtype)} toolSelected=${!!probeToolId} toolSucceeded=${probeToolSucceeded} observedTools=${[...tools.values()].map(tool => tool.name).join(",").slice(0, 300)} summary=${String(checked.result ?? "").slice(0, 1500)}`);
    fixture.assert(0, probeOutput); await fixture.dispose(); fixture = undefined;
    await Promise.race([sessionReady, transport.closed.then(() => { throw transport.error() ?? new Error("Claude session metadata was unavailable."); })]);
    await options.onEvent({ type: "status", data: { phase: "sandbox_verified", provider: "claude" } });
    phase = "coding";
    const result = await turn(`Work only inside this candidate workspace. Preserve unrelated source. Network, live repositories, credentials, Docker, database writes and deployment are unavailable. Use ${STUDIO_SHELL_TOOL} for all investigation, source edits and offline validation. Native tools are deliberately unavailable. Do not modify agent configuration.\n\n${options.prompt}`);
    outcome = { sessionId, status: options.signal.aborted ? "cancelled" : result.is_error || result.subtype !== "success" ? "failed" : "completed",
      ...(result.is_error ? { error: "The native Claude turn failed. Isolated changes were retained." } : {}) };
  } catch (error) { outcome = { sessionId, status: options.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "Claude execution failed." }; }
  finally {
    clearTimeout(timeout); clearTimeout(initializationTimeout); options.signal.removeEventListener("abort", abort);
    transport.stop(); await shell.close(); await transport.closed; await fixture?.dispose();
  }
  if (transport.error() && !options.signal.aborted) return { sessionId, status: "failed", error: transport.error()!.message };
  return outcome!;
}
