import { LAMBDA_ARCHITECTURES, CONTAINER_SUBNETS, type FrameworkConfig, type NormalizedTarget } from "@repo/framework/config";
import { DEFAULT_DATABASE_POOL } from "../../../packages/framework/src/database-pool";
import type { FieldFact, ModelDefaults } from "../../shared/model";
import { declarationOf, parseOrigin, readPath } from "../model/origin";
import type { FieldDefinition } from "./fields";

const GROUPS = { lambda: "All Lambdas", http: "HTTP Lambdas", webSocket: "WebSocket Lambdas", events: "Event Lambdas", tools: "Agent tool Lambdas", container: "Containers", database: "Database connection pools" };
const REQUIRED = new Set(["runtime", "packaging", "architecture", "memorySize", "timeoutSeconds"]);
const FALLBACK: Readonly<Record<string, string | number | boolean>> = {
  "lambda.subnet": "none", "lambda.logRetentionDays": 30, "lambda.bundling.minify": true, "lambda.bundling.sourceMap": true,
  "container.architecture": "x86_64", "container.subnet": "public",
  ...Object.fromEntries(Object.entries(DEFAULT_DATABASE_POOL).map(([key, value]) => [`database.pool.${key}`, value])),
};

export interface DefaultFieldDefinition extends FieldDefinition {
  readonly group: string;
  readonly targetPath: readonly string[];
  readonly targetField?: FieldDefinition;
}

/** Domains and splices are the same ones used for individual workload settings. */
export function makeDefaultFields(base: readonly FieldDefinition[]): readonly DefaultFieldDefinition[] {
  const definitions: DefaultFieldDefinition[] = [];
  for (const group of ["lambda", "http", "webSocket", "events", "tools"]) {
    for (const field of base.filter((field) => field.id.startsWith("lambda."))) {
      definitions.push({
        ...field, id: `defaults.${group}.${field.path.join(".")}`, group, path: [group, ...field.path], targetPath: field.path, targetField: field,
        required: group === "lambda" && REQUIRED.has(field.path.join(".")),
        resolve: (config) => defaultValue(config, group, field.path),
      });
    }
  }
  const add = (group: string, key: string, label: string, domain: FieldDefinition["domain"]) => definitions.push({
    id: `defaults.${group}.${key}`, group, label, path: [group, ...key.split(".")], targetPath: group === "container" ? ["cloud", key] : ["database", ...key.split(".")],
    domain, after: [], before: [], applies: () => false, resolve: (config) => defaultValue(config, group, key.split(".")),
  });
  add("container", "architecture", "Architecture", { kind: "enum", values: LAMBDA_ARCHITECTURES });
  add("container", "subnet", "Subnet", { kind: "enum", values: CONTAINER_SUBNETS });
  add("database", "pool.maxConnections", "Maximum connections", { kind: "number", min: 1, max: Number.MAX_SAFE_INTEGER, unit: "connections" });
  add("database", "pool.connectionTimeoutMs", "Connection timeout", { kind: "number", min: 1, max: Number.MAX_SAFE_INTEGER, unit: "ms" });
  add("database", "pool.idleTimeoutMs", "Idle timeout", { kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, unit: "ms" });
  return definitions;
}

function defaultValue(config: FrameworkConfig, group: string, keys: readonly string[]): Pick<FieldFact, "effective" | "provenance" | "inherited"> {
  const defaults = config.defaults as unknown as Record<string, unknown>;
  const authored = readPath(defaults, [group, ...keys]);
  const section = ["http", "webSocket", "events", "tools"].includes(group);
  const inherited = section
    ? { value: readPath(defaults, ["lambda", ...keys]) ?? FALLBACK[`lambda.${keys.join(".")}`], from: `defaults.lambda.${keys.join(".")}` }
    : FALLBACK[`${group}.${keys.join(".")}`] === undefined ? undefined : { value: FALLBACK[`${group}.${keys.join(".")}`], from: "the framework's default" };
  const value = authored ?? inherited?.value;
  return {
    effective: (value ?? "Not configured") as string | number | boolean,
    provenance: authored === undefined ? inherited?.from ?? "not configured" : `defaults.${group}.${keys.join(".")}`,
    ...(inherited?.value === undefined ? {} : { inherited: inherited as NonNullable<FieldFact["inherited"]> }),
  };
}

export function projectDefaults(config: FrameworkConfig, targets: readonly NormalizedTarget[], definitions: readonly DefaultFieldDefinition[]) {
  const declaration = (target: NormalizedTarget) => target.origins[0] ? declarationOf(config, parseOrigin(target.origins[0])!) : undefined;
  const groups: ModelDefaults[] = Object.entries(GROUPS).map(([group, title]) => ({
    ref: `defaults:${group}`, title, group, origin: "defaults",
    targets: targets.filter((target) => group === "database" ? !!declaration(target)?.database : group === "container" ? ["service", "task"].includes(target.kind) : target.kind === "lambda" && (group === "lambda" || target.section === group)).map((target) => target.reference),
  }));
  const fields: Record<string, FieldFact[]> = {};
  for (const group of groups) {
    fields[group.ref] = definitions.filter((field) => field.group === group.group).map((field): FieldFact => {
      const authored = readPath(config.defaults as unknown as Record<string, unknown>, field.path);
      const consumers = targets.filter((target) => group.targets.includes(target.reference) && (!field.targetField || field.targetField.applies(target, config)));
      const overrides = consumers.filter((target) => readPath(declaration(target), field.targetPath) !== undefined
        || (group.group === "lambda" && target.section && readPath(config.defaults as unknown as Record<string, unknown>, [target.section, ...field.targetPath]) !== undefined));
      return {
        field: field.id, label: field.label, path: field.path, domain: field.domain,
        ...defaultValue(config, group.group, field.path.slice(1)),
        ...(authored === undefined ? {} : { authored: ["string", "boolean", "number"].includes(typeof authored) ? authored as string | number | boolean : null }),
        usage: { inherited: consumers.length - overrides.length, overridden: overrides.length },
      };
    });
  }
  return { groups, fields };
}
