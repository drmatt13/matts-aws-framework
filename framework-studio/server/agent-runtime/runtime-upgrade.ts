import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { realpathSync } from "node:fs";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import type { ExecutionIdentity } from "../../shared/operations";
import { identityAlive, processIdentity } from "../operations/identity";
import { withSourceRead } from "../edits/source-gate";
import { AgentRuntimeError, AgentTaskStore } from "./store";
import { readAgentRuntimeRelease, type AgentRuntimeRelease } from "./runtime-release-manifest";

export interface UpgradeHost {
  readonly protocol: number;
  readonly releaseDigest: string;
  readonly identity: ExecutionIdentity;
}
export interface RuntimeUpgradeIntent {
  readonly version: 1;
  readonly requestId: string;
  /** Explicitly approved replacement of this failed request; part of idempotency. */
  readonly replacesRequestId?: string;
  readonly root: string;
  readonly protocol: number;
  readonly previous: UpgradeHost;
  readonly targetDigest: string;
  /** Set durably before spawn; absence of an IPC endpoint cannot prove exit. */
  readonly launchPending?: true;
  readonly launchedIdentity?: ExecutionIdentity;
  readonly phase: "prepared" | "draining" | "starting" | "ready" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message?: string;
}
export type RuntimeLaunchReceipt = { readonly identity: ExecutionIdentity } | { readonly exited: true };
export interface RuntimeUpgradeHooks {
  readonly pin: () => Promise<{ readonly release: AgentRuntimeRelease; readonly protocol: number }>;
  /** Must validate the connected host's checkout and private state identity. */
  readonly inspect: () => Promise<UpgradeHost | undefined>;
  /** Atomically refuses busy hosts, closes admissions, then acknowledges drain. */
  readonly drain: (host: UpgradeHost, intent: RuntimeUpgradeIntent) => Promise<void>;
  /** Return a verified child identity or observed exit of this owned child. */
  readonly launch: (release: AgentRuntimeRelease) => Promise<RuntimeLaunchReceipt>;
  readonly alive?: (identity: ExecutionIdentity) => boolean | undefined;
  /** Disposable lifecycle tests supply identities and a clock without processes. */
  readonly owner?: () => ExecutionIdentity;
  readonly wait?: () => Promise<void>;
  readonly attempts?: number;
}
const HASH = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
function validIdentity(value: ExecutionIdentity | undefined): value is ExecutionIdentity {
  return !!value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.uid) && value.uid >= 0 && typeof value.started === "string" && !!value.started && typeof value.token === "string" && !!value.token;
}
function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity): boolean { return a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.token === b.token; }
function sameProcess(a: ExecutionIdentity, b: ExecutionIdentity): boolean { return a.pid === b.pid && a.uid === b.uid && a.started === b.started; }
function validHost(value: UpgradeHost | undefined): value is UpgradeHost { return !!value && Number.isSafeInteger(value.protocol) && HASH.test(value.releaseDigest) && validIdentity(value.identity); }
function open(root: string, state: string): DatabaseSync {
  // Reuse the canonical owner/type/path validation and the existing database.
  const store = new AgentTaskStore(state, root), directory = store.directory; store.close();
  const db = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runtime_upgrade (singleton INTEGER PRIMARY KEY CHECK(singleton=1), intent TEXT, owner TEXT); INSERT OR IGNORE INTO runtime_upgrade VALUES(1,NULL,NULL); CREATE TABLE IF NOT EXISTS runtime_upgrade_history (request_id TEXT PRIMARY KEY, intent TEXT NOT NULL, archived_at TEXT NOT NULL)");
    return db;
  } catch (error) { db.close(); throw error; }
}
function atomic<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = action(); db.exec("COMMIT"); return value; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ } throw error; }
}
function validateIntent(intent: RuntimeUpgradeIntent, root: string): void {
  if (intent.version !== 1 || intent.root !== root || !REQUEST_ID.test(intent.requestId) || intent.replacesRequestId !== undefined && (!REQUEST_ID.test(intent.replacesRequestId) || intent.replacesRequestId === intent.requestId) || !HASH.test(intent.targetDigest) || !validHost(intent.previous) || intent.launchPending !== undefined && intent.launchPending !== true || intent.launchedIdentity !== undefined && !validIdentity(intent.launchedIdentity) || !Number.isSafeInteger(intent.protocol) || !["prepared", "draining", "starting", "ready", "failed"].includes(intent.phase)) throw new AgentRuntimeError(409, "Runtime upgrade evidence needs inspection. Its target and task records were preserved.");
}
function row(db: DatabaseSync, root: string): { intent?: RuntimeUpgradeIntent; owner?: ExecutionIdentity } {
  const value = db.prepare("SELECT intent,owner FROM runtime_upgrade WHERE singleton=1").get()!;
  const intent = value.intent === null ? undefined : JSON.parse(String(value.intent)) as RuntimeUpgradeIntent;
  const owner = value.owner === null ? undefined : JSON.parse(String(value.owner)) as ExecutionIdentity;
  if (owner && !validIdentity(owner)) throw new AgentRuntimeError(409, "Runtime upgrade evidence needs inspection. Its target and task records were preserved.");
  if (intent) validateIntent(intent, root);
  return { intent, owner };
}
export function readAgentRuntimeUpgradeHistory(root: string, state: string): readonly RuntimeUpgradeIntent[] {
  root = realpathSync(root); const db = open(root, state);
  try {
    return db.prepare("SELECT intent FROM runtime_upgrade_history ORDER BY archived_at,rowid").all().map(value => {
      const intent = JSON.parse(String(value.intent)) as RuntimeUpgradeIntent; validateIntent(intent, root); return intent;
    });
  } finally { db.close(); }
}
function assertNoLiveHostClaim(db: DatabaseSync, alive: (identity: ExecutionIdentity) => boolean | undefined): void {
  const value = db.prepare("SELECT value FROM metadata WHERE key='host'").get();
  if (!value) return;
  const identity = JSON.parse(String(value.value)) as ExecutionIdentity;
  if (!validIdentity(identity) || alive(identity) !== false) throw new AgentRuntimeError(409, "A retained agent host identity has not provably stopped. Inspect its startup before launching a replacement.");
}
function assertLaunchStopped(intent: RuntimeUpgradeIntent, alive: (identity: ExecutionIdentity) => boolean | undefined): void {
  if (intent.launchPending) throw new AgentRuntimeError(409, "The previous launch outcome is unknown. Inspect the owned child before retrying; no duplicate was launched.");
  if (intent.launchedIdentity && alive(intent.launchedIdentity) !== false) throw new AgentRuntimeError(409, "The previously launched agent host has not provably stopped. No duplicate was launched.");
}
export function readAgentRuntimeUpgrade(root: string, state: string): RuntimeUpgradeIntent | undefined {
  root = realpathSync(root); const db = open(root, state);
  try { return row(db, root).intent; } finally { db.close(); }
}
function targetRelease(state: string, intent: RuntimeUpgradeIntent): AgentRuntimeRelease {
  const release = readAgentRuntimeRelease(path.join(realpathSync(state), "releases", intent.targetDigest));
  if (release.digest !== intent.targetDigest || release.protocol !== intent.protocol || intent.protocol !== AGENT_RUNTIME_VERSION) throw new AgentRuntimeError(409, "The requested pinned runtime is incompatible or changed. No replacement was launched.");
  return release;
}

/**
 * Called by normal client startup only after its connection failed. A durable
 * upgrade can never silently fall back to newly compiled or older source.
 */
export function pendingAgentRuntimeRelease(root: string, state: string, alive: (identity: ExecutionIdentity) => boolean | undefined = identityAlive): AgentRuntimeRelease | undefined {
  root = realpathSync(root); const db = open(root, state);
  try {
    const { intent, owner } = row(db, root);
    if (!intent) return;
    if (intent.phase === "failed") throw new AgentRuntimeError(409, "Agent runtime upgrade needs an explicit retry of its retained request. Its pinned target and tasks were preserved.");
    if (owner && alive(owner) !== false) throw new AgentRuntimeError(503, "Agent runtime upgrade is still owned by another observer. Wait for it to finish.");
    if (alive(intent.previous.identity) !== false) throw new AgentRuntimeError(409, "The previous agent host has not provably stopped. No replacement was launched.");
    assertLaunchStopped(intent, alive);
    assertNoLiveHostClaim(db, alive);
    return targetRelease(state, intent);
  } finally { db.close(); }
}

/** Explicit observer-owned handoff. Host exit never implicitly retries coding tasks. */
export class AgentRuntimeUpgradeController {
  readonly root: string;
  readonly state: string;
  private running?: { requestId: string; replacesRequestId?: string; promise: Promise<RuntimeUpgradeIntent> };
  constructor(root: string, state: string, private readonly hooks: RuntimeUpgradeHooks) {
    this.root = realpathSync(root); const store = new AgentTaskStore(state, this.root); this.state = store.directory; store.close();
  }
  status(): RuntimeUpgradeIntent | undefined { return readAgentRuntimeUpgrade(this.root, this.state); }
  request(requestId: string): Promise<RuntimeUpgradeIntent> {
    return this.start(requestId);
  }
  replaceFailed(requestId: string, failedRequestId: string): Promise<RuntimeUpgradeIntent> {
    if (!REQUEST_ID.test(failedRequestId) || failedRequestId === requestId) return Promise.reject(new AgentRuntimeError(400, "A failed-target replacement needs distinct stable request identities."));
    return this.start(requestId, failedRequestId);
  }
  private start(requestId: string, replacesRequestId?: string): Promise<RuntimeUpgradeIntent> {
    if (!REQUEST_ID.test(requestId)) return Promise.reject(new AgentRuntimeError(400, "Runtime upgrade needs a stable request identity."));
    if (this.running) return this.running.requestId === requestId && this.running.replacesRequestId === replacesRequestId ? this.running.promise : Promise.reject(new AgentRuntimeError(409, "Another runtime upgrade or a different request payload is in progress."));
    const promise = this.run(requestId, replacesRequestId).finally(() => { this.running = undefined; });
    this.running = { requestId, replacesRequestId, promise }; return promise;
  }
  private acquire(): { owner: ExecutionIdentity; release: () => void } {
    const owner = this.hooks.owner?.() ?? processIdentity(randomUUID());
    if (!validIdentity(owner)) throw new AgentRuntimeError(409, "The runtime upgrade observer identity cannot be verified.");
    const db = open(this.root, this.state);
    try { atomic(db, () => {
      const prior = row(db, this.root).owner;
      if (prior && (this.hooks.alive ?? identityAlive)(prior) !== false) throw new AgentRuntimeError(409, "Another observer owns the runtime upgrade or its process identity cannot be reconciled.");
      db.prepare("UPDATE runtime_upgrade SET owner=? WHERE singleton=1").run(JSON.stringify(owner));
    }); } finally { db.close(); }
    return { owner, release: () => {
      const connection = open(this.root, this.state);
      try { atomic(connection, () => { if (row(connection, this.root).owner?.token === owner.token) connection.prepare("UPDATE runtime_upgrade SET owner=NULL WHERE singleton=1").run(); }); }
      finally { connection.close(); }
    } };
  }
  private save(owner: ExecutionIdentity, intent: RuntimeUpgradeIntent, replaced?: RuntimeUpgradeIntent): RuntimeUpgradeIntent {
    const db = open(this.root, this.state), next = { ...intent, updatedAt: new Date().toISOString() };
    try { atomic(db, () => {
      const current = row(db, this.root);
      if (!current.owner || !sameIdentity(current.owner, owner)) throw new AgentRuntimeError(409, "Runtime upgrade ownership changed. Preserve the pending target.");
      if (current.intent?.requestId === intent.requestId && (current.intent.targetDigest !== intent.targetDigest || current.intent.replacesRequestId !== intent.replacesRequestId)) throw new AgentRuntimeError(409, "A runtime upgrade request cannot change its pinned target or replacement identity.");
      if (replaced) {
        if (current.intent?.requestId !== replaced.requestId || current.intent.phase !== "failed" || current.intent.targetDigest !== replaced.targetDigest || intent.replacesRequestId !== replaced.requestId) throw new AgentRuntimeError(409, "The inspected failed upgrade changed. Its replacement was not selected.");
      }
      if (current.intent && current.intent.requestId !== intent.requestId) {
        if (!replaced && current.intent.phase !== "ready") throw new AgentRuntimeError(409, "A pending runtime target cannot be silently replaced.");
        db.prepare("INSERT INTO runtime_upgrade_history(request_id,intent,archived_at) VALUES(?,?,?)").run(current.intent.requestId, JSON.stringify(current.intent), next.updatedAt);
      }
      db.prepare("UPDATE runtime_upgrade SET intent=? WHERE singleton=1").run(JSON.stringify(next));
    }); return next; } finally { db.close(); }
  }
  private compatible(host: UpgradeHost): void {
    if (!validHost(host) || host.protocol !== AGENT_RUNTIME_VERSION) throw new AgentRuntimeError(409, "The running agent host needs an explicitly compatible protocol before managed upgrade.");
  }
  private ready(owner: ExecutionIdentity, intent: RuntimeUpgradeIntent, host: UpgradeHost): RuntimeUpgradeIntent {
    if (intent.launchedIdentity && !sameProcess(intent.launchedIdentity, host.identity)) throw new AgentRuntimeError(409, "The ready host does not match the recorded launched process. Inspect it before proceeding.");
    return this.save(owner, { ...intent, phase: "ready", message: undefined, launchPending: undefined });
  }
  private noLiveHostClaim(alive: (identity: ExecutionIdentity) => boolean | undefined): void {
    const db = open(this.root, this.state);
    try { assertNoLiveHostClaim(db, alive); } finally { db.close(); }
  }
  private async replacementHost(failed: RuntimeUpgradeIntent, owner: ExecutionIdentity, alive: (identity: ExecutionIdentity) => boolean | undefined): Promise<UpgradeHost> {
    const current = await this.hooks.inspect();
    if (current) {
      this.compatible(current);
      if (alive(current.identity) !== true) throw new AgentRuntimeError(409, "The current agent host identity cannot be verified.");
      if (current.releaseDigest === failed.targetDigest) {
        this.ready(owner, failed, current);
        throw new AgentRuntimeError(409, "The failed target is now ready. Reconnect before requesting another runtime upgrade.");
      }
      if (!sameIdentity(current.identity, failed.previous.identity) || current.releaseDigest !== failed.previous.releaseDigest) throw new AgentRuntimeError(409, "An unexpected agent host is running. Its target was preserved for inspection.");
      assertLaunchStopped(failed, alive);
      return current;
    }
    if (alive(failed.previous.identity) !== false) throw new AgentRuntimeError(409, "The previous agent host has not provably stopped. Its failed target was preserved.");
    assertLaunchStopped(failed, alive);
    this.noLiveHostClaim(alive);
    return failed.previous;
  }
  private async run(requestId: string, replacesRequestId?: string): Promise<RuntimeUpgradeIntent> {
    const lease = this.acquire(), alive = this.hooks.alive ?? identityAlive;
    const wait = this.hooks.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 100)));
    const attempts = this.hooks.attempts ?? 100;
    let intent: RuntimeUpgradeIntent | undefined, ownedIntent = false;
    try {
      intent = this.status();
      if (intent?.requestId === requestId) {
        if (intent.replacesRequestId !== replacesRequestId) throw new AgentRuntimeError(409, "Retry the same runtime upgrade request and failed-target replacement identity.");
        if (intent.phase === "ready") {
          const ready = await this.hooks.inspect();
          if (ready) {
            this.compatible(ready);
            if (ready.releaseDigest !== intent.targetDigest || alive(ready.identity) !== true) throw new AgentRuntimeError(409, "The connected host no longer matches this ready upgrade. Inspect it before proceeding.");
            return this.ready(lease.owner, intent, ready);
          }
          // Ordinary crash recovery preserves the activated release and uses
          // the same durable launch/identity checks as an interrupted handoff.
        }
      }
      const replacing = intent?.requestId !== requestId && replacesRequestId !== undefined;
      if (replacing && (!intent || intent.phase !== "failed" || intent.requestId !== replacesRequestId)) throw new AgentRuntimeError(409, "Only the inspected failed runtime upgrade can be explicitly replaced.");
      if (intent && intent.requestId !== requestId && intent.phase !== "ready" && !replacing) throw new AgentRuntimeError(409, "Retry the retained runtime upgrade request; another request cannot replace its pinned target.");
      if (!intent || intent.requestId !== requestId) {
        const db = open(this.root, this.state);
        try { if (db.prepare("SELECT 1 FROM runtime_upgrade_history WHERE request_id=?").get(requestId)) throw new AgentRuntimeError(409, "This runtime upgrade identity belongs to retained history. Use a new request identity."); } finally { db.close(); }
        const failed = replacing ? intent! : undefined;
        let current = failed ? await this.replacementHost(failed, lease.owner, alive) : await this.hooks.inspect();
        if (!current) throw new AgentRuntimeError(409, "Reconnect to the current agent host before requesting its upgrade.");
        this.compatible(current);
        if (!failed && alive(current.identity) !== true) throw new AgentRuntimeError(409, "The current agent host identity cannot be verified.");
        const pinned = await withSourceRead(this.root, this.hooks.pin);
        if (pinned.protocol !== AGENT_RUNTIME_VERSION || pinned.release.protocol !== pinned.protocol) throw new AgentRuntimeError(409, "The proposed agent host protocol is incompatible. The current host was preserved.");
        // Pinning may take time. A late startup must be observed before replacing
        // its failed intent, and retained process claims must be provably dead.
        if (failed) current = await this.replacementHost(failed, lease.owner, alive);
        const at = new Date().toISOString();
        intent = { version: 1, requestId, ...(replacesRequestId ? { replacesRequestId } : {}), root: this.root, protocol: pinned.protocol, previous: current, targetDigest: pinned.release.digest, phase: "prepared", createdAt: at, updatedAt: at };
        // Validate the exact private path/bytes before persisting any drain intent.
        const release = targetRelease(this.state, intent);
        if (release.directory !== pinned.release.directory) throw new AgentRuntimeError(409, "Runtime upgrade target is outside the retained release store.");
        intent = this.save(lease.owner, intent, failed);
      }
      ownedIntent = true;
      const release = targetRelease(this.state, intent);
      let current = await this.hooks.inspect();
      if (current) {
        this.compatible(current);
        if (current.releaseDigest === intent.targetDigest && alive(current.identity) === true) return this.ready(lease.owner, intent, current);
        if (!sameIdentity(current.identity, intent.previous.identity)) throw new AgentRuntimeError(409, "Another agent host replaced the recorded owner. Inspect it before retrying this upgrade.");
        intent = this.save(lease.owner, { ...intent, phase: "draining", message: undefined });
        await this.hooks.drain(current, intent);
      }
      let stopped = false;
      for (let i = 0; i < attempts; i++) {
        const active = alive(intent.previous.identity);
        if (active === false) { stopped = true; break; }
        if (active === undefined) throw new AgentRuntimeError(409, "The previous agent host identity cannot be reconciled. It was not killed and no replacement was launched.");
        await wait();
      }
      if (!stopped) throw new AgentRuntimeError(409, "The previous agent host has not finished draining. No replacement was launched.");
      current = await this.hooks.inspect();
      if (current) {
        this.compatible(current);
        if (current.releaseDigest === intent.targetDigest && alive(current.identity) === true) return this.ready(lease.owner, intent, current);
        throw new AgentRuntimeError(409, "An unexpected agent host owns the endpoint. No replacement was launched.");
      }
      assertLaunchStopped(intent, alive); this.noLiveHostClaim(alive);
      intent = this.save(lease.owner, { ...intent, phase: "starting", message: undefined, launchPending: true, launchedIdentity: undefined });
      const launched = await this.hooks.launch(release);
      if ("identity" in launched && validIdentity(launched.identity)) intent = this.save(lease.owner, { ...intent, launchPending: undefined, launchedIdentity: launched.identity });
      else if ("exited" in launched && launched.exited === true) intent = this.save(lease.owner, { ...intent, launchPending: undefined });
      else throw new AgentRuntimeError(409, "The launched agent host identity cannot be verified. Its launch remains pending inspection.");
      for (let i = 0; i < attempts; i++) {
        const ready = await this.hooks.inspect();
        if (ready) {
          this.compatible(ready);
          if (ready.releaseDigest !== intent.targetDigest || sameIdentity(ready.identity, intent.previous.identity)) throw new AgentRuntimeError(409, "The replacement host did not match the pinned target and a new process identity.");
          if (alive(ready.identity) === true) return this.ready(lease.owner, intent, ready);
        }
        await wait();
      }
      throw new AgentRuntimeError(503, "The pinned agent host did not become ready. Its release and all task records remain retained; inspect startup before retrying.");
    } catch (error) {
      if (intent && ownedIntent) this.save(lease.owner, { ...intent, phase: "failed", message: error instanceof AgentRuntimeError ? error.message : "Runtime upgrade failed. Its exact target and task records were retained for inspection." });
      throw error;
    } finally { lease.release(); }
  }
}
