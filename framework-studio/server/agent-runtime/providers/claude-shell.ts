import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExecutionPolicy } from "../policy";
import { CodexConnection, probeCodexBoundary } from "./codex";
import type { ProviderOptions } from "./types";
import type { ValidationResult } from "./validation";
import { commandSummary, emitText } from "./events";

export const STUDIO_SHELL_SERVER = "studio_shell";
export const STUDIO_SHELL_TOOL = "mcp__studio_shell__run";
export function shellInput(value: unknown): value is { command: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { command?: unknown }).command === "string"
    && (value as { command: string }).command.length > 0 && (value as { command: string }).command.length <= 32_000
    && !(value as { command: string }).command.includes("\0");
}

/** One SDK MCP capability. No sampling, roots, arbitrary servers or tool schemas. */
export async function studioShellMessage(server: unknown, message: Record<string, any>, run: (command: string) => Promise<ValidationResult>) {
  if (server !== STUDIO_SHELL_SERVER || !message || message.jsonrpc !== "2.0") throw new Error("Unsupported Studio MCP request.");
  const reply = { jsonrpc: "2.0", ...(message.id !== undefined ? { id: message.id } : {}) };
  if (message.method === "initialize") return { ...reply, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: STUDIO_SHELL_SERVER, version: "1.0.0" } } };
  if (message.method === "notifications/initialized" || message.method === "ping") return { ...reply, result: {} };
  if (message.method === "tools/list") return { ...reply, result: { tools: [{ name: "run", description: "Run a shell command in the assigned isolated project. Use this tool to inspect/edit source and execute offline tests. Network, credentials, Docker, live databases, deployments and outside filesystem access are blocked. Fixed working directory and environment; output is bounded.",
    inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 32000 } }, required: ["command"], additionalProperties: false } }] } };
  if (message.method !== "tools/call" || message.params?.name !== "run" || !shellInput(message.params.arguments))
    return { ...reply, error: { code: -32602, message: "Only the fixed Studio shell tool with a command string is available." } };
  const result = await run(message.params.arguments.command);
  return { ...reply, result: { isError: result.exitCode !== 0, content: [{ type: "text", text: JSON.stringify(result) }] } };
}

export interface RestrictedShell { execute(command: string): Promise<ValidationResult>; close(): Promise<void> }

/** Claude never executes source itself. The model-free Codex command boundary
 * supplies the same verified filesystem/network/process restrictions as Codex.
 */
export function createRestrictedShell(policy: ExecutionPolicy, options: Pick<ProviderOptions, "signal" | "onEvent" | "onExecution">): RestrictedShell {
  let connection: CodexConnection | undefined, initialized: Promise<void> | undefined;
  let activeProcessId: string | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    options.signal.removeEventListener("abort", abort);
    if (connection) {
      // command/exec owns its own execution group. Terminate it through the
      // native protocol before EOF closes the supervising app-server tether.
      if (activeProcessId) await connection.request("command/exec/terminate", { processId: activeProcessId }, 1500).catch(() => {});
      connection.transport.stop(); await connection.transport.closed;
    }
  })();
  const abort = () => { void close(); };
  options.signal.addEventListener("abort", abort, { once: true });
  return {
    async execute(command) {
      if (options.signal.aborted || closing) throw new Error("Studio shell cancelled.");
      if (!shellInput({ command })) throw new Error("Invalid Studio shell command.");
      if (!connection) {
        connection = new CodexConnection(policy, async () => {}, { isolatedConfig: true });
        const current = connection;
        initialized = (async () => {
          if (options.onExecution) await options.onExecution(current.transport.executionIdentity());
          await current.initialize();
          await probeCodexBoundary(current, policy);
        })();
      }
      await initialized;
      await options.onEvent({ type: "command", data: { phase: "started", provider: "claude", executor: "codex-sandbox", ...commandSummary(command), cwd: policy.cwd } });
      // Avoid /bin/sh's macOS selector and PATH search through authored entries.
      const shell = realpathSync(process.platform === "darwin" ? "/private/var/select/sh" : "/bin/sh");
      if (!/^\/(?:usr\/)?bin\/[^/]+$/.test(shell)) throw new Error("Trusted system shell is unavailable.");
      if (options.signal.aborted || closing) throw new Error("Studio shell cancelled.");
      const processId = randomUUID(); activeProcessId = processId;
      let result: any;
      try { result = await connection.request("command/exec", { command: [shell, "-c", command], cwd: policy.cwd, processId,
        permissionProfile: policy.profile, env: policy.commandEnvironment, timeoutMs: 120_000, outputBytesCap: 32_768 }, 125_000); }
      finally { activeProcessId = undefined; }
      if (!Number.isInteger(result.exitCode)) throw new Error("Studio shell returned no exit status.");
      const stdout = String(result.stdout ?? "").slice(0, 32768), stderr = String(result.stderr ?? "").slice(0, 32768);
      const value = { exitCode: result.exitCode, stdout, stderr, outputTruncated: Buffer.byteLength(stdout) >= 32768 || Buffer.byteLength(stderr) >= 32768 };
      await emitText(options.onEvent, "command", { phase: "output", provider: "claude", executor: "codex-sandbox" }, "stdout", stdout);
      await emitText(options.onEvent, "command", { phase: "output", provider: "claude", executor: "codex-sandbox" }, "stderr", stderr);
      await options.onEvent({ type: "command", data: { phase: "completed", provider: "claude", executor: "codex-sandbox", exitCode: value.exitCode, outputTruncated: value.outputTruncated } });
      return value;
    },
    close,
  };
}
