import { createRequire } from "node:module";
import path from "node:path";
import { deployKey, listDeployConditions, type DeployInputs, type FrameworkConfig } from "@repo/framework/config";
import { failedModel, projectModel } from "../model/project";
import type { Mode } from "../../shared/model";
import { ARCHITECTURE_PREVIEW_ARTIFACT_MARKER, ARCHITECTURE_PREVIEW_LIMIT, ARCHITECTURE_PREVIEW_PROTOCOL } from "./architecture-preview";
import { writeEvaluationArtifact } from "../evaluator/result-artifact";

/** Bundled by the host, then executed only in a restricted read-only source sandbox. */
export function runArchitectureWorker(mode: Mode, artifactFile: string): void {
  const started = performance.now();
  let unresolvedConditions = false;
  let model;
  try {
    const localRequire = createRequire(path.join(process.cwd(), "package.json"));
    let config: unknown = localRequire(path.join(process.cwd(), "framework.config.ts"));
    for (let hop = 0; hop < 4; hop++) {
      if (config && typeof config === "object" && "defaults" in config && "http" in config) break;
      config = (config as { default?: unknown } | undefined)?.default;
    }
    if (!config || typeof config !== "object" || !("defaults" in config) || !("http" in config)) throw new Error("framework.config.ts has no supported default configuration.");
    const declaration = config as FrameworkConfig;
    const conditions = listDeployConditions(declaration);
    unresolvedConditions = conditions.length > 0;
    // No parent broker, environment-file resolution, or secret-dependent oracle.
    const outcomes = Object.fromEntries(conditions.map(condition => [deployKey({ when: condition }), { dev: "unset" as const, prod: "unset" as const }]));
    const unknown: DeployInputs = { holds: () => false };
    model = projectModel(declaration, { mode, inputs: { dev: unknown, prod: unknown }, outcomes }, Math.round(performance.now() - started));
  } catch (error) { model = failedModel(mode, error, Math.round(performance.now() - started)); }
  const receipt = writeEvaluationArtifact(artifactFile, { version: ARCHITECTURE_PREVIEW_PROTOCOL, mode, unresolvedConditions, model }, ARCHITECTURE_PREVIEW_LIMIT - 1024);
  process.stdout.write(`${ARCHITECTURE_PREVIEW_ARTIFACT_MARKER}${JSON.stringify(receipt)}\n`);
}
