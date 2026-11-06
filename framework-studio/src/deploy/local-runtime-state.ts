import type { JobView, LocalRunView } from "../../shared/deploy";
import { deploymentPresence } from "./presence";

export function localRuntimeActive(local: LocalRunView | undefined): boolean {
  return Boolean(local && (local.activeContainerCount && local.activeContainerCount > 0 || local.watch.running || local.client.running
    || local.services.some(service => ["running", "restarting", "paused", "removing"].includes(service.state))));
}

/** Unknown Docker observations cannot turn last-known active work into a stopped runtime. */
export function mergeLocalRuntime(previous: LocalRunView | undefined, next: LocalRunView): LocalRunView {
  return next.observationProblem && localRuntimeActive(previous) && !localRuntimeActive(next)
    ? { ...previous!, observationProblem: next.observationProblem, readiness: next.readiness }
    : next;
}

export function localRuntimeMatches(local: LocalRunView | undefined, destination: {
  readonly deployment?: string; readonly profile?: string; readonly account?: string; readonly region?: string;
}): boolean {
  const binding = local?.binding;
  return Boolean(binding && destination.deployment && destination.profile && destination.account && destination.region
    && binding.deployment === destination.deployment && binding.profile === destination.profile
    && binding.account === destination.account && binding.region === destination.region
    && local?.exported.deployment === destination.deployment && local.exported.account === destination.account && local.exported.region === destination.region);
}

export function runtimePresentation(input: { readonly local?: LocalRunView; readonly problem?: string;
  readonly job?: JobView; readonly submitting?: "local-start" | "local-stop"; readonly matches: boolean; readonly attention?: string }) {
  const { local, job } = input;
  const active = localRuntimeActive(local);
  const pending = input.submitting ?? (job?.status === "running" ? job.kind : undefined);
  const ready = !pending && !input.problem && !input.attention && local?.readiness?.state === "ready" && input.matches && local.restartNeeded.length === 0;
  const busy = Boolean(pending);
  const label = pending === "local-stop" ? "Stopping…" : pending ? "Starting…"
    : input.problem ? "Status unavailable" : !local ? "Checking…"
    : ready ? "Running" : active ? input.matches ? "Needs attention" : "Running elsewhere"
    : job?.status === "failed" ? "Needs attention" : "Stopped";
  // The switch describes whether runtime work is engaged. Health is a separate
  // label, so a partial startup remains on and can be explicitly stopped.
  return { active, ready, busy, label, on: active || busy };
}

/** Starting is available only after positive AWS and host evidence, never from a saved export alone. */
export function runtimeStartEligibility(input: Parameters<typeof deploymentPresence>[0] & {
  readonly local?: LocalRunView; readonly localProblem?: string;
  readonly operationsKnown: boolean; readonly operationProblem?: string; readonly work?: JobView;
}) {
  const blocked = (hint: string, message: string) => ({ blocked: true, hint, message });
  if (!input.scope.profile) return blocked("Choose a dev profile", "Choose a Development AWS profile before starting locally.");
  if (input.problem) return blocked("Check development status", input.problem.message);
  if (input.availability !== "available") return blocked("Check your AWS profile", "The Development AWS profile is not confirmed available. Open Deploy to check it.");
  if (!input.target) return blocked("Deploy development first", "Declare and deploy a development stack before starting locally.");
  if (!input.status || input.retained) return blocked("Checking deployment…", "Wait for your development deployment to be verified before starting locally.");
  const presence = deploymentPresence(input);
  if (presence.state !== "deployed" || !input.status.detail?.stacks.every(stack => ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(stack.status)))
    return blocked(input.status.detail?.state.kind === "in-progress" ? "Deployment in progress"
    : presence.state === "absent" ? "Deploy development first" : "Deployment needs attention",
    "Local runtime requires a fully completed development deployment in the selected AWS account and region. Open Deploy to finish or review it.");
  if (input.status.detail?.local?.compatible !== true) return blocked("Deploy current changes", input.status.detail?.local?.problem
    ?? "The deployed development resources are not confirmed compatible with this source. Synthesize, review and deploy the required changes first.");
  if (input.localProblem) return blocked("Check runtime status", input.localProblem);
  if (!input.local) return blocked("Checking runtime…", "Wait for the local runtime status check before starting.");
  if (!input.operationsKnown) return blocked("Check Activity status", input.operationProblem ?? "Wait for Activity to confirm that no other operation owns this checkout.");
  if (input.work) return blocked(input.work.status === "running" ? "Wait for current operation" : "Inspect previous operation",
    input.work.status === "running" ? "Wait for the current operation to finish before starting local runtime."
      : "An earlier operation has an uncertain outcome. Inspect Activity before starting local runtime.");
  return { blocked: false, hint: "Stopped", message: undefined };
}

