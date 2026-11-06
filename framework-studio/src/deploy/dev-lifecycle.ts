import type { JobView, LocalRunView } from "../../shared/deploy";
import { localRuntimeActive } from "./local-runtime-state";
import type { ActionId } from "../../shared/deploy-findings";

/** These actions export/repoint settings or start new compute and require the same stopped-runtime gate. */
export function runtimeActionRequiresOff(action: ActionId): boolean {
  return action === "delete" || action === "export" || action === "start-exported" || action === "start";
}

/** Dev infrastructure changes only after this checkout's compute is confirmed off. */
export function developmentMutationBlocker(input: {
  readonly mode: "dev" | "prod";
  readonly local?: LocalRunView;
  readonly problem?: string;
  readonly operationsKnown: boolean;
  readonly job?: JobView;
  readonly submitting?: boolean;
}): string | undefined {
  if (input.mode === "prod") return undefined;
  if (!input.local || input.problem || input.local.observationProblem || input.local.docker.engine === "unknown")
    return "Check local runtime status before changing development resources.";
  if (!input.operationsKnown)
    return "Check runtime operations before changing development resources.";
  if (input.submitting || input.job?.status === "running")
    return "Wait for local runtime to finish starting or stopping before changing development resources.";
  if (localRuntimeActive(input.local))
    return "Stop local runtime before changing development resources.";
  return undefined;
}
