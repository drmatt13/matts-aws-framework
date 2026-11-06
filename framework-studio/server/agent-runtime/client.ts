import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentRuntimeUpgradeIntentView, AgentRuntimeUpgradeView, CodingEvent, CodingProposal, CodingTask, CodingTaskRequest } from "../../shared/agent-runtime";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import { agentEndpoint, agentStateDirectory, callAgentHost, type AgentHostInfo } from "./ipc";
import { AgentRuntimeError } from "./store";
import type { agentIntegrationState, AgentIntegrationResult } from "./integration";
import { pinAgentRuntime } from "./runtime-release";
import type { ReviewedStructuredSource } from "./structured-proposal";
import type { StudioRuntimeRegistration } from "./activation";
import { AgentRuntimeUpgradeController, pendingAgentRuntimeRelease, type RuntimeUpgradeIntent, type RuntimeLaunchReceipt } from "./runtime-upgrade";
import type { AgentRuntimeRelease } from "./runtime-release-manifest";

export class AgentTaskClient {
  readonly root: string;
  readonly state: string;
  private starting?: Promise<void>;
  private closed = false;
  private registeredHost?: number;
  private upgradeController?: AgentRuntimeUpgradeController;
  constructor(root: string, state?: string, private readonly registration?: () => StudioRuntimeRegistration) { this.root = realpathSync(root); this.state = agentStateDirectory(this.root, state); }
  private endpoint(): string { return agentEndpoint(this.root, this.state); }
  private async inspect(): Promise<AgentHostInfo | undefined> {
    try {
      const info = await callAgentHost<AgentHostInfo>(this.endpoint(), "/ping", undefined, 1000);
      if (info.version !== AGENT_RUNTIME_VERSION || info.root !== this.root || info.state !== this.state) throw new AgentRuntimeError(409, "The running agent host uses another protocol or workspace. Preserve its tasks before upgrading it.");
      return info;
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  }
  private async launch(release: AgentRuntimeRelease): Promise<RuntimeLaunchReceipt> {
    return new Promise<{ child: ReturnType<typeof spawn>; exited: boolean }>(resolve => {
      const child = spawn(process.execPath, [release.entry, this.root, this.state, release.directory], { cwd: release.directory, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve({ child, exited: true as const }));
      child.once("spawn", () => { child.unref(); resolve({ child, exited: false as const }); });
    }).then(async started => {
      const { child } = started;
      if (started.exited || child.exitCode !== null || child.signalCode !== null) return { exited: true };
      const identity = child.pid && spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "uid=", "-o", "lstart="], { encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, windowsHide: true });
      const match = identity && identity.status === 0 && /^(\d+)\s+(.+)$/.exec(identity.stdout.trim());
      if (match && typeof process.getuid === "function" && Number(match[1]) === process.getuid()) return { identity: { pid: child.pid!, uid: Number(match[1]), started: match[2]!.replace(/\s+/g, " ").trim(), token: randomUUID() } };
      // Let the owned child's exit event settle. A failed ps probe by itself is
      // never proof that the new runtime stopped before claiming its IPC socket.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
      throw new AgentRuntimeError(409, "The launched agent host identity could not be verified. Its launch is retained for inspection; another host was not started.");
    });
  }
  private upgrades(): AgentRuntimeUpgradeController {
    return this.upgradeController ??= new AgentRuntimeUpgradeController(this.root, this.state, {
      pin: async () => { const release = await pinAgentRuntime(this.root, this.state); return { release, protocol: release.protocol }; },
      inspect: async () => {
        const info = await this.inspect(); if (!info) return;
        if (!info.releaseDigest || !info.identity) throw new AgentRuntimeError(409, "The running host predates managed upgrades. Preserve tasks and restart it explicitly before using this action.");
        return { protocol: info.version, releaseDigest: info.releaseDigest, identity: info.identity };
      },
      drain: async (host, intent) => { await callAgentHost(this.endpoint(), "/runtime/drain", { requestId: intent.requestId, targetDigest: intent.targetDigest, expectedToken: host.identity.token }); },
      launch: release => this.launch(release),
    });
  }
  private upgradeView(intent: RuntimeUpgradeIntent): AgentRuntimeUpgradeIntentView { return { requestId: intent.requestId, ...(intent.replacesRequestId ? { replacesRequestId: intent.replacesRequestId } : {}), targetDigest: intent.targetDigest, phase: intent.phase, ...(intent.message ? { error: intent.message } : {}) }; }
  runtimeUpgrade(): AgentRuntimeUpgradeView { const intent = this.upgrades().status(); return intent ? { intent: this.upgradeView(intent) } : {}; }
  async restartHost(requestId: string, replaceFailedRequestId?: string): Promise<AgentRuntimeUpgradeIntentView> {
    if (this.closed || !/^[a-f0-9-]{36}$/.test(requestId) || (replaceFailedRequestId !== undefined && !/^[a-f0-9-]{36}$/.test(replaceFailedRequestId))) throw new AgentRuntimeError(400, "Agent restart needs a retained request identity.");
    // Do not call ensure here: an explicit retry may need to complete a retained
    // handoff after the previous host stopped.
    return this.upgradeView(await (replaceFailedRequestId === undefined ? this.upgrades().request(requestId) : this.upgrades().replaceFailed(requestId, replaceFailedRequestId)));
  }
  private async connected(): Promise<void> {
    const info = await callAgentHost<AgentHostInfo>(this.endpoint(), "/ping", undefined, 1000);
    if (info.version !== AGENT_RUNTIME_VERSION || info.root !== this.root || info.state !== this.state) throw new AgentRuntimeError(409, "The running agent host uses another protocol or workspace. Preserve its tasks before upgrading it.");
    const intent = this.upgrades().status();
    if (intent && intent.phase !== "ready" && info.releaseDigest === intent.targetDigest) {
      // Recover only the observed outcome of an already requested handoff. This
      // cannot select a new target or launch while the matching host is alive.
      try { await (intent.replacesRequestId ? this.upgrades().replaceFailed(intent.requestId, intent.replacesRequestId) : this.upgrades().request(intent.requestId)); }
      catch (error) { if (!(error instanceof AgentRuntimeError && /Another observer owns/.test(error.message))) throw error; }
    }
    if (this.registration && this.registeredHost !== info.pid) {
      await callAgentHost(this.endpoint(), "/runtime/register", this.registration()); this.registeredHost = info.pid;
    }
  }
  private async ensure(): Promise<void> {
    if (this.closed) throw new AgentRuntimeError(503, "This task observer is closed.");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { await this.connected(); return; } catch (error) {
        if (error instanceof AgentRuntimeError) throw error;
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const retained = pendingAgentRuntimeRelease(this.root, this.state);
      if (retained) {
        const intent = this.upgrades().status();
        if (!intent || intent.targetDigest !== retained.digest) throw new AgentRuntimeError(409, "The retained agent host handoff changed. Reconnect before retrying it.");
        // The controller journals every launch attempt and its owned process
        // identity, including resumption after the previous observer died.
        await (intent.replacesRequestId ? this.upgrades().replaceFailed(intent.requestId, intent.replacesRequestId) : this.upgrades().request(intent.requestId));
        await this.connected(); return;
      }
      const release = await pinAgentRuntime(this.root, this.state);
      await this.launch(release);
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await this.connected(); const info = await this.inspect(); if (info?.releaseDigest !== release.digest) throw new AgentRuntimeError(409, "The replacement agent host differs from the retained pinned release."); return; } catch (error) { if (error instanceof AgentRuntimeError && error.status === 409) throw error; }
      }
      throw new AgentRuntimeError(503, "The independent agent host did not become available. Existing tasks were not restarted; inspect private state permissions and Node compatibility.");
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async call<T>(route: string, body?: unknown): Promise<T> { await this.ensure(); return callAgentHost<T>(this.endpoint(), route, body); }
  ping(): Promise<AgentHostInfo> { return this.call("/ping"); }
  list(): Promise<{ tasks: CodingTask[] }> { return this.call("/tasks"); }
  get(id: string): Promise<CodingTask> { return this.call(`/tasks/${encodeURIComponent(id)}`); }
  events(id: string, after = 0): Promise<{ task: CodingTask; events: CodingEvent[] }> { return this.call(`/tasks/${encodeURIComponent(id)}/events?after=${after}`); }
  proposal(id: string): Promise<CodingProposal> { return this.call(`/tasks/${encodeURIComponent(id)}/proposal`); }
  recovery(): Promise<ReturnType<typeof agentIntegrationState>> { return this.call("/recovery"); }
  recover(id: string, body: unknown): Promise<AgentIntegrationResult> { return this.call(`/recovery/${encodeURIComponent(id)}`, body); }
  submitStructured(review: ReviewedStructuredSource, requestKey: string): Promise<CodingTask> { return this.call("/structured", { review, requestKey }); }
  activate(id: string, digest: string): Promise<CodingTask> {
    if (!this.registration) throw new AgentRuntimeError(409, "This Studio observer has no managed restart registration.");
    return this.call(`/tasks/${encodeURIComponent(id)}/activate`, { digest, instanceId: this.registration().id });
  }
  async submit(request: CodingTaskRequest): Promise<CodingTask> {
    try { return await this.call("/tasks", request); } catch (error) {
      if (error instanceof AgentRuntimeError || !["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return this.call("/tasks", request); // Exact idempotency key and intent.
    }
  }
  action(id: string, action: "cancel" | "resume" | "reject" | "approve" | "refresh" | "cleanup", body: unknown = {}): Promise<CodingTask> { return this.call(`/tasks/${encodeURIComponent(id)}/${action}`, body); }
  permission(id: string, requestId: string, body: unknown): Promise<CodingTask> { return this.call(`/tasks/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, body); }
  close(): void { this.closed = true; } // Closing the observer never stops work.
}
