import {
  CONTAINER_SUBNETS,
  CLOUDWATCH_LOG_RETENTION_DAYS,
  DEPLOY_SETTINGS,
  getInheritedToolDeploySetting,
  LAMBDA_ARCHITECTURES,
  LAMBDA_PACKAGING,
  LAMBDA_RUNTIMES,
  LAMBDA_SUBNETS,
  isNodeLambdaRuntime,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import type { FieldDomain, FieldFact } from "../../shared/model";
import { lambdaSpec } from "../model/lambda-spec";
import { declarationOf, parseOrigin, readPath } from "../model/origin";
import { makeDefaultFields } from "./defaults";

/**
 * The fields the studio can change, and nothing else.
 *
 * Deliberately a short list. Each one is a literal the framework already
 * validates, with a domain taken from the framework's own constants, so the
 * studio can offer exactly the values the framework accepts. Adding a field is
 * adding an entry here; the planner, preflight and transaction are generic.
 */

export interface FieldDefinition {
  /** Required baseline defaults cannot be removed. */
  readonly required?: boolean;
  readonly id: string;
  readonly label: string;
  /** Property path inside the declaration object. */
  readonly path: readonly string[];
  readonly domain: FieldDomain;
  /** Inserted after the last of these that is present… */
  readonly after: readonly string[];
  /** …else before the first of these, else at the end. */
  readonly before: readonly string[];
  readonly applies: (target: NormalizedTarget, config: FrameworkConfig) => boolean;
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
  key: "memorySize" | "timeoutSeconds" | "subnet" | "architecture" | "packaging" | "runtime" | "logRetentionDays",
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

function lambdaSetting(
  key: "architecture" | "packaging" | "runtime" | "logRetentionDays",
  label: string,
  values: readonly (string | number)[],
  fallback: string | number,
): FieldDefinition {
  return {
    id: `lambda.${key}`, label, path: [key], domain: { kind: "enum", values }, ...LAMBDA_BUILD_ANCHORS,
    applies: (target, config) => target.kind === "lambda" && (key !== "runtime" || lambdaSpec(config, target.id).packaging === "zip"),
    resolve: (config, target, declaration) => {
      const spec = lambdaSpec(config, target.id);
      const inherited = lambdaInherited(config, target, key, fallback);
      return {
        effective: key === "runtime" ? spec.packaging === "zip" ? spec.runtime : "Dockerfile" : spec[key],
        provenance: readPath(declaration, [key]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  };
}

function bundlingSetting(key: "minify" | "sourceMap", label: string): FieldDefinition {
  return {
    id: `lambda.bundling.${key}`, label, path: ["bundling", key], domain: { kind: "enum", values: [true, false] }, ...LAMBDA_BUILD_ANCHORS,
    applies: (target, config) => {
      if (target.kind !== "lambda") return false;
      const spec = lambdaSpec(config, target.id);
      return spec.packaging === "zip" && isNodeLambdaRuntime(spec.runtime);
    },
    resolve: (config, target, declaration) => {
      const spec = lambdaSpec(config, target.id);
      const section = readPath(lambdaSectionDefaults(config, target), ["bundling", key]);
      const base = config.defaults.lambda.bundling[key];
      const inherited = typeof section === "boolean" ? { value: section, from: `defaults.${target.section}.bundling.${key}` }
        : typeof base === "boolean" ? { value: base, from: `defaults.lambda.bundling.${key}` }
          : { value: true, from: "the framework's default" };
      return {
        effective: spec.packaging === "zip" ? spec.bundling[key] : inherited.value,
        provenance: readPath(declaration, ["bundling", key]) !== undefined ? DECLARED : inherited.from,
        inherited,
      };
    },
  };
}

export const FIELDS: readonly FieldDefinition[] = [
  {
    id: "events.localReplay", label: "Local replay", path: ["localReplay"],
    domain: { kind: "enum", values: [true] },
    after: ["bundling", "timeoutSeconds", "memorySize", "directory"], before: ["database", "userPool", "environment", "cloud"],
    applies: (target) => target.role === "event",
    resolve: (_config, _target, declaration) => ({
      effective: declaration?.localReplay === true,
      provenance: declaration?.localReplay === true ? DECLARED : "the framework's default",
      inherited: { value: false, from: "the framework's default" },
    }),
  },
  {
    id: "http.auth", label: "API user-pool authorizer", path: ["auth"],
    // The framework declares auth?: true. Off removes the property instead of writing false.
    domain: { kind: "enum", values: [true] },
    after: ["methods", "directory"], before: ["userPool", "environment", "cloud"],
    applies: (target) => target.role === "http" || target.role === "service",
    resolve: (_config, _target, declaration) => ({
      effective: declaration?.auth === true,
      provenance: declaration?.auth === true ? DECLARED : "the framework's default",
      inherited: { value: false, from: "the framework's default" },
    }),
  },
  lambdaSetting("architecture", "Architecture", LAMBDA_ARCHITECTURES, "arm64"),
  lambdaSetting("packaging", "Packaging", LAMBDA_PACKAGING, "zip"),
  lambdaSetting("runtime", "Runtime", LAMBDA_RUNTIMES, "nodejs24"),
  lambdaSetting("logRetentionDays", "Log retention", CLOUDWATCH_LOG_RETENTION_DAYS, 30),
  bundlingSetting("minify", "Minify"),
  bundlingSetting("sourceMap", "Source maps"),
  {
    id: "deploy",
    label: "Deploy",
    path: ["deploy"],
    domain: { kind: "enum", values: DEPLOY_SETTINGS },
    after: ["timeoutSeconds", "memorySize", "auth", "methods", "tools", "route", "healthCheckPath", "port", "directory"],
    before: ["userPool", "environment", "secrets", "database", "cloud", "local", "timeoutSeconds"],
    applies: (target) =>
      ["http", "webSocket", "webSocketAuthorizer", "event", "tool", "service", "task", "agent", "workflow"].includes(target.role),
    resolve: (config, target, declaration) => ({
      effective: typeof target.deploy === "string" ? target.deploy : "conditional",
      provenance: readPath(declaration, ["deploy"]) !== undefined ? DECLARED : target.role === "tool" ? "consuming agents" : 'the framework\'s default ("both")',
      inherited: { value: target.role === "tool" ? typeof getInheritedToolDeploySetting(config, target.id) === "string" ? getInheritedToolDeploySetting(config, target.id) as string : "conditional" : "both", from: target.role === "tool" ? "consuming agents" : "the framework's default" },
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
      const spec = lambdaSpec(config, target.id);
      const base = lambdaInherited(config, target, "subnet", "none");
      const lifted = (declaration?.database !== undefined || declaration?.vpc !== undefined) && base.value === "none";
      const inherited = lifted
        ? { value: "private", from: `${base.from}, lifted from "none" by explicit VPC placement` }
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
        effective: lambdaSpec(config, target.id).memorySize,
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
        effective: lambdaSpec(config, target.id).timeoutSeconds,
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

export const DEFAULT_FIELDS = makeDefaultFields(FIELDS);

export function fieldById(id: string): FieldDefinition | undefined {
  return FIELDS.find((field) => field.id === id) ?? DEFAULT_FIELDS.find((field) => field.id === id);
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
  return FIELDS.filter((field) => field.applies(target, config)).map((field) => {
    const authored = readPath(declaration, field.path);
    const resolved = field.resolve(config, target, declaration);
    const replaySpec = field.id === "events.localReplay" ? lambdaSpec(config, target.id) : undefined;
    const replayBlocked = replaySpec && (replaySpec.packaging !== "zip" || !isNodeLambdaRuntime(replaySpec.runtime))
      ? "Studio pairs local replay with TypeScript ZIP handlers. Configure this implementation in source." : undefined;
    return {
      field: field.id,
      label: field.label,
      path: field.path,
      domain: field.domain,
      ...resolved,
      ...(authored === undefined ? {} : { authored: primitive(authored) ?? null }),
      ...(origin ? (shared || replayBlocked ? { blocked: shared ?? replayBlocked } : {}) : { blocked: "Its declaration could not be located." }),
    };
  });
}
