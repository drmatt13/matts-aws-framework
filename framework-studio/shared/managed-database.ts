import { databaseSettingsProblem, resolveDatabaseSettings, type DatabaseSettings, type DatabaseSettingsInput } from "@repo/framework/config/database";

/** Source-owned PostgreSQL settings, separate from live schema/table inspection. */
export interface ManagedDatabaseModel {
  readonly id: string;
  readonly resource: string;
  readonly networkId: string;
  readonly subnet: "private" | "isolated";
  readonly engine: "postgres";
  readonly databaseName: string;
  readonly settings: DatabaseSettings;
  readonly authored: DatabaseSettingsInput;
}

/** Changes configuration defaults; deployment remains a separate reviewed action. */
export interface DatabaseEdit {
  readonly kind: "database";
  readonly database: string;
  readonly settings: DatabaseSettingsInput;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

/** No identifiers, network changes, source expressions or arbitrary file paths. */
export function readDatabaseDraft(raw: unknown): DatabaseEdit {
  if (!plainObject(raw) || Object.keys(raw).some(key => !["kind", "database", "settings"].includes(key)) || raw.kind !== "database" || typeof raw.database !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(raw.database) || !plainObject(raw.settings)) {
    throw new Error("Database changes require a declared database ID and a PostgreSQL settings object. Identity and placement stay in the declaration.");
  }
  const settings = raw.settings as DatabaseSettingsInput;
  try { resolveDatabaseSettings({ getContext: () => undefined, env: {}, defaults: settings }); }
  catch (error) { throw new Error(databaseSettingsProblem(error)); }
  return {
    kind: "database", database: raw.database,
    settings: Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])) as DatabaseSettingsInput,
  };
}
