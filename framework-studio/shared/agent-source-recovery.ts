/** Public recovery evidence contains identities and path states, never backup bytes. */
export interface CodingSourceRecovery {
  readonly id: string;
  readonly taskId: string;
  readonly proposalDigest: string;
  readonly createdAt: string;
  readonly fingerprint: string;
  readonly status: "applying" | "applied" | "restored" | "conflicted" | "kept";
  readonly files: readonly { readonly path: string; readonly state: "original" | "written" | "conflicted" }[];
}
export interface CodingRecoveryState {
  readonly coordination: { readonly status: "ready" | "busy" | "recovery_required" | "unavailable"; readonly epoch: string; readonly message?: string };
  readonly recoveries: readonly CodingSourceRecovery[];
}
export type CodingRecoveryApproval = "RESTORE SOURCE" | "KEEP CURRENT SOURCE";
export interface CodingRecoveryResult {
  readonly journalId: string;
  readonly proposalDigest: string;
  readonly status: "applied" | "restored" | "conflicted" | "kept";
  readonly paths: readonly string[];
  readonly message: string;
}
