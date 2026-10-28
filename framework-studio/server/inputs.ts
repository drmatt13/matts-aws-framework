import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { Mode } from "../shared/model";
import { selectedDeploymentInput } from "./deployment-inputs";
import { deployKey, referenceForGraph, resolveInput, type DeployCondition, type ResourceReference } from "@repo/framework/config";

/**
 * Only outcomes cross IPC; authored values stay in the Studio server.
 *
 * One evaluator asks about both graphs, but its references were resolved for its own. Each
 * graph's outcome reads that graph's policy and that graph's file, so a per-graph default
 * never answers for the other graph.
 */
export function resolveDeployOutcomes(root: string, conditions: readonly DeployCondition[]) {
  const result: Record<string, { dev: "holds" | "fails" | "unset"; prod: "holds" | "fails" | "unset" }> = {};
  for (const mode of ["dev", "prod"] as const) {
    const file = path.join(root, selectedDeploymentInput(root, mode));
    const env = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    for (const condition of conditions) {
      const key = deployKey({ when: condition });
      const resolved = resolveInput(referenceForGraph(condition.resource as ResourceReference, mode), { env });
      if (resolved.state === "invalid") throw new Error(`Deployment condition ${condition.resource.fromEnv} must be one of ${condition.resource.values?.join(", ")}.`);
      (result[key] ??= { dev: "unset", prod: "unset" })[mode] = resolved.state === "supplied" || resolved.state === "fallback" ? resolved.value === condition.equals ? "holds" : "fails" : "unset";
    }
  }
  return result;
}

/**
 * Private deployment inputs and sanitized outcomes for graph evaluation.
 *
 * The server reads dotenv privately and sends only condition outcomes to evaluators.
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

/** The synthetic inputs file one mode's evaluator loads in place of its cdk-app/.env.<mode>. */
export function writeModeInputs(repositoryRoot: string, mode: Mode): string {
  const directory = path.join(repositoryRoot, STUDIO_SCRATCH);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `inputs-${mode}.env`);
  writeFileSync(file, `PROD_DEPLOYMENT=${mode === "prod" ? "true" : "false"}\n`);
  return file;
}
