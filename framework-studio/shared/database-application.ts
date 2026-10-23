import type { DatabaseMigrationOperation } from "./database-history";
import type { DatabaseObservation } from "./database-workbench";

export interface DatabaseApplicationReview {
  readonly kind?: "migrate" | "initialize";
  readonly initialization?: import("../../packages/database/scripts/studio-migrations-types").DatabaseInitializationPlan;
  readonly id: string;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly targetIdentity: string;
  readonly sourceHash: string;
  readonly historyRevision: string;
  readonly from: string;
  readonly to: string;
  readonly migrations: readonly {
    readonly id: string;
    readonly name: string;
    readonly migrationHash: string;
    readonly from: string;
    readonly to: string;
    readonly source: string;
    readonly operations: readonly DatabaseMigrationOperation[];
  }[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly confirmation: string;
  readonly effects: readonly string[];
}

export interface DatabaseApplicationResult {
  readonly operationId?: string;
  readonly stage?: "connecting" | "executing" | "inspecting" | "complete" | "interrupted";
  readonly diagnostic?: { readonly code: string; readonly sqlState?: string; readonly action: string };
  readonly status: "applied" | "unchanged" | "failed" | "unconfirmed";
  readonly database: "applied" | "unchanged" | "unconfirmed";
  readonly source: "unchanged";
  readonly artifacts: "unchanged";
  readonly targetId: string;
  readonly message: string;
  readonly applied: readonly { readonly name: string; readonly from: string; readonly to: string }[];
  readonly observation?: DatabaseObservation;
}

export interface DatabaseOperationRecord {
  readonly ownerPid?: number;
  readonly id: string;
  readonly kind: "migrate" | "initialize" | "inspect-production";
  readonly targetLabel: string;
  readonly targetIdentity: string;
  readonly sourceHash: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: "running" | "reviewed" | "applied" | "unchanged" | "failed" | "unconfirmed" | "interrupted";
  readonly stage: NonNullable<DatabaseApplicationResult["stage"]>;
  readonly migrations: readonly string[];
  readonly result?: DatabaseApplicationResult;
  readonly message?: string;
  readonly taskArn?: string;
  readonly requestId?: string;
  readonly reviewDigest?: string;
  readonly cloudRecovery?: { readonly profile: string; readonly region: string; readonly cluster: string; readonly logGroup: string; readonly logStream: string };
}
