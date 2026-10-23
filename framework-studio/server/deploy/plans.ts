import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PlanSummaryView, PlanView, TeardownPlanView } from "../../shared/deploy";

/**
 * Reviewed plans, as deploy:resources --plan writes them: one directory each
 * under Studio's state directory (.cache/framework-studio/plans), holding plan.json, the assembly it was
 * made from, and result.json once applied. Studio reads them; only the
 * deploy script writes, applies or discards one.
 */

const KEY = /^[a-z0-9][a-z0-9-]{5,63}$/;

export type PlanSummary = PlanSummaryView;

export class PlanStore {
  readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = path.join(stateDirectory, "plans");
  }

  /** A fresh directory name for a new plan; the deploy script creates it. */
  allocate(deployment: string): string {
    mkdirSync(this.directory, { recursive: true });
    return `${deployment.slice(0, 40)}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  }

  path(key: string): string {
    if (!KEY.test(key)) throw Object.assign(new Error("That is not a plan Studio made."), { status: 400 });
    return path.join(this.directory, key);
  }

  read(key: string): PlanView | undefined {
    const file = path.join(this.path(key), "plan.json");
    if (!existsSync(file)) return undefined;
    const document = JSON.parse(readFileSync(file, "utf8"));
    const resultFile = path.join(this.path(key), "result.json");
    let result: any;
    const unreadable = { status: "unverified", deferred: [], secretUpdates: [], problem: "Recorded deployment progress is unreadable. Preserve the review and inspect AWS before planning again; missing evidence does not establish that nothing changed.", verification: { verified: false, stacks: [] } };
    try {
      if (existsSync(resultFile)) {
        const saved = JSON.parse(readFileSync(resultFile, "utf8"));
        result = saved && ["succeeded", "partial", "unverified", "failed", "interrupted", "export-failed"].includes(saved.status) ? saved : unreadable;
      }
    }
    catch { result = unreadable; }
    const operationFile = path.join(this.path(key), "operation.json");
    if (!result && existsSync(operationFile)) {
      try {
        const operation = JSON.parse(readFileSync(operationFile, "utf8"));
        let alive = false;
        if (Number.isInteger(operation.pid) && operation.pid > 0) { try { process.kill(operation.pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
        if (!alive) result = { status: "interrupted", deferred: [], secretUpdates: operation.secretUpdates ?? [], problem: "No terminal result was recorded. Last phase: " + operation.stage + ". Inspect AWS before planning again.", verification: { verified: false, stacks: [] } };
      } catch { result = unreadable; }
    }
    return {
      key,
      planId: document.planId,
      createdAt: document.createdAt,
      expiresAt: document.expiresAt,
      expired: Date.parse(document.expiresAt) < Date.now(),
      status: document.status,
      review: document.review,
      identity: document.identity,
      inputsFile: document.target?.inputsFile,
      ...(document.sourceRevision ? { sourceRevision: document.sourceRevision } : {}),
      ...(document.profile ? { profile: document.profile } : {}),
      guard: document.guard,
      stacks: (document.stacks ?? []).map((stack: any) => ({
        name: stack.name,
        dependencies: stack.dependencies ?? [],
        fingerprint: stack.fingerprint,
        changes: stack.changes ?? [],
        exportsInUse: (stack.exportsInUse ?? []).map((entry: any) => ({ exportName: entry.exportName, change: entry.change, importers: entry.importers ?? [] })),
        noChanges: Boolean(stack.noChanges),
        ...(stack.deferred ? { deferred: stack.deferred } : {}),
        ...(stack.changeSet ? { changeSet: { name: stack.changeSet.name ?? document.planId, status: stack.changeSet.status, executionStatus: stack.changeSet.executionStatus } } : {}),
      })),
      // Names and actions only: plan.json never holds a value, and none is passed on.
      secrets: (document.secrets ?? []).map((secret: any) => ({ name: secret.name, variable: secret.variable ?? secret.name, action: secret.action })),
      dockerImages: document.dockerImages ?? [],
      iamBroadening: Boolean(document.iamBroadening),
      confirmation: document.confirmation ?? { level: "click", reasons: [] },
      uncertainties: document.uncertainties ?? [],
      retainedStacks: document.retainedStacks ?? [],
      ...(document.reviewEvidence ? { reviewEvidence: document.reviewEvidence } : {}),
      ...(result ? { result: { status: result.status, deferred: result.deferred ?? [], verification: result.verification ?? { verified: false, stacks: [] }, ...(result.problem ? { problem: result.problem } : {}), ...(result.secretUpdates ? { secretUpdates: result.secretUpdates } : {}) } } : {}),
    };
  }

  /** A plan that stopped part-way: what it had prepared in AWS, recorded by deploy:resources as it went. */
  unfinished(key: string): { readonly planId: string; readonly createdAt: string; readonly identity: PlanView["identity"]; readonly profile?: string } | undefined {
    const file = path.join(this.path(key), "preparing.json");
    if (existsSync(path.join(this.path(key), "plan.json")) || !existsSync(file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      return { planId: record.planId, createdAt: record.createdAt, identity: record.identity, ...(record.profile ? { profile: record.profile } : {}) };
    } catch {
      return undefined;
    }
  }

  /** Every plan. `active` names plans a running job is still writing, which are never cleared away. */
  list(active: (key: string) => boolean = () => false): PlanSummary[] {
    if (!existsSync(this.directory)) return [];
    const summaries: PlanSummary[] = [];
    for (const key of readdirSync(this.directory)) {
      if (!KEY.test(key)) continue;
      try {
        const plan = this.read(key);
        if (!plan) {
          const stopped = this.unfinished(key);
          if (stopped && !active(key)) {
            summaries.push({ key, deployment: stopped.identity.deployment, mode: stopped.identity.mode, account: stopped.identity.account, region: stopped.identity.region, ...(stopped.profile ? { profile: stopped.profile } : {}), status: "unfinished", createdAt: stopped.createdAt, expired: false });
          } else if (!stopped && !active(key) && Date.now() - statSync(this.path(key)).mtimeMs > 60 * 60 * 1000) {
            // Planning failed before preparing anything in AWS: an hour later it is litter.
            rmSync(this.path(key), { recursive: true, force: true });
          }
          continue;
        }
        summaries.push({
          key, deployment: plan.identity.deployment, mode: plan.identity.mode, status: plan.status, createdAt: plan.createdAt, expired: plan.expired,
          account: plan.identity.account, region: plan.identity.region, ...(plan.profile ? { profile: plan.profile } : {}), retainedStacks: plan.retainedStacks?.length ?? 0,
          ...(plan.result ? { applied: plan.result.status, ...(plan.result.deferred.length ? { deferred: plan.result.deferred } : {}) } : {}),
        });
      } catch {
        // A plan another version wrote: skipped.
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Removes a plan directory deploy:resources did not finish, unless it prepared something in AWS that discarding must remove. */
  removeUnfinished(key: string): void {
    const directory = this.path(key);
    if (!existsSync(path.join(directory, "plan.json")) && !existsSync(path.join(directory, "preparing.json"))) rmSync(directory, { recursive: true, force: true });
  }
}

/** Deletion reviews are private fixed snapshots; clients select a key, never a path. */
export class TeardownStore {
  readonly directory: string;
  constructor(stateDirectory: string) { this.directory = path.join(stateDirectory, "teardowns"); }
  save(plan: TeardownPlanView): TeardownPlanView {
    mkdirSync(this.directory, { recursive: true });
    const key = "delete-" + Date.now().toString(36) + "-" + randomBytes(6).toString("hex");
    writeFileSync(this.path(key), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return { ...plan, key };
  }
  path(key: string): string {
    if (!KEY.test(key)) throw Object.assign(new Error("That is not a teardown review Studio made."), { status: 400 });
    return path.join(this.directory, key + ".json");
  }
  read(key: string): TeardownPlanView {
    try { return JSON.parse(readFileSync(this.path(key), "utf8")); }
    catch { throw Object.assign(new Error("Teardown review unavailable. Review deletion again."), { status: 409 }); }
  }
}
