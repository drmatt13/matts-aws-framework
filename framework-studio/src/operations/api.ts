import type { JobLogLine, JobView, OperationRequest } from "../../shared/operations";
import { call } from "../http";

export interface OperationLogPage { readonly job: JobView; readonly lines: readonly JobLogLine[] }

/** Shared observation and explicit requests; domain approval stays with each workspace. */
export const operationsApi = {
  list: () => call<{ jobs: JobView[] }>("/operations"),
  submit: (request: OperationRequest, requestKey = request.requestKey ?? crypto.randomUUID()) =>
    call<JobView>("/operations", { ...request, requestKey }),
  cancel: (id: string) => call<JobView>(`/operations/${encodeURIComponent(id)}/cancel`, {}),
  log: (id: string, after = 0) => call<OperationLogPage>(`/operations/${encodeURIComponent(id)}/log${after ? `?after=${after}` : ""}`),
};
