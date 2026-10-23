import type { ChildProcess } from "node:child_process";
import type { AwsProblem, AwsProfileInfo, DiscoveryView, DriftView, StatusView, TeardownPlanView } from "../../shared/deploy";
import { lineSplitter, start, stopTree, studioEnvironment, tethered, type Runner, type Tools } from "./process";

/**
 * What AWS holds, read only through the repository's own commands:
 * deploy:status (profiles, discover, status, watch) and destroy:resources
 * --plan. Studio has no AWS SDK and makes no AWS call of its own, so the CLI
 * and Studio see one truth by one set of rules.
 *
 * Reads are cached briefly and shared while in flight, so a page that asks
 * twice starts one process.
 */

export type Observation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: AwsProblem };

const STATUS_SCRIPT = "scripts/deployment-status.ts";
const DESTROY_SCRIPT = "scripts/destroy.ts";
const KINDS = new Set<AwsProblem["kind"]>(["missing-cli", "no-credentials", "expired", "profile", "denied", "not-found", "throttled", "failed"]);

export function interpret<T>(result: { code: number | null; stdout: string; stderr: string }): Observation<T> {
  const text = result.stdout.trim();
  let parsed: any;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error && typeof parsed.error.message === "string") {
    const kind = KINDS.has(parsed.error.kind) ? parsed.error.kind : "failed";
    return { ok: false, problem: { kind, message: parsed.error.message } };
  }
  if (result.code === 0 && parsed !== undefined) return { ok: true, value: parsed as T };
  const lines = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { ok: false, problem: { kind: "failed", message: lines.pop() ?? `The command exited with code ${String(result.code)}.` } };
}

export interface WatchLine {
  readonly type: "context" | "stacks" | "event" | "idle";
  readonly [key: string]: unknown;
}

export class AwsObserver {
  private readonly cache = new Map<string, { at: number; promise: Promise<Observation<unknown>> }>();
  private readonly watches = new Set<ChildProcess>();

  constructor(private readonly tools: Tools, private readonly run: Runner, private readonly baseEnv: NodeJS.ProcessEnv) {}

  private read<T>(key: string, ttlMs: number, force: boolean, args: readonly string[], profile?: string, script = STATUS_SCRIPT): Promise<Observation<T>> {
    const cached = this.cache.get(key);
    if (cached && !force && Date.now() - cached.at < ttlMs) return cached.promise as Promise<Observation<T>>;
    const promise = this.run(this.tools.script(script, args, studioEnvironment(this.baseEnv, { profile })), { timeoutMs: 180_000 })
      .then((result) => interpret<T>(result));
    this.cache.set(key, { at: Date.now(), promise });
    // A failed read is not remembered: the next ask tries again.
    void promise.then((observation) => { if (!observation.ok && this.cache.get(key)?.promise === promise) this.cache.delete(key); });
    return promise;
  }

  /** Drops what was read for a profile (or everything), after a change or a sign-in. */
  invalidate(profile?: string): void {
    for (const key of this.cache.keys()) if (!profile || key.includes(`|${profile}|`)) this.cache.delete(key);
  }

  async profiles(force = false): Promise<AwsProfileInfo[]> {
    const observation = await this.read<AwsProfileInfo[]>("profiles", 30_000, force, ["profiles", "--json"]);
    return observation.ok && Array.isArray(observation.value) ? observation.value : [];
  }

  discover(profile: string, region: string | undefined, force = false): Promise<Observation<DiscoveryView>> {
    return this.read(`discover|${profile}|${region ?? ""}`, 20_000, force, ["discover", "--profile", profile, ...(region ? ["--region", region] : []), "--json"], profile);
  }

  status(profile: string, deployment: string, region: string | undefined, force = false): Promise<Observation<StatusView>> {
    return this.read(`status|${profile}|${region ?? ""}|${deployment}`, 4_000, force, ["status", "--deployment", deployment, "--profile", profile, ...(region ? ["--region", region] : []), "--json"], profile);
  }

  /** What deleting a deployment would remove and leave behind. Reads only. */
  teardown(profile: string, deployment: string, mode: "dev" | "prod", region: string | undefined, retainFailed = false, disableProtection = false): Promise<Observation<TeardownPlanView>> {
    return this.read(`teardown|${profile}|${region ?? ""}|${deployment}|${Date.now()}`, 0, true,
      ["--deployment", deployment, "-c", `prodDeployment=${mode === "prod"}`, "--profile", profile, ...(region ? ["--region", region] : []), ...(retainFailed ? ["--retain-failed"] : []), ...(disableProtection ? ["--allow-disable-protection"] : []), "--plan", "--json"], profile, DESTROY_SCRIPT);
  }

  /** A drift report from a drift job's output. */
  static drift(stdout: string): DriftView | undefined {
    const observation = interpret<DriftView>({ code: 0, stdout, stderr: "" });
    return observation.ok ? observation.value : undefined;
  }

  /**
   * Follows a deployment's stacks and new stack events until stopped: one
   * long-lived deploy:status watch, each JSON line handed on.
   */
  watch(profile: string, deployment: string, region: string | undefined, onLine: (line: WatchLine) => void): { stop(): void } {
    const spec = this.tools.script(STATUS_SCRIPT, ["watch", "--deployment", deployment, "--profile", profile, ...(region ? ["--region", region] : []), "--follow", "--json", "--interval", this.baseEnv.FRAMEWORK_POLL_MS ?? "3000"], studioEnvironment(this.baseEnv, { profile }));
    let child: ChildProcess;
    // Tethered: a watch never keeps polling AWS after Studio is gone.
    try { child = start(tethered(spec)); } catch { return { stop() {} }; }
    this.watches.add(child);
    const lines = lineSplitter((line) => {
      try {
        const parsed = JSON.parse(line) as WatchLine;
        if (parsed && typeof parsed.type === "string") onLine(parsed);
      } catch { /* Not a line of the watch's own. */ }
    });
    child.stdout!.on("data", (chunk: Buffer) => lines.push(chunk));
    child.stderr!.resume();
    child.on("error", () => {});
    child.on("close", () => { lines.flush(); this.watches.delete(child); });
    return { stop: () => { stopTree(child, false); this.watches.delete(child); } };
  }

  dispose(): void {
    for (const child of this.watches) stopTree(child, false);
    this.watches.clear();
  }
}
