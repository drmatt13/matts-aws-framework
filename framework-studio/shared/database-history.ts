/** Migration history is a graph of semantic contracts, not authored Prisma text. */
export interface DatabaseHistoryIssue {
  code: string;
  message: string;
  path?: string;
}

export interface DatabaseMigrationOperation {
  id: string;
  label: string;
  operationClass: string;
  summary?: string;
  /** SQL is read from emitted ops.json; historical migration code is never run. */
  statements: { phase: "precheck" | "execute" | "postcheck"; description?: string; sql: string; params?: unknown[] }[];
}

export interface DatabaseMigration {
  id: string;
  space: string;
  name: string;
  from: string | null;
  to: string;
  createdAt: string;
  migrationHash: string;
  integrity: "verified" | "modified";
  operations: DatabaseMigrationOperation[];
  source: string | null;
  sourcePath: string;
  /** The content hash attests metadata and ops, not correspondence with migration.ts. */
  sourceVerification: "not-executed";
  pendingPlaceholders: boolean;
  issues: DatabaseHistoryIssue[];
}

export interface DatabaseContractSnapshot {
  hash: string;
  path: string;
  available: boolean;
  provenance: "semantic-contract";
  /** Canonical emitted JSON. It does not preserve the historical authored PSL. */
  contract?: unknown;
  issues: DatabaseHistoryIssue[];
}

export interface DatabaseHistory {
  revision: string;
  sourceHash: string;
  migrations: DatabaseMigration[];
  snapshots: DatabaseContractSnapshot[];
  /** Terminal graph nodes are navigation hints, never implicit planning origins. */
  heads: string[];
  refs: { space: string; name: string; hash: string; invariants: string[] }[];
  issues: DatabaseHistoryIssue[];
  observedAt: string;
}

export type DatabaseContractReference = "saved" | "empty" | string;

export interface DatabaseSemanticChange {
  kind: "added" | "removed" | "changed";
  plane: "storage" | "domain" | "execution";
  path: string[];
  entity: string;
  explanation?: string;
  before?: unknown;
  after?: unknown;
}

export interface DatabaseSchemaComparison {
  from: string;
  to: string;
  historyRevision: string;
  sourceHash: string;
  draftSourceHash?: string;
  fromStorageHash: string | null;
  toStorageHash: string | null;
  storageChanged: boolean;
  executionChanged: boolean;
  domainChanged: boolean;
  changes: DatabaseSemanticChange[];
  limitations: string[];
  observedAt: string;
}

export interface DatabaseMigrationArtifact {
  path: string;
  contents: string;
  hash: string;
}

export interface DatabaseMigrationReview {
  id: string;
  sourceHash: string;
  historyRevision: string;
  from: string | null;
  to: string;
  noOp: boolean;
  summary: string;
  operations: DatabaseMigrationOperation[];
  artifacts: DatabaseMigrationArtifact[];
  pendingPlaceholders: boolean;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
  effects: { source: "unchanged"; migrations: "review-only"; database: "not-contacted" };
}

export interface DatabaseMigrationInstallResult {
  status: "installed" | "no-op" | "restored" | "unconfirmed";
  written: string[];
  message: string;
  effects: { source: "unchanged"; database: "not-contacted" };
}
