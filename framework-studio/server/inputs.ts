import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { Mode } from "../shared/model";
import { selectedDeploymentInput } from "./deployment-inputs";

/**
 * The two deployment settings used for graph evaluation.
 *
 * The server reads dotenv privately but sends only flags to graph evaluators.
 * Each evaluator receives a synthetic file holding PROD_DEPLOYMENT, never authored
 * values. Parse complete dotenv syntax so multiline secret contents cannot be
 * mistaken for flag assignments. Selected value reads remain separately guarded.
 */

export const STUDIO_SCRATCH = path.join(".cache", "framework-studio");

/** The directory holding framework.config.ts and cdk-app/lambda_functions, as the framework finds it. */
export function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "framework.config.ts")) && existsSync(path.join(current, "cdk-app", "lambda_functions"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No framework repository above ${start}.`);
    current = parent;
  }
}

export interface DeploymentSettings {
  readonly webSocketApi: boolean;
}

/** Strictly "true" is true, as cdk-app/deployment.ts and config/source.ts read it. */
function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function readDeploymentSettings(repositoryRoot: string): DeploymentSettings {
  return {
    webSocketApi: readModeWebSocketApi(repositoryRoot, "dev", false),
  };
}

/** Evaluators receive flags only, never the selected file's authored values. */
export function readModeWebSocketApi(root: string, mode: Mode, fallback: boolean): boolean {
  const file = path.join(root, selectedDeploymentInput(root, mode));
  return existsSync(file) ? flag(parseEnv(readFileSync(file, "utf8")).DEPLOY_PROD_WEBSOCKET_API) : fallback;
}

/** The synthetic inputs file one mode's evaluator loads in place of its cdk-app/.env.<mode>. */
export function writeModeInputs(repositoryRoot: string, mode: Mode): string {
  const directory = path.join(repositoryRoot, STUDIO_SCRATCH);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `inputs-${mode}.env`);
  writeFileSync(file, `PROD_DEPLOYMENT=${mode === "prod" ? "true" : "false"}\n`);
  return file;
}
