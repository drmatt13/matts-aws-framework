import type { ChildProcess } from "node:child_process";
import type { AccountContext, AwsProblem, AwsProfileInfo, DiscoveryView, DriftView, StatusView, TeardownPlanView } from "../../shared/deploy";
import { lineSplitter, start, stopTree, studioEnvironment, tethered, type Runner, type Tools } from "./process";
import { classifyAwsConnectionError, readAwsFiles } from "../../../scripts/aws-connections";

/**
 * What AWS holds, read only through the repository's own commands:
 * deploy:status (profiles, discover, status, watch) and destroy:resources
 * --plan. Credential resolution is shared with connection management.
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
  return { ok: false, problem: { kind: "failed", message: classifyAwsConnectionError(result.stderr).message } };
}

export interface WatchLine {
  readonly type: "context" | "stacks" | "event" | "idle";
  readonly [key: string]: unknown;
}

interface CachedObservation {
  readonly profile?: string;
  readonly promise: Promise<Observation<unknown>>;
  /** Pending requests are shared regardless of their age or a forced refresh. */
  completedAt?: number;
}

export class AwsObserver {
  private readonly cache = new Map<string, CachedObservation>();
  private readonly watches = new Set<ChildProcess>();
  private teardownSequence = 0;

  constructor(private readonly tools: Tools, private readonly run: Runner, private readonly baseEnv: NodeJS.ProcessEnv) {}

  private read<T>(key: string, ttlMs: number, force: boolean, args: readonly string[], profile?: string, script = STATUS_SCRIPT): Promise<Observation<T>> {
    key = `${readAwsFiles(this.baseEnv).revision}|${key}`;
    const cached = this.cache.get(key);
    if (cached && (cached.completedAt === undefined || !force && Date.now() - cached.completedAt < ttlMs))
      return cached.promise as Promise<Observation<T>>;
    const promise = this.run(this.tools.script(script, args, studioEnvironment(this.baseEnv, { profile })), { timeoutMs: 180_000 })
      .then((result) => interpret<T>(result));
    const entry: CachedObservation = { profile, promise };
    this.cache.set(key, entry);
    void promise.then((observation) => {
      // Invalidation starts a new generation. An older completion belongs only
      // to its original callers, never to the replacement cache entry.
      if (this.cache.get(key) !== entry) return;
      if (observation.ok) entry.completedAt = Date.now();
      else this.cache.delete(key);
    }, () => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return promise;
  }

  /** Drops what was read for a profile (or everything), after a change or a sign-in. */
  invalidate(profile?: string): void {
    for (const [key, entry] of this.cache) if (!profile || entry.profile === profile) this.cache.delete(key);
  }

  async profiles(force = false): Promise<AwsProfileInfo[]> {
    const observation = await this.read<AwsProfileInfo[]>("profiles", 30_000, force, ["profiles", "--json"]);
    return observation.ok && Array.isArray(observation.value) ? observation.value : [];
  }

  discover(profile: string, region: string | undefined, force = false): Promise<Observation<DiscoveryView>> {
    return this.read(`discover|${profile}|${region ?? ""}`, 20_000, force, ["discover", "--profile", profile, ...(region ? ["--region", region] : []), "--json"], profile);
  }

  identity(profile: string, force = false): Promise<Observation<{ context: AccountContext }>> {
    return this.read(`identity|${profile}|`, 30_000, force, ["identity", "--profile", profile, "--json"], profile);
  }

  status(profile: string, deployment: string, region: string | undefined, force = false): Promise<Observation<StatusView>> {
    return this.read(`status|${profile}|${region ?? ""}|${deployment}`, 4_000, force, ["status", "--deployment", deployment, "--profile", profile, ...(region ? ["--region", region] : []), "--json"], profile);
  }

  /** What deleting a deployment would remove and leave behind. Reads only. */
  teardown(profile: string, deployment: string, mode: "dev" | "prod", region: string | undefined, retainFailed = false, disableProtection = false): Promise<Observation<TeardownPlanView>> {
    return this.read(`teardown|${profile}|${region ?? ""}|${deployment}|${this.teardownSequence++}`, 0, true,
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
