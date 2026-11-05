import { readFileSync } from "node:fs";
import path from "node:path";
import type { JobView } from "../../shared/operations";
import { PlanStore } from "../deploy/plans";

/** Recover only a computed count from its exact saved review; stored text and logs stay unchanged. */
export function projectSynthesisSummary(state: string, job: JobView): JobView {
  if (job.kind !== "deploy-plan" || job.status !== "succeeded" || !job.planId || !job.summary
    || !job.deployment || typeof job.params.profile !== "string" || !job.params.profile) return job;
  const match = /^(Synthesis ready: )((?:\d|\[redacted\])+)( resource changes? to review(?:[.;].*)?)$/.exec(job.summary);
  if (!match || !match[2]!.includes("[redacted]")) return job;
  try {
    // No source root: reading this artifact does not evaluate declarations or compute freshness.
    const plan = JSON.parse(readFileSync(path.join(new PlanStore(state).path(job.planId), "plan.json"), "utf8"));
    if (!plan || plan.status !== "ready" || typeof plan.planId !== "string" || !plan.planId
      || !["dev", "prod"].includes(plan.identity?.mode)
      || typeof plan.identity.account !== "string" || !plan.identity.account
      || typeof plan.identity.region !== "string" || !plan.identity.region
      || plan.identity.deployment !== job.deployment
      || plan.profile !== job.params.profile
      || job.params.deployment !== undefined && job.params.deployment !== plan.identity.deployment
      || job.params.region !== undefined && job.params.region !== plan.identity.region
      || job.params.mode !== undefined && job.params.mode !== plan.identity.mode) return job;
    // Do not default missing evidence to zero as a general-purpose plan view may do.
    if (!Array.isArray(plan.stacks) || !plan.stacks.every((stack: { changes?: unknown[] } | null) => stack && Array.isArray(stack.changes))) return job;
    const count = plan.stacks.reduce((sum: number, stack: { changes: unknown[] }) => sum + stack.changes.length, 0);
    if (!Number.isSafeInteger(count)) return job;
    return { ...job, summary: match[1]! + count + match[3]! };
  } catch { return job; }
}
