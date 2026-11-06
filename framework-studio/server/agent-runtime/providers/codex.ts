import { codexArguments, type ExecutionPolicy, providerExecutable, tomlValue } from "../policy";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JsonLinesProcess } from "./transport";
import { createBoundaryFixture } from "./boundary";
import type { ProviderOptions, ProviderResult } from "./types";
import { commandSummary, emitText } from "./events";

export class CodexConnection {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly transport: JsonLinesProcess;
  constructor(policy: ExecutionPolicy, receive: (message: Record<string, any>) => Promise<void>, options: { isolatedConfig?: boolean } = {}) {
    // Model-free command execution needs no login. A private config home avoids
    // ARG_MAX for exact-file policies without reading/copying authentication.
    const executable = providerExecutable("codex", policy.environment);
    const configHome = options.isolatedConfig ? mkdtempSync(path.join(path.dirname(policy.scratchDir), "command-runtime-")) : undefined;
    try { if (configHome) writeFileSync(path.join(configHome, "config.toml"), Object.entries(policy.config).map(([key, value]) => `${key}=${tomlValue(value)}`).join("\n") + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (configHome) rmSync(configHome, { recursive: true, force: true }); throw error; }
    const environment = configHome ? { ...policy.environment, CODEX_HOME: configHome } : policy.environment;
    this.transport = new JsonLinesProcess(executable, codexArguments(configHome ? { ...policy, config: {} } : policy), policy.runtimeDirectory, environment, async message => {
      if (typeof message.id === "number" && !message.method) {
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(new Error(`Codex rejected ${String(message.error.code ?? "request")}: ${String(message.error.message ?? "protocol failure").slice(0, 500)}`));
          else request.resolve(message.result);
        }
        return;
      }
      await receive(message);
    }, async () => {});
    void this.transport.closed.then(() => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.transport.error() ?? new Error(`Codex connection closed: ${this.transport.setupFailure()}.`)); }
      this.pending.clear();
      if (configHome) { try { rmSync(configHome, { recursive: true, force: true }); } catch { /* Retain only private, credential-free runtime state on cleanup failure. */ } }
    });
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); this.transport.stop(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "aws_studio_agent", title: "AWS Studio coding task", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.transport.send({ method: "initialized", params: {} });
  }
}

/** No model involved. Every restricted target is a disposable probe sentinel. */
export async function probeCodexBoundary(connection: CodexConnection, policy: ExecutionPolicy): Promise<void> {
  const fixture = await createBoundaryFixture(policy);
  try {
    const result = await connection.request("command/exec", { command: fixture.command, cwd: policy.cwd, permissionProfile: policy.profile, env: policy.commandEnvironment,
      timeoutMs: 5000, outputBytesCap: 4096 }, 10_000);
    fixture.assert(result.exitCode, String(result.stdout ?? ""), String(result.stderr ?? ""));
  } finally { await fixture.dispose(); }
}

function enabledMcpNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("config" in value)) throw new Error("Codex did not return an auditable effective configuration; coding remains disabled.");
  const config = (value as { config: unknown }).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Codex effective configuration is invalid.");
  const servers = (config as Record<string, unknown>).mcp_servers;
  if (servers === undefined) return [];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Codex MCP configuration cannot be safely reconciled.");
  return Object.entries(servers).flatMap(([name, server]) => {
    if (!name || name.length > 200 || !server || typeof server !== "object" || Array.isArray(server)) throw new Error("Codex MCP configuration cannot be safely reconciled.");
    return (server as { enabled?: unknown }).enabled === false ? [] : [name];
  });
}

export async function runCodex(options: ProviderOptions, policy: ExecutionPolicy,
  dependencies: { probe?: typeof probeCodexBoundary } = {}): Promise<ProviderResult> {
  let sessionId = options.sessionId, turnId: string | undefined;
  let outcome: ProviderResult | undefined;
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const emit = options.onEvent;
  const receive = async (message: Record<string, any>) => {
    const params = message.params ?? {};
    if (message.id !== undefined && message.method) {
      // These are escalation requests. The fixed coding policy has no escape hatch.
      await emit({ type: "permission", data: { id: String(message.id), method: message.method, decision: "denied", reason: "Outside the fixed offline coding policy." } });
      if (message.method === "item/permissions/requestApproval") connection.transport.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
      else if (message.method.includes("requestApproval")) connection.transport.send({ id: message.id, result: { decision: "decline" } });
      else connection.transport.send({ id: message.id, error: { code: -32601, message: "This capability is unavailable to Studio coding tasks." } });
      return;
    }
    if (message.method === "item/agentMessage/delta") await emitText(emit, "message", { itemId: params.itemId }, "text", String(params.delta ?? ""));
    else if (message.method === "item/commandExecution/outputDelta") await emitText(emit, "command", { phase: "output", itemId: params.itemId }, "text", String(params.delta ?? ""));
    else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item ?? {};
      if (item.type === "commandExecution") await emit({ type: "command", data: { phase: message.method === "item/started" ? "started" : "completed", itemId: item.id, ...commandSummary(String(item.command ?? "")), cwd: item.cwd, exitCode: item.exitCode, status: item.status } });
      if (item.type === "fileChange") {
        // Frozen source blobs own the reviewable diff. Native patch payloads can
        // be arbitrarily large; progress needs only bounded path/kind metadata.
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (!changes.length) await emit({ type: "file", data: { phase: message.method === "item/started" ? "started" : "completed", itemId: item.id, changes: [] } });
        for (const change of changes) await emit({ type: "file", data: { phase: message.method === "item/started" ? "started" : "completed", itemId: item.id,
          changes: [{ path: String(change.path ?? "").slice(0, 4000), kind: String(change.kind?.type ?? change.kind ?? "unknown").slice(0, 80) }] } });
      }
    } else if (message.method === "turn/completed") {
      const status = params.turn?.status;
      outcome = { sessionId, status: status === "completed" ? "completed" : status === "interrupted" || options.signal.aborted ? "cancelled" : "failed",
        ...(status === "failed" ? { error: "The native Codex turn failed. The isolated changes were retained." } : {}) };
      complete();
    } else if (message.method === "error") await emit({ type: "diagnostic", data: { message: "Codex reported an execution error.", retrying: params.willRetry === true } });
  };
  let connection: CodexConnection = new CodexConnection(policy, receive);
  const abort = () => {
    if (sessionId && turnId) void connection.request("turn/interrupt", { threadId: sessionId, turnId }, 1500).catch(() => {}).finally(() => connection.transport.stop());
    else connection.transport.stop();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => connection.transport.fail(new Error("Coding task exceeded the 30 minute execution limit.")), 30 * 60_000);
  try {
    if (options.signal.aborted) return { status: "cancelled", sessionId };
    if (options.onExecution) await options.onExecution(connection.transport.executionIdentity());
    await connection.initialize();
    const enabled = enabledMcpNames(await connection.request("config/read", { cwd: policy.cwd, includeLayers: false }));
    if (enabled.length) {
      // Empty maps merge with inherited tables. Disable each effective server
      // explicitly in this process's overrides, never in the saved user config.
      // CLI dotted override keys are not TOML quoted paths. A parsed inline
      // table keeps unusual server names literal and merges only enabled=false.
      const disabled = Object.fromEntries(enabled.map(name => [name, { enabled: false }]));
      policy = { ...policy, config: { ...policy.config, mcp_servers: disabled } };
      connection.transport.stop(); await connection.transport.closed;
      if (options.signal.aborted) return { sessionId, status: "cancelled" };
      connection = new CodexConnection(policy, receive);
      if (options.onExecution) await options.onExecution(connection.transport.executionIdentity());
      await connection.initialize();
      if (enabledMcpNames(await connection.request("config/read", { cwd: policy.cwd, includeLayers: false })).length)
        throw new Error("Codex could not disable all unmanaged MCP integrations; coding remains disabled.");
    }
    await (dependencies.probe ?? probeCodexBoundary)(connection, policy);
    await emit({ type: "status", data: { phase: "sandbox_verified", provider: "codex" } });
    const started = await connection.request(sessionId ? "thread/resume" : "thread/start", {
      ...(sessionId ? { threadId: sessionId, excludeTurns: true } : {}), cwd: policy.cwd,
      permissions: policy.profile, approvalPolicy: "never", config: policy.config, ...(options.model ? { model: options.model } : {}),
      developerInstructions: "Work only inside the assigned candidate workspace. Use native editing and shell tools for source changes and offline validation. Network, credentials, Docker, database access, deployment, Git mutations, and writes outside the candidate/scratch roots are unavailable. Never try to bypass these restrictions. Preserve unrelated changes. Do not modify agent configuration. Report commands and failures accurately.",
    });
    sessionId = started.thread?.id;
    if (!sessionId || started.cwd !== policy.cwd) throw new Error("Codex did not accept the assigned workspace.");
    await emit({ type: "session", data: { sessionId, provider: "codex" } });
    const turn = await connection.request("turn/start", { threadId: sessionId, cwd: policy.cwd, permissions: policy.profile,
      approvalPolicy: "never", input: [{ type: "text", text: options.prompt, text_elements: [] }] });
    turnId = turn.turn?.id;
    await Promise.race([done, connection.transport.closed]);
    if (connection.transport.error()) throw connection.transport.error();
    outcome ??= { sessionId, status: options.signal.aborted ? "cancelled" : "failed", error: options.signal.aborted ? undefined : "Codex exited before completing its turn." };
  } catch (error) {
    outcome = { sessionId, status: options.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "Codex execution failed." };
  } finally {
    clearTimeout(timeout); options.signal.removeEventListener("abort", abort);
    connection.transport.stop(); await connection.transport.closed;
  }
  if (connection.transport.error() && !options.signal.aborted) return { sessionId, status: "failed", error: connection.transport.error()!.message };
  return outcome!;
}
