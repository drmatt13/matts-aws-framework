/** Browser-safe operation protocol. Domain approval and result documents remain authoritative. */
export const OPERATIONS_VERSION = 1 as const;

export type OperationKind =
  | "deploy-plan" | "deploy-apply" | "deploy-discard" | "destroy-plan" | "destroy"
  | "export" | "local-start" | "local-stop" | "local-restart" | "local-attach-watch"
  | "deps-install" | "docker-start" | "aws-login" | "drift" | "framework-check";

export interface OperationRequest {
  readonly kind: OperationKind;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
  readonly requestKey?: string;
}

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface JobView {
  readonly id: string;
  readonly kind: OperationKind | "local-watch" | "local-client";
  readonly title: string;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  readonly summary?: string;
  readonly planId?: string;
  readonly deployment?: string;
  readonly lastSeq: number;
  readonly steps?: readonly { readonly label: string; readonly status: "pending" | "running" | "done" | "failed" | "skipped" }[];
  readonly execution?: "accepted" | "dispatching" | "running" | "finished" | "lost";
  readonly outcome?: "pending" | "confirmed" | "unverified" | "uncertain";
  readonly recovery?: string;
  readonly observationProblem?: string;
  readonly origin?: "/deploy" | "/";
  readonly cancelRequested?: boolean;
}
export interface JobLogLine {
  readonly seq: number;
  readonly at: string;
  readonly stream: "out" | "err" | "info";
  readonly text: string;
}

/** Stored intent contains identifiers and approved options, never commands or credentials. */
export interface OperationIntent {
  readonly version: typeof OPERATIONS_VERSION;
  readonly workspace: string;
  readonly request: OperationRequest;
  readonly locks: readonly string[];
  readonly consumptionKey?: string;
  /** Digest of public review/target evidence. Private input values never enter this digest. */
  readonly binding?: string;
  readonly view: Omit<JobView, "id" | "startedAt" | "lastSeq" | "status">;
}

export interface ExecutionIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly started: string;
  readonly token: string;
}

export interface OperationRecord {
  readonly intent: OperationIntent;
  readonly view: JobView;
  readonly dispatchToken?: string;
  readonly owner?: ExecutionIdentity;
}
