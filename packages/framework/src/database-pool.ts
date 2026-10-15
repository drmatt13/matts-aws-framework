/** Shared plain-data pool settings; safe in config and backend runtime bundles. */
export interface DatabasePoolSettings {
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}
export type ResolvedDatabasePool = Required<DatabasePoolSettings>;
export const DEFAULT_DATABASE_POOL: ResolvedDatabasePool = {
  maxConnections: 10, connectionTimeoutMs: 20_000, idleTimeoutMs: 30_000,
};
export function resolveDatabasePool(value: DatabasePoolSettings = {}, defaults: DatabasePoolSettings = {}): ResolvedDatabasePool {
  for (const input of [defaults, value]) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("database.pool must be an object.");
    for (const [key, number] of Object.entries(input)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_DATABASE_POOL, key)) throw new Error(`Unknown database.pool setting "${key}".`);
      if (number !== undefined && (!Number.isSafeInteger(number) || number < (key === "idleTimeoutMs" ? 0 : 1))) throw new Error(`database.pool.${key} must be a ${key === "idleTimeoutMs" ? "non-negative" : "positive"} safe integer.`);
    }
  }
  const supplied = Object.fromEntries(Object.entries(value).filter(([, number]) => number !== undefined));
  const inherited = Object.fromEntries(Object.entries(defaults).filter(([, number]) => number !== undefined));
  return { ...DEFAULT_DATABASE_POOL, ...inherited, ...supplied };
}
