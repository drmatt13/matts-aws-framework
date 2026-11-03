import type { DeploymentMode } from "./identity";

/**
 * Which deployment a command builds, and in which mode.
 *
 * The mode is stated per command, as CDK context (`-c prodDeployment=true`),
 * never remembered in a file. Deployments are named from one tracked app name:
 * `framework:app` in cdk-app/cdk.json names the app, and each `framework:targets`
 * key is a stage that deploys as `<app>-<stage>`, unless the target says
 * `deployAs` another name. The `dev` stage exists even when undeclared.
 * `framework:appId` never changes: every stack is tagged with it and its stage,
 * so a deployment stays recognizable as this app's after a rename.
 * Production is never implied: a production target is built only when the
 * command says prod, and a target's mode must agree with what the command says.
 *
 * Pure: callers supply the context.
 */

export const APP_CONTEXT_KEY = "framework:app";
export const APP_ID_CONTEXT_KEY = "framework:appId";
export const TARGETS_CONTEXT_KEY = "framework:targets";
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** App names and stage keys: the deployment name's limit is checked on the result. */
const LABEL = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const IMPLIED_MODE: Readonly<Record<string, DeploymentMode>> = { dev: "dev", prod: "prod" };
const TARGET_FIELDS = new Set(["mode", "account", "region", "inputs", "deployAs"]);
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DeploymentTarget {
  readonly name: string;
  readonly mode: DeploymentMode;
  /** The `framework:targets` key; absent for a deployment named only on the command line. */
  readonly stage?: string;
  /** `framework:appId`: with the stage, what every stack is tagged with, whatever the deployment is named. */
  readonly appId?: string;
  /** The target's `deployAs`, which names it instead of `<app>-<stage>`; equal to `name` when set. */
  readonly deployAs?: string;
  /** Required for production: a synth for another account is refused. */
  readonly account?: string;
  readonly region?: string;
  /** The authored inputs file, relative to the repository root. */
  readonly inputs?: string;
  /** Declared in cdk.json, the undeclared development stage, or named on the command line. */
  readonly origin: "declared" | "implicit" | "named";
}

export interface TargetSelection {
  readonly target: DeploymentTarget;
  readonly mode: DeploymentMode;
  readonly warnings: readonly string[];
}

export function deploymentNameProblem(name: string): string | undefined {
  return NAME.test(name)
    ? undefined
    : `must be 1-63 lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${name}`;
}

function assertName(name: string, where: string): string {
  const problem = deploymentNameProblem(name);
  if (problem) throw new Error(`${where} ${problem}`);
  return name;
}

/** Why `framework:app` cannot name deployments, with the fix; undefined when it can. */
export function appNameProblem(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return `cdk-app/cdk.json has no "${APP_CONTEXT_KEY}". Deployments are named <app>-<stage>: add "${APP_CONTEXT_KEY}": "<lowercase-name>" to its context. If ${TARGETS_CONTEXT_KEY} already lists deployments by full name, add "deployAs": "<that name>" to each so nothing is renamed. AWS Studio's navbar does both in one reviewed change.`;
  }
  if (typeof value !== "string" || !LABEL.test(value)) {
    return `${APP_CONTEXT_KEY} must be lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${JSON.stringify(value)}`;
  }
  return undefined;
}

export function parseAppName(value: unknown): string {
  const problem = appNameProblem(value);
  if (problem) throw new Error(problem);
  return value as string;
}

/** A new `framework:appId`. */
export function newAppId(): string {
  return globalThis.crypto.randomUUID();
}

/** Why `framework:appId` cannot identify the app's deployments, with the fix; undefined when it can. */
export function appIdProblem(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return `cdk-app/cdk.json has no "${APP_ID_CONTEXT_KEY}", the permanent id every stack is tagged with so its deployment is recognized after the app is renamed. Add one to its context, once, and never change it: "${APP_ID_CONTEXT_KEY}": "<the output of node -p "crypto.randomUUID()">". AWS Studio's navbar adds one when you rename the app.`;
  }
  if (typeof value !== "string" || !APP_ID.test(value)) {
    return `${APP_ID_CONTEXT_KEY} must be a lowercase UUID: 8-4-4-4-12 hexadecimal digits. Received: ${JSON.stringify(value)}`;
  }
  return undefined;
}

export function parseAppId(value: unknown): string {
  const problem = appIdProblem(value);
  if (problem) throw new Error(problem);
  return value as string;
}

export function deploymentNameFor(app: string, stage: string): string {
  return `${app}-${stage}`;
}

function derivedName(app: string, stage: string): string {
  const name = deploymentNameFor(app, stage);
  const problem = deploymentNameProblem(name);
  if (problem) {
    throw new Error(`The ${stage} stage deploys as ${name} (${name.length} characters), which is not a deployment name: it ${problem}. Shorten ${APP_CONTEXT_KEY} or the stage, or set "deployAs" in ${TARGETS_CONTEXT_KEY}.${stage}.`);
  }
  return name;
}

export function parseTargets(value: unknown, app: string, appId?: string): DeploymentTarget[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${TARGETS_CONTEXT_KEY} in cdk-app/cdk.json must be an object of targets keyed by stage, for example "prod".`);
  return Object.entries(value as Record<string, unknown>).map(([stage, raw]) => {
    if (!LABEL.test(stage)) throw new Error(`${TARGETS_CONTEXT_KEY} stage ${JSON.stringify(stage)} must be lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen.`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${TARGETS_CONTEXT_KEY}.${stage} must be an object.`);
    const entry = raw as Record<string, unknown>;
    // A misspelled setting would otherwise be ignored, and a misspelled deployAs would move a deployment.
    const unknown = Object.keys(entry).filter((key) => !TARGET_FIELDS.has(key));
    if (unknown.length) {
      throw new Error(`${TARGETS_CONTEXT_KEY}.${stage} has unknown ${unknown.length === 1 ? "setting" : "settings"} ${unknown.map((key) => JSON.stringify(key)).join(", ")}. A target takes mode, account, region, inputs and deployAs.${"deployment" in entry ? ` "deployment" is now "deployAs".` : ""}`);
    }
    if (entry.mode !== undefined && entry.mode !== "dev" && entry.mode !== "prod") throw new Error(`${TARGETS_CONTEXT_KEY}.${stage}.mode must be "dev" or "prod".`);
    const implied = IMPLIED_MODE[stage];
    if (implied && entry.mode !== undefined && entry.mode !== implied) {
      throw new Error(`${TARGETS_CONTEXT_KEY}.${stage} is the ${implied === "dev" ? "development" : "production"} stage; its mode cannot be "${String(entry.mode)}".`);
    }
    const mode = (entry.mode as DeploymentMode | undefined) ?? implied;
    if (!mode) throw new Error(`${TARGETS_CONTEXT_KEY}.${stage}.mode must be "dev" or "prod": only the dev and prod stages imply their mode.`);
    if (entry.account !== undefined && (typeof entry.account !== "string" || !/^\d{12}$/.test(entry.account))) {
      throw new Error(`${TARGETS_CONTEXT_KEY}.${stage}.account must be a 12-digit AWS account id.`);
    }
    if (mode === "prod" && entry.account === undefined) {
      throw new Error(`The production stage ${stage} needs an account: add "account": "<12-digit id>" to ${TARGETS_CONTEXT_KEY}.${stage}, so no other account can be deployed to by mistake.`);
    }
    for (const field of ["region", "inputs", "deployAs"] as const) {
      if (entry[field] !== undefined && (typeof entry[field] !== "string" || !entry[field])) throw new Error(`${TARGETS_CONTEXT_KEY}.${stage}.${field} must be a non-empty string.`);
    }
    const deployAs = typeof entry.deployAs === "string" ? assertName(entry.deployAs, `${TARGETS_CONTEXT_KEY}.${stage}.deployAs`) : undefined;
    const name = deployAs ?? derivedName(app, stage);
    return {
      name, mode, stage, origin: "declared" as const,
      ...(appId ? { appId } : {}),
      ...(deployAs ? { deployAs } : {}),
      ...(entry.account ? { account: entry.account as string } : {}),
      ...(entry.region ? { region: entry.region as string } : {}),
      ...(entry.inputs ? { inputs: entry.inputs as string } : {}),
    };
  });
}

/**
 * Every deployment the repository declares, led by the development stage, which
 * exists as `<app>-dev` whether or not cdk.json declares it. Names are unique.
 */
export function projectTargets(input: { readonly app: unknown; readonly appId: unknown; readonly targets: unknown }): DeploymentTarget[] {
  const app = parseAppName(input.app);
  const appId = parseAppId(input.appId);
  const declared = parseTargets(input.targets, app, appId);
  const targets: DeploymentTarget[] = declared.some((target) => target.stage === "dev")
    ? declared
    : [{ name: derivedName(app, "dev"), mode: "dev", stage: "dev", appId, origin: "implicit" }, ...declared];
  const byName = new Map<string, DeploymentTarget>();
  for (const target of targets) {
    const other = byName.get(target.name);
    if (other) throw new Error(`The ${other.stage} and ${target.stage} stages both deploy as ${target.name}. Give one a different stage or "deployAs" in ${TARGETS_CONTEXT_KEY}.`);
    byName.set(target.name, target);
  }
  return targets;
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
  /** The repository's targets, as `projectTargets` lists them. */
  readonly targets: readonly DeploymentTarget[];
}): TargetSelection {
  const { targets } = input;
  const stated = modeFromContext(input.get);
  const warnings = [...stated.warnings];
  const byName = new Map(targets.map((target) => [target.name, target]));
  const present = (value: unknown) => value !== undefined && value !== null && String(value) !== "";

  const deploymentContext = input.get("deployment");
  const legacyContext = input.get("cdkAppName");
  if (present(legacyContext)) {
    warnings.push(`[cdk-app] -c cdkAppName is deprecated. Use -c deployment=${String(legacyContext)} instead.`);
    if (present(deploymentContext) && String(deploymentContext) !== String(legacyContext)) {
      throw new Error(`-c deployment=${String(deploymentContext)} and -c cdkAppName=${String(legacyContext)} disagree. Pass only -c deployment.`);
    }
  }
  const namedRaw = present(deploymentContext) ? deploymentContext : present(legacyContext) ? legacyContext : undefined;
  if (namedRaw !== undefined) {
    const name = assertName(String(namedRaw), present(deploymentContext) ? "-c deployment" : "-c cdkAppName");
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
    // A stage key is not a deployment name; building it would create an undeclared deployment called "prod".
    const stage = targets.find((candidate) => candidate.stage === name);
    if (stage) throw new Error(`${name} is a stage, not a deployment: it deploys as ${stage.name}. Use -c deployment=${stage.name}.`);
    if (stated.mode === "prod") throw new Error(`Declare ${name} in ${TARGETS_CONTEXT_KEY} with its account before deploying it as production.`);
    return { target: { name, mode: "dev", origin: "named" }, mode: "dev", warnings };
  }

  if (stated.mode === "prod") {
    const production = targets.filter((target) => target.mode === "prod");
    if (production.length === 1) return { target: production[0]!, mode: "prod", warnings };
    if (production.length > 1) {
      throw new Error(`Several production targets are declared; choose one with -c deployment=<name>: ${production.map((target) => `${target.name} (${target.stage})`).join(", ")}.`);
    }
    throw new Error(`No production target is declared. Add a "prod" stage with its account to ${TARGETS_CONTEXT_KEY} in cdk-app/cdk.json.`);
  }

  const development = targets.find((target) => target.stage === "dev") ?? targets.find((target) => target.mode === "dev");
  if (!development) throw new Error(`No development stage is declared. List targets with projectTargets, which adds the dev stage.`);
  return { target: development, mode: "dev", warnings };
}
