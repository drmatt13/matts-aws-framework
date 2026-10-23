import type { CloudMode } from "@repo/framework/config";
import type { DatabaseReference } from "./lib/app/database-lifecycle";
import type { CognitoReference } from "./lib/app/cognito-lifecycle";

export type StatefulRetention = "retain" | "remove";
export interface StatefulResourcePolicy<TReference> {
  readonly retention?: StatefulRetention;
  /** A reference preserves external ownership; it never imports or mutates the resource. */
  readonly reference?: TReference;
}
export interface StatefulEnvironmentConfiguration {
  readonly database?: StatefulResourcePolicy<DatabaseReference>;
  readonly cognito?: StatefulResourcePolicy<CognitoReference>;
}
export type StatefulResourcesConfiguration = Readonly<Partial<Record<CloudMode, StatefulEnvironmentConfiguration>>>;

/** Missing resource policies deliberately inherit the historical shared input. */
export function resolveStatefulResources(configuration: StatefulResourcesConfiguration | undefined, mode: CloudMode, legacyRetention: boolean) {
  if (configuration && Object.keys(configuration).some(key => key !== "dev" && key !== "prod")) throw new Error("Stateful resources accepts only dev and prod environments.");
  for (const [environment, policies] of Object.entries(configuration ?? {})) {
    if (!policies || typeof policies !== "object" || Object.keys(policies).some(key => key !== "database" && key !== "cognito")) throw new Error(`Invalid stateful resource policies for ${environment}.`);
    for (const [kind, policy] of Object.entries(policies)) {
      if (!policy || typeof policy !== "object" || Object.keys(policy).some(key => key !== "retention" && key !== "reference")) throw new Error(`Invalid ${environment}.${kind} lifecycle policy.`);
      if (policy.retention !== undefined && policy.retention !== "retain" && policy.retention !== "remove") throw new Error(`${environment}.${kind}.retention must be retain or remove.`);
      if (policy.reference !== undefined && (!policy.reference || typeof policy.reference !== "object" || Array.isArray(policy.reference))) throw new Error(`${environment}.${kind}.reference must be an explicit resource descriptor.`);
      if (kind === "database" && environment === "dev" && policy.reference) throw new Error("Development uses local PostgreSQL; an AWS database reference belongs only in prod.");
    }
  }
  const resolve = <T>(policy: StatefulResourcePolicy<T> | undefined) => ({
    retention: policy?.retention ?? (legacyRetention ? "retain" : "remove") as StatefulRetention,
    retentionSource: policy?.retention === undefined ? "legacy" as const : "source" as const,
    ...(policy?.reference ? { reference: policy.reference } : {}),
  });
  return { database: resolve(configuration?.[mode]?.database), cognito: resolve(configuration?.[mode]?.cognito) };
}
