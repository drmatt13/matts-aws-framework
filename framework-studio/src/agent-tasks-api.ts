import type { AgentRuntimeUpgradeView, CodingEvent, CodingProposal, CodingTask, CodingTaskRequest } from "../shared/agent-runtime";
import { call } from "./http";
import type { CodingRecoveryApproval, CodingRecoveryResult, CodingRecoveryState } from "../shared/agent-source-recovery";

export interface CodingEventPage { readonly task: CodingTask; readonly events: readonly CodingEvent[] }
const target = (id: string) => `/agent-tasks/${encodeURIComponent(id)}`;
export const agentTasksApi = {
  runtimeUpgrade: (signal?: AbortSignal) => call<AgentRuntimeUpgradeView>("/agent-tasks/runtime-upgrade", undefined, signal),
  restartHost: (requestId: string, replaceFailedRequestId?: string) => call<NonNullable<AgentRuntimeUpgradeView["intent"]>>("/agent-tasks/runtime-upgrade", { requestId, ...(replaceFailedRequestId ? { replaceFailedRequestId } : {}) }),
  list: (signal?: AbortSignal) => call<{ tasks: readonly CodingTask[] }>("/agent-tasks", undefined, signal),
  submit: (request: CodingTaskRequest) => call<CodingTask>("/agent-tasks", request),
  events: (id: string, after: number, signal?: AbortSignal) => call<CodingEventPage>(`${target(id)}/events?after=${after}`, undefined, signal),
  proposal: (id: string, signal?: AbortSignal) => call<CodingProposal>(`${target(id)}/proposal`, undefined, signal),
  cancel: (id: string) => call<CodingTask>(`${target(id)}/cancel`, {}),
  approve: (id: string, digest: string) => call<CodingTask>(`${target(id)}/approve`, { digest }),
  activate: (id: string, digest: string) => call<CodingTask>(`${target(id)}/activate`, { digest }),
  reject: (id: string) => call<CodingTask>(`${target(id)}/reject`, {}),
  resume: (id: string) => call<CodingTask>(`${target(id)}/resume`, {}),
  refresh: (id: string, digest: string) => call<CodingTask>(`${target(id)}/refresh`, { digest }),
  cleanup: (id: string) => call<CodingTask>(`${target(id)}/cleanup`, {}),
  recovery: (signal?: AbortSignal) => call<CodingRecoveryState>("/agent-tasks/recovery", undefined, signal),
  recover: (id: string, approval: CodingRecoveryApproval, fingerprint: string) => call<CodingRecoveryResult>(`/agent-tasks/recovery/${encodeURIComponent(id)}`, { approval, fingerprint }),
  permission: (id: string, requestId: string, allow: boolean) => call<CodingTask>(`${target(id)}/permissions/${encodeURIComponent(requestId)}`, { allow }),
};
