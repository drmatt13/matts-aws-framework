/** Repository source, independent from Prisma schema migrations and deployment. */
export const SQL_DIRECTORY = "packages/database/sql";
export type SqlKind = "seed" | "backfill" | "operation" | "inspection";
export interface SavedSqlCommand {
  readonly name: string;
  readonly kind: SqlKind;
  readonly intent: "repeatable" | "once";
  readonly description: string;
  /** Positional PostgreSQL parameters, passed as values rather than interpolated SQL. */
  readonly parameters: readonly string[];
  readonly sql: string;
}
export interface SqlSourceReview {
  readonly id: string;
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly command: SavedSqlCommand;
  readonly expiresAt: string;
}
export interface SqlExecutionReview {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
  readonly command: SavedSqlCommand;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly targetIdentity: string;
  readonly parameters: readonly (string | number | boolean | null)[];
  readonly confirmation: string;
  readonly expiresAt: string;
  readonly effects: readonly string[];
}
export interface SqlExecutionRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly revision: string;
  readonly targetLabel: string;
  readonly targetIdentity: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: "running" | "committed" | "read" | "skipped" | "failed" | "unconfirmed";
  readonly database: "committed" | "unchanged" | "unconfirmed";
  readonly message: string;
  readonly sqlState?: string;
  readonly rowCount?: number;
}
export interface SqlExecutionResult extends SqlExecutionRecord {
  /** Results are returned to this invocation only, never written to operation history. */
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}
export interface SqlCatalog {
  readonly directory: string;
  readonly commands: readonly { readonly path: string; readonly revision: string; readonly command: SavedSqlCommand }[];
  readonly issues: readonly string[];
  readonly history: readonly SqlExecutionRecord[];
  readonly targets: readonly import("./database-workbench").DatabaseTarget[];
}
