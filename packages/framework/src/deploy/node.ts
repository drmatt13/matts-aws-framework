import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentMode } from "./identity";
import { parseTargets, selectTarget, TARGETS_CONTEXT_KEY, type DeploymentTarget } from "./targets";

/**
 * The repository's half of target resolution: cdk.json, the inputs files and
 * the command line. The CDK app, the deploy, export and status scripts and
 * Studio all resolve a target through `resolveRepositoryTarget`, so they cannot
 * disagree about which deployment, mode and inputs file a command means.
 */

export interface RepositoryTarget {
  readonly target: DeploymentTarget;
  readonly mode: DeploymentMode;
  /** Absolute path of the authored inputs file this target reads. */
  readonly inputsFile: string;
  readonly warnings: readonly string[];
}

/** `-c key=value`, `--context key=value` and `--context=key=value`, as the CDK CLI reads them. */
export function contextFromArgs(args: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    let pair: string | undefined;
    if (arg === "-c" || arg === "--context") pair = args[++index];
    else if (arg.startsWith("--context=")) pair = arg.slice("--context=".length);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) context[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return context;
}

export function readCdkContext(root: string): Record<string, unknown> {
  const file = path.join(root, "cdk-app", "cdk.json");
  if (!existsSync(file)) return {};
  try {
    const context = (JSON.parse(readFileSync(file, "utf8")) as { context?: unknown }).context;
    return context && typeof context === "object" ? context as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`cdk-app/cdk.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `cdk-app/.env.dev` or `cdk-app/.env.prod`, whichever the mode (`-c
 * prodDeployment`) selects. There is no mode-less `cdk-app/.env`, and the path is
 * returned whether or not the file exists: a missing file is the caller's to
 * report, and Studio's CDK environment files island generates it.
 */
export function deploymentInputsFile(root: string, mode: DeploymentMode): string {
  return path.join(root, "cdk-app", `.env.${mode}`);
}

function readInputs(file: string): Record<string, string | undefined> {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

export function resolveRepositoryTarget(input: {
  readonly root: string;
  readonly get: (key: string) => unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** False for callers that only need the target's name and pins, not its authored inputs. */
  readonly requireInputs?: boolean;
}): RepositoryTarget {
  // A path the caller typed, so relative to where they ran the command, as it always was.
  const override = input.env.FRAMEWORK_INPUTS_FILE ? path.resolve(input.env.FRAMEWORK_INPUTS_FILE) : undefined;
  const developmentInputs = override ?? deploymentInputsFile(input.root, "dev");
  const context = readCdkContext(input.root);
  const declared = parseTargets(input.get(TARGETS_CONTEXT_KEY) ?? context[TARGETS_CONTEXT_KEY]);
  const selection = selectTarget({ get: input.get, declared, personalName: readInputs(developmentInputs).CDK_APP_NAME });
  let inputsFile: string;
  if (override) inputsFile = override;
  else if (selection.target.inputs) {
    inputsFile = path.resolve(input.root, selection.target.inputs);
    if (input.requireInputs !== false && !existsSync(inputsFile)) {
      throw new Error(`${selection.target.name} reads ${selection.target.inputs}, which does not exist. Create ${selection.target.inputs} from cdk-app/.env.${selection.mode}.template.`);
    }
  } else inputsFile = deploymentInputsFile(input.root, selection.mode);
  return { ...selection, inputsFile };
}

/**
 * Every deployment this repository intends: the targets cdk.json declares, and
 * the developer's own development deployment (CDK_APP_NAME) unless it is one.
 */
export function repositoryTargets(root: string, env: Readonly<Record<string, string | undefined>> = process.env): DeploymentTarget[] {
  const declared = parseTargets(readCdkContext(root)[TARGETS_CONTEXT_KEY]);
  const developmentInputs = env.FRAMEWORK_INPUTS_FILE ? path.resolve(env.FRAMEWORK_INPUTS_FILE) : deploymentInputsFile(root, "dev");
  const personal = readInputs(developmentInputs).CDK_APP_NAME?.trim();
  if (!personal || declared.some((target) => target.name === personal)) return declared;
  return [{ name: personal, mode: "dev", origin: "personal", inputs: path.relative(root, developmentInputs).replace(/\\/g, "/") }, ...declared];
}

/** The graph the catalog is evaluated for, as the CDK app's entry point resolved it. */
export function frameworkMode(env: Readonly<Record<string, string | undefined>> = process.env): DeploymentMode {
  const value = env.FRAMEWORK_MODE;
  if (value === undefined || value === "" || value === "dev") return "dev";
  if (value === "prod") return "prod";
  throw new Error(`FRAMEWORK_MODE must be "dev" or "prod". Received: ${value}`);
}
