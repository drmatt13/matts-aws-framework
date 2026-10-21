import { databaseSettingsProblem, resolveDatabaseSettings, type DatabaseSettings, type DatabaseSettingsInput } from "@repo/framework/config/database";
import type { ModeModel } from "./model";

export interface DatabaseConsumer {
  readonly target: string;
  readonly title: string;
  readonly connection: "application" | "direct";
  readonly readers: boolean;
  readonly maxConnections: number;
}

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
  /** Framework-normalized database bindings, including workloads disabled in this mode. */
  readonly consumers?: readonly DatabaseConsumer[];
}

export interface DatabasePlacementEdit {
  readonly kind: "databasePlacement";
  readonly database: string;
  readonly vpc: string;
  readonly subnet: "private" | "isolated";
}

/** One primary database, with a union of declared consumers across both mode graphs. */
export function databaseConsumers(models: readonly ModeModel[], id: string): readonly DatabaseConsumer[] {
  const consumers = new Map<string, DatabaseConsumer>();
  for (const model of models) if (model.managedDatabase?.id === id) for (const consumer of model.managedDatabase.consumers ?? []) if (!consumers.has(consumer.target)) consumers.set(consumer.target, consumer);
  return [...consumers.values()].sort((a, b) => a.title.localeCompare(b.title) || a.target.localeCompare(b.target));
}

/** Placement is a separate coordinated source operation, never an infrastructure migration. */
export function readDatabasePlacementDraft(raw: unknown): DatabasePlacementEdit {
  const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
  if (!plainObject(raw) || Object.keys(raw).some(key => !["kind", "database", "vpc", "subnet"].includes(key)) || raw.kind !== "databasePlacement" || !id(raw.database) || !id(raw.vpc) || (raw.subnet !== "private" && raw.subnet !== "isolated")) {
    throw new Error("Database placement requires its declared ID, a registered VPC, and private or isolated subnets. The application database cannot be unplaced or public.");
  }
  return { kind: "databasePlacement", database: raw.database, vpc: raw.vpc, subnet: raw.subnet };
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
