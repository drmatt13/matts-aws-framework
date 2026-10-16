import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { Mode } from "../shared/model";

/**
 * The two deployment settings the studio reads, and nothing else.
 *
 * `@repo/framework/config/source` reads the whole of cdk-app/.env when it is
 * imported, which is right for synthesis and wrong for a tool that never needs
 * an authored value. So the server does not import it: it keeps the lines that
 * set PROD_DEPLOYMENT and DEPLOY_PROD_WEBSOCKET_API, parses only those, and
 * hands each evaluator a file of its own holding one line. A secret authored in
 * cdk-app/.env is therefore never parsed, held, or sent anywhere by the studio.
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
  readonly currentMode: Mode;
  readonly webSocketApi: boolean;
}

const WANTED = /^\s*(?:export\s+)?(PROD_DEPLOYMENT|DEPLOY_PROD_WEBSOCKET_API)\s*=/;

/** Strictly "true" is true, as cdk-app/deployment.ts and config/source.ts read it. */
function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function readDeploymentSettings(repositoryRoot: string): DeploymentSettings {
  const file = path.join(repositoryRoot, "cdk-app", ".env");
  if (!existsSync(file)) return { currentMode: "dev", webSocketApi: false };
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => WANTED.test(line))
    .join("\n");
  const values = parseEnv(kept);
  return {
    currentMode: flag(values.PROD_DEPLOYMENT) ? "prod" : "dev",
    webSocketApi: flag(values.DEPLOY_PROD_WEBSOCKET_API),
  };
}

/** The inputs file one mode's evaluator loads in place of cdk-app/.env. */
export function writeModeInputs(repositoryRoot: string, mode: Mode): string {
  const directory = path.join(repositoryRoot, STUDIO_SCRATCH);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `inputs-${mode}.env`);
  writeFileSync(file, `PROD_DEPLOYMENT=${mode === "prod" ? "true" : "false"}\n`);
  return file;
}
