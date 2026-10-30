import { call, ApiError } from "./http";
import type {
  ApplyResponse,
  BatchPlanResponse,
  CommentReviewOptions,
  DraftEdit,
  CommandResult,
  SnapshotResponse,
} from "../shared/api";
import type { ResourceDetails } from "../shared/resources";
import type { Mode } from "../shared/model";
import type { InfrastructureState } from "../shared/infrastructure";
import type { DeploymentInputDetails, DeploymentInputEdit, DeploymentInputPlan } from "../shared/deployment-inputs";
import type { WebSocketDefaults } from "../shared/websockets";

async function callInfrastructure(path: string, body?: unknown): Promise<InfrastructureState> {
  const state = await call<InfrastructureState>(path, body);
  // An older server can serve the SPA's HTML for an unknown GET API route with status 200.
  if (!["dev", "prod"].includes(state.mode) || !["empty", "running", "ready", "failed"].includes(state.status) || typeof state.stale !== "boolean") {
    throw new ApiError(404, "The infrastructure endpoint is unavailable in the running Studio server.");
  }
  return state;
}

export const api = {
  sourceRecovery: () => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery"),
  restoreSource: (id: string, approval: string) => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery/restore", { id, approval }),
  keepSource: (id: string, fingerprint: string, approval: string) => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery/keep", { id, fingerprint, approval }),
  refreshSource: () => call<{ revision: string }>("/snapshot/refresh", {}),
  snapshot: () => call<SnapshotResponse>("/snapshot"),
  createDeploymentInput: (mode: Mode) => call<{ file: string; created: boolean }>("/deployment-inputs/create", { mode }),
  inputDetails: (mode: Mode, signal?: AbortSignal) => call<DeploymentInputDetails>(`/deployment-inputs/details?mode=${mode}`, undefined, signal),
  revealInput: (mode: Mode, name: string) => call<{ readonly name: string; readonly value: string }>(`/deployment-inputs/value?mode=${mode}&name=${encodeURIComponent(name)}`),
  inputPlan: (mode: Mode, edits: readonly DeploymentInputEdit[], hash: string, revision: string) => call<DeploymentInputPlan>("/deployment-inputs/plan", { mode, edits, hash, revision }),
  inputApply: (planId: string) => call<ApplyResponse>("/deployment-inputs/apply", { planId }),
  infrastructure: (mode: Mode) => callInfrastructure(`/infrastructure?mode=${mode}`),
  synthesize: (mode: Mode, profile?: string) => callInfrastructure("/infrastructure/synthesize", { mode, ...(profile ? { profile } : {}) }),
  planBatch: (edits: readonly DraftEdit[], revision: string, options?: CommentReviewOptions) => call<BatchPlanResponse>("/edits/batch/plan", { edits, revision, ...(options ? { options } : {}) }),
  applyBatch: (planId: string) => call<ApplyResponse>("/edits/batch/apply", { planId }),
  resourceDetails: (id: string, mode: Mode, signal?: AbortSignal) => call<ResourceDetails>(`/resources/details?id=${encodeURIComponent(id)}&mode=${mode}`, undefined, signal),
  refreshCdkLinks: () => call<{ edges: number; files: number }>("/cdk-links/refresh", {}),
  command: (name: string, confirmed = false) => call<CommandResult>(`/commands/${encodeURIComponent(name)}`, { confirmed }),
  webSocketDefaults: () => call<WebSocketDefaults>("/websockets/defaults"),
};
