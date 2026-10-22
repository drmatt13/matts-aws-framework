import type { DatabaseMigrationOperation } from "./database-history";
import type { DatabaseObservation } from "./database-workbench";

export interface DatabaseApplicationReview {
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
  readonly status: "applied" | "failed" | "unconfirmed";
  readonly database: "applied" | "unchanged" | "unconfirmed";
  readonly source: "unchanged";
  readonly artifacts: "unchanged";
  readonly targetId: string;
  readonly message: string;
  readonly applied: readonly { readonly name: string; readonly from: string; readonly to: string }[];
  readonly observation?: DatabaseObservation;
}
