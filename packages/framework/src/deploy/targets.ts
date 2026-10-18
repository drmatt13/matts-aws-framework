import type { DeploymentMode } from "./identity";

/**
 * Which deployment a command builds, and in which mode.
 *
 * The mode is stated per command, as CDK context (`-c prodDeployment=true`),
 * never remembered in a file. The deployment's name comes from a target: one
 * declared in cdk-app/cdk.json under `framework:targets` (shared, committed,
 * production pinned to its account), or the developer's own development
 * deployment named by CDK_APP_NAME in their gitignored inputs file. Production
 * is never implied: a production target is built only when the command says
 * prod, and a declared target's mode must agree with what the command says.
 *
 * Pure: callers supply context and the personal name.
 */

export const TARGETS_CONTEXT_KEY = "framework:targets";
export const DEFAULT_DEPLOYMENT_NAME = "matts-aws-framework";
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DeploymentTarget {
  readonly name: string;
  readonly mode: DeploymentMode;
  /** Required for production: a synth for another account is refused. */
  readonly account?: string;
  readonly region?: string;
  /** The authored inputs file, relative to the repository root. */
  readonly inputs?: string;
  /** Declared in cdk.json, the developer's CDK_APP_NAME, or named on the command line. */
  readonly origin: "declared" | "personal" | "named";
}

export interface TargetSelection {
  readonly target: DeploymentTarget;
  readonly mode: DeploymentMode;
  readonly warnings: readonly string[];
}

function assertName(name: string, where: string): string {
  if (!NAME.test(name)) {
    throw new Error(`${where} must be 1-63 lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${name}`);
  }
  return name;
}

export function parseTargets(value: unknown): DeploymentTarget[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${TARGETS_CONTEXT_KEY} in cdk-app/cdk.json must be an object of targets keyed by deployment name.`);
  return Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
    assertName(name, `${TARGETS_CONTEXT_KEY} name ${JSON.stringify(name)}`);
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (entry.mode !== "dev" && entry.mode !== "prod") throw new Error(`${TARGETS_CONTEXT_KEY}.${name}.mode must be "dev" or "prod".`);
    if (entry.account !== undefined && (typeof entry.account !== "string" || !/^\d{12}$/.test(entry.account))) {
      throw new Error(`${TARGETS_CONTEXT_KEY}.${name}.account must be a 12-digit AWS account id.`);
    }
    if (entry.mode === "prod" && entry.account === undefined) {
      throw new Error(`The production target ${name} needs an account: add "account": "<12-digit id>" to ${TARGETS_CONTEXT_KEY}.${name}, so no other account can be deployed to by mistake.`);
    }
    for (const field of ["region", "inputs"] as const) {
      if (entry[field] !== undefined && (typeof entry[field] !== "string" || !entry[field])) throw new Error(`${TARGETS_CONTEXT_KEY}.${name}.${field} must be a non-empty string.`);
    }
    return {
      name, mode: entry.mode, origin: "declared" as const,
      ...(entry.account ? { account: entry.account as string } : {}),
      ...(entry.region ? { region: entry.region as string } : {}),
      ...(entry.inputs ? { inputs: entry.inputs as string } : {}),
    };
  });
}

function contextBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(`${label} must be "true" or "false". Received: ${String(value)}`);
}

/** `-c prodDeployment=true|false`, or the deprecated inverse `-c useLocalDevStack`. */
export function modeFromContext(get: (key: string) => unknown): { mode: DeploymentMode | undefined; warnings: string[] } {
  const prod = contextBoolean(get("prodDeployment"), "-c prodDeployment");
  const local = contextBoolean(get("useLocalDevStack"), "-c useLocalDevStack");
  const warnings: string[] = [];
  if (local !== undefined) {
    warnings.push(`[cdk-app] -c useLocalDevStack is deprecated. Use -c prodDeployment=${!local} instead.`);
    if (prod !== undefined && prod === local) throw new Error(`-c prodDeployment=${prod} and -c useLocalDevStack=${local} disagree about the mode. Pass only -c prodDeployment.`);
  }
  const isProd = prod ?? (local === undefined ? undefined : !local);
  return { mode: isProd === undefined ? undefined : isProd ? "prod" : "dev", warnings };
}

export function selectTarget(input: {
  readonly get: (key: string) => unknown;
  readonly declared: readonly DeploymentTarget[];
  /** CDK_APP_NAME from the developer's development inputs. */
  readonly personalName?: string;
}): TargetSelection {
  const { declared } = input;
  const stated = modeFromContext(input.get);
  const warnings = [...stated.warnings];
  const byName = new Map(declared.map((target) => [target.name, target]));

  const personalName = input.personalName?.trim() ? assertName(input.personalName.trim(), "CDK_APP_NAME") : undefined;
  if (personalName) {
    const clash = byName.get(personalName);
    if (clash && clash.mode !== "dev") {
      throw new Error(`CDK_APP_NAME=${personalName} names the production target ${personalName} in ${TARGETS_CONTEXT_KEY}. Give your development deployment its own name.`);
    }
  }

  const deploymentContext = input.get("deployment");
  const legacyContext = input.get("cdkAppName");
  const namedRaw = deploymentContext ?? legacyContext;
  if (namedRaw !== undefined && namedRaw !== null && String(namedRaw) !== "") {
    const name = assertName(String(namedRaw), deploymentContext !== undefined ? "-c deployment" : "-c cdkAppName");
    const target = byName.get(name);
    if (target) {
      if (stated.mode === undefined && target.mode === "prod") {
        throw new Error(`${name} is a production target. State it explicitly with -c prodDeployment=true.`);
      }
      if (stated.mode !== undefined && stated.mode !== target.mode) {
        throw new Error(`${name} is declared ${target.mode} in ${TARGETS_CONTEXT_KEY}; -c prodDeployment=${stated.mode === "prod"} disagrees.`);
      }
      return { target, mode: target.mode, warnings };
    }
    const mode = stated.mode ?? "dev";
    if (mode === "prod") {
      if (declared.length) throw new Error(`Declare ${name} in ${TARGETS_CONTEXT_KEY} with its account before deploying it as production.`);
      warnings.push(`[cdk-app] ${name} is built as production with no account pin. Declare it in ${TARGETS_CONTEXT_KEY} to pin its account.`);
    }
    return { target: { name, mode, origin: "named" }, mode, warnings };
  }

  if (stated.mode === "prod") {
    const production = declared.filter((target) => target.mode === "prod");
    if (production.length === 1) return { target: production[0]!, mode: "prod", warnings };
    if (production.length > 1) {
      throw new Error(`Several production targets are declared; choose one with -c deployment=<name>: ${production.map((target) => target.name).join(", ")}.`);
    }
    const name = personalName ?? DEFAULT_DEPLOYMENT_NAME;
    warnings.push(`[cdk-app] ${name} is built as production with no account pin. Declare it in ${TARGETS_CONTEXT_KEY} to pin its account.`);
    return { target: { name, mode: "prod", origin: "named" }, mode: "prod", warnings };
  }

  if (personalName) {
    const declaredDev = byName.get(personalName);
    return { target: declaredDev ?? { name: personalName, mode: "dev", origin: "personal" }, mode: "dev", warnings };
  }
  const development = declared.filter((target) => target.mode === "dev");
  if (development.length === 1) return { target: development[0]!, mode: "dev", warnings };
  return { target: { name: DEFAULT_DEPLOYMENT_NAME, mode: "dev", origin: "personal" }, mode: "dev", warnings };
}
