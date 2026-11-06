/** Browser-safe coding-task contract. Paths, provider credentials and approval bytes stay in the host. */
export const AGENT_RUNTIME_VERSION = 1 as const;
export type CodingProvider = "codex" | "claude";
export interface AgentRuntimeUpgradeIntentView {
  readonly requestId: string;
  readonly replacesRequestId?: string;
  readonly targetDigest: string;
  readonly phase: "prepared" | "draining" | "starting" | "ready" | "failed";
  readonly error?: string;
}
export interface AgentRuntimeUpgradeView { readonly intent?: AgentRuntimeUpgradeIntentView }
export type CodingValidationPlan = { readonly kind: "project" } | { readonly kind: "framework" } | { readonly kind: "tests"; readonly paths: readonly string[] };
export type CodingTaskStatus =
  | "queued" | "preparing" | "running" | "validating" | "waiting_for_permission"
  | "awaiting_review" | "conflicted" | "integrating" | "completed"
  | "interrupted" | "failed" | "cancelled" | "rejected" | "recovery_required";

export interface CodingTaskRequest {
  readonly requestKey: string;
  readonly provider: CodingProvider;
  readonly prompt: string;
  readonly model?: string;
  /** Bounded, allow-listed context is evidence, never authorization. */
  readonly context?: string;
  readonly validation?: CodingValidationPlan;
}

export interface CodingTask {
  readonly id: string;
  readonly provider: CodingProvider;
  readonly prompt: string;
  readonly model?: string;
  readonly status: CodingTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
  readonly sessionId?: string;
  readonly proposalDigest?: string;
  readonly summary?: string;
  readonly cancelRequested: boolean;
  readonly canResumeValidation?: boolean;
  readonly activation?: "none" | "restart_required" | "dependency_install_required";
  readonly sourceOutcome?: "unchanged" | "applied" | "restored" | "kept" | "recovery_required";
  readonly workspaceDisposition?: "cleanup_pending" | "source_only";
  readonly runtimeActivation?: { readonly status: "starting" | "ready" | "failed"; readonly detail: string };
}

export interface CodingEvent {
  readonly seq: number;
  readonly taskId: string;
  readonly at: string;
  readonly type: "state" | "message" | "command" | "file" | "permission" | "session" | "diagnostic" | "validation" | "proposal";
  readonly data: Readonly<Record<string, unknown>>;
}

export interface CodingChange {
  readonly path: string;
  readonly kind: "add" | "modify" | "delete";
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly beforeMode: number | null;
  readonly afterMode: number | null;
  readonly binary: boolean;
  readonly diff: string;
}

export interface CodingProposal {
  readonly id: string;
  readonly taskId: string;
  readonly digest: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly createdAt: string;
  readonly changes: readonly CodingChange[];
  readonly activation: NonNullable<CodingTask["activation"]>;
  readonly limitations: readonly string[];
  readonly validation: readonly CodingValidation[];
  readonly architecturePreview?: import("./architecture-preview").ArchitecturePreview;
}

export interface CodingValidation {
  readonly command: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly exitCode?: number | null;
  readonly candidateDigest: string;
  readonly detail?: string;
}

export const ACTIVE_CODING_STATUSES: readonly CodingTaskStatus[] = [
  "queued", "preparing", "running", "validating", "waiting_for_permission", "integrating",
];

export function codingTaskActive(task: Pick<CodingTask, "status">): boolean {
  return ACTIVE_CODING_STATUSES.includes(task.status);
}
