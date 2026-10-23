/** Transport-only declarations: safe to import from the Studio browser. */
export interface DatabaseCloudIdentity { deployment: string; account: string; region: string; taskDefinitionArn: string }
export interface DatabaseCloudRequest { version: 1; requestId: string; mode: "review" | "apply"; identity: DatabaseCloudIdentity; inputsDigest: string; expectedDigest?: string }
export interface DatabaseCloudReview {
  kind?: "migrate" | "initialize";
  initialization?: DatabaseInitializationPlan;
  version: 1;
  identity: DatabaseCloudIdentity;
  inputsDigest: string;
  markerHash: string;
  markerIdentity: string;
  ledgerIdentity: string;
  storageHash: string;
  helpers: { file: string; source: string }[];
  migrations: { spaceId: string; dirName: string; migrationHash: string; from: string; to: string; source: string; sql: { phase: string; sql: string; params?: unknown[] }[] }[];
  digest: string;
}
export interface DatabaseInitializationPlan { operations: readonly { id: string; label: string; operationClass: string }[]; operationsDigest?: string; statements?: readonly { operationId: string; phase: string; sql: string; params?: readonly unknown[] }[]; sql: readonly string[]; controlSql?: readonly { sql: string; params?: readonly unknown[] }[] }
export interface DatabaseCloudEnvelope { version: 1; requestId: string; status: "reviewed" | "applied" | "unchanged" | "unconfirmed" | "refused"; review?: DatabaseCloudReview; code?: string; applied?: string[]; operationId?: string }
