import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PlanSummaryView, PlanView } from "../../shared/deploy";

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
    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined;
    return {
      key,
      planId: document.planId,
      createdAt: document.createdAt,
      expiresAt: document.expiresAt,
      expired: Date.parse(document.expiresAt) < Date.now(),
      status: document.status,
      review: document.review,
      identity: document.identity,
      ...(document.profile ? { profile: document.profile } : {}),
      guard: document.guard,
      stacks: (document.stacks ?? []).map((stack: any) => ({
        name: stack.name,
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
      ...(result ? { result: { status: result.status, deferred: result.deferred ?? [], verification: result.verification ?? { verified: false, stacks: [] } } } : {}),
    };
  }

  list(): PlanSummary[] {
    if (!existsSync(this.directory)) return [];
    const summaries: PlanSummary[] = [];
    for (const key of readdirSync(this.directory)) {
      if (!KEY.test(key)) continue;
      try {
        const plan = this.read(key);
        if (!plan) {
          // Planning failed or was cancelled before plan.json: an hour later it is litter.
          if (Date.now() - statSync(this.path(key)).mtimeMs > 60 * 60 * 1000) rmSync(this.path(key), { recursive: true, force: true });
          continue;
        }
        summaries.push({
          key, deployment: plan.identity.deployment, mode: plan.identity.mode, status: plan.status, createdAt: plan.createdAt, expired: plan.expired,
          ...(plan.result ? { applied: plan.result.status, ...(plan.result.deferred.length ? { deferred: plan.result.deferred } : {}) } : {}),
        });
      } catch {
        // A plan another version wrote: skipped.
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Removes a plan directory deploy:resources did not finish (no plan.json). */
  removeUnfinished(key: string): void {
    if (!existsSync(path.join(this.path(key), "plan.json"))) rmSync(this.path(key), { recursive: true, force: true });
  }
}
