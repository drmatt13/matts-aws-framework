import {
  CONTAINER_SUBNETS,
  DEPLOY_SETTINGS,
  LAMBDA_SUBNETS,
  resolveLambdaTarget,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import type { FieldDomain, FieldFact } from "../../shared/model";
import { declarationOf, parseOrigin, readPath } from "../model/origin";

/**
 * The fields the studio can change, and nothing else.
 *
 * Deliberately a short list. Each one is a literal the framework already
 * validates, with a domain taken from the framework's own constants, so the
 * studio can offer exactly the values the framework accepts. Adding a field is
 * adding an entry here; the planner, preflight and transaction are generic.
 */

export interface FieldDefinition {
  readonly id: string;
  readonly label: string;
  /** Property path inside the declaration object. */
  readonly path: readonly string[];
  readonly domain: FieldDomain;
  /** Inserted after the last of these that is present… */
  readonly after: readonly string[];
  /** …else before the first of these, else at the end. */
  readonly before: readonly string[];
  readonly applies: (target: NormalizedTarget) => boolean;
  readonly resolve: (
    config: FrameworkConfig,
    target: NormalizedTarget,
    declaration: Record<string, unknown> | undefined,
  ) => Pick<FieldFact, "effective" | "provenance" | "inherited">;
}

const DECLARED = "declared on the entry";

function lambdaSectionDefaults(config: FrameworkConfig, target: NormalizedTarget): Record<string, unknown> | undefined {
  return target.section ? (config.defaults[target.section] as Record<string, unknown> | undefined) : undefined;
}

/** What a Lambda field resolves to without the entry: the section default, then `defaults.lambda`. */
function lambdaInherited(
  config: FrameworkConfig,
  target: NormalizedTarget,
  key: "memorySize" | "timeoutSeconds" | "subnet",
  fallback: string | number,
): { value: string | number; from: string } {
  const section = lambdaSectionDefaults(config, target)?.[key] as string | number | undefined;
  if (section !== undefined) return { value: section, from: `defaults.${target.section}.${key}` };
  const base = (config.defaults.lambda as unknown as Record<string, unknown>)[key] as string | number | undefined;
  if (base !== undefined) return { value: base, from: `defaults.lambda.${key}` };
  return { value: fallback, from: "the framework's default" };
}

const LAMBDA_BUILD_ANCHORS = {
  after: ["directory", "methods", "auth", "packaging", "runtime", "architecture", "memorySize", "timeoutSeconds"],
  before: ["bundling", "localReplay", "deploy", "userPool", "environment", "secrets", "database", "cloud", "authorizer"],
} as const;

export const FIELDS: readonly FieldDefinition[] = [
  {
    id: "deploy",
    label: "Deploy",
    path: ["deploy"],
    domain: { kind: "enum", values: DEPLOY_SETTINGS },
    after: ["timeoutSeconds", "memorySize", "auth", "methods", "tools", "route", "healthCheckPath", "port", "directory"],
    before: ["userPool", "environment", "secrets", "database", "cloud", "local", "timeoutSeconds"],
    applies: (target) =>
      ["http", "webSocket", "webSocketAuthorizer", "service", "task", "agent", "workflow"].includes(target.role),
    resolve: (_config, target, declaration) => ({
      effective: target.deploy,
      provenance: readPath(declaration, ["deploy"]) !== undefined ? DECLARED : 'the framework\'s default ("both")',
      inherited: { value: "both", from: "the framework's default" },
    }),
  },
  {
    id: "lambda.subnet",
    label: "Subnet",
    path: ["subnet"],
    domain: { kind: "enum", values: LAMBDA_SUBNETS },
    ...LAMBDA_BUILD_ANCHORS,
    applies: (target) => target.kind === "lambda",
    resolve: (config, target, declaration) => {
      const spec = resolveLambdaTarget(config, target.id);
      const base = lambdaInherited(config, target, "subnet", "none");
      const lifted = declaration?.database !== undefined && base.value === "none";
      const inherited = lifted
        ? { value: "private", from: `${base.from}, lifted from "none" by database: true` }
        : base;
      return {
        effective: spec.subnet,
        provenance: readPath(declaration, ["subnet"]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  },
  {
    id: "lambda.memorySize",
    label: "Memory",
    path: ["memorySize"],
    domain: { kind: "number", min: 128, max: 10240, unit: "MB" },
    ...LAMBDA_BUILD_ANCHORS,
    applies: (target) => target.kind === "lambda",
    resolve: (config, target, declaration) => {
      const inherited = lambdaInherited(config, target, "memorySize", 128);
      return {
        effective: resolveLambdaTarget(config, target.id).memorySize,
        provenance: readPath(declaration, ["memorySize"]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  },
  {
    id: "lambda.timeoutSeconds",
    label: "Timeout",
    path: ["timeoutSeconds"],
    domain: { kind: "number", min: 1, max: 900, unit: "s" },
    ...LAMBDA_BUILD_ANCHORS,
    applies: (target) => target.kind === "lambda",
    resolve: (config, target, declaration) => {
      const inherited = lambdaInherited(config, target, "timeoutSeconds", 3);
      return {
        effective: resolveLambdaTarget(config, target.id).timeoutSeconds,
        provenance: readPath(declaration, ["timeoutSeconds"]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  },
  {
    id: "container.subnet",
    label: "Subnet",
    path: ["cloud", "subnet"],
    domain: { kind: "enum", values: CONTAINER_SUBNETS },
    after: ["desiredCount", "memoryMiB", "cpu", "constructId"],
    before: ["architecture", "buildTarget", "publicLoadBalancer", "bindings", "access", "requirements", "outputs"],
    applies: (target) => target.kind === "service" || target.kind === "task",
    resolve: (config, target, declaration) => {
      const container = target.cloud.service ?? target.cloud.task;
      const fromDefaults = config.defaults.container?.subnet;
      const inherited = fromDefaults !== undefined
        ? { value: fromDefaults, from: "defaults.container.subnet" }
        : { value: "public", from: "the framework's default" };
      return {
        effective: container?.subnet ?? inherited.value,
        provenance: readPath(declaration, ["cloud", "subnet"]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  },
];

export function fieldById(id: string): FieldDefinition | undefined {
  return FIELDS.find((field) => field.id === id);
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

/** Every field one target offers, resolved against one config. */
export function fieldFacts(config: FrameworkConfig, target: NormalizedTarget): readonly FieldFact[] {
  const origin = target.origins[0] ? parseOrigin(target.origins[0]) : undefined;
  const declaration = origin ? declarationOf(config, origin) : undefined;
  const shared =
    target.origins.length > 1
      ? `Declared by ${target.origins.join(" and ")}, which must agree. Change it in source so they stay in step.`
      : undefined;
  return FIELDS.filter((field) => field.applies(target)).map((field) => {
    const authored = readPath(declaration, field.path);
    const resolved = field.resolve(config, target, declaration);
    return {
      field: field.id,
      label: field.label,
      path: field.path,
      domain: field.domain,
      ...resolved,
      ...(authored === undefined ? {} : { authored: primitive(authored) ?? null }),
      ...(origin ? (shared ? { blocked: shared } : {}) : { blocked: "Its declaration could not be located." }),
    };
  });
}
