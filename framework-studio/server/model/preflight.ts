import { getFrameworkTargets, type FrameworkConfig } from "@repo/framework/config";
import type { PreflightResult } from "../../shared/api";
import { DEFAULT_FIELDS, fieldFacts } from "../edits/fields";
import { projectDefaults } from "../edits/defaults";
import { applyPatch, type SemanticPatch } from "./origin";
import { targetLanes, targetPlacement, validateForMode, type ProjectionOptions } from "./project";

/**
 * What a change would do, decided before anything is written.
 *
 * The patched config is the evaluated one with exactly the property the text
 * edit changes, so running the framework's own checks on it is running them on
 * the edited source — without the edited source ever existing on disk, where
 * Compose Watch would restart the dev servers on a file that might not load.
 */

export interface PreflightRequest {
  readonly target: string;
  readonly field: string;
  readonly patch: SemanticPatch;
}

export type { PreflightResult };

export function preflight(
  config: FrameworkConfig,
  request: PreflightRequest,
  options: ProjectionOptions,
): PreflightResult {
  let patched: FrameworkConfig;
  try {
    patched = applyPatch(config, request.patch);
  } catch (error) {
    return {
      mode: options.mode,
      ok: false,
      diagnostics: [{ severity: "error", stage: "validate", message: error instanceof Error ? error.message : String(error) }],
    };
  }
  let targets;
  try {
    targets = getFrameworkTargets(patched);
  } catch (error) {
    return {
      mode: options.mode,
      ok: false,
      diagnostics: [{ severity: "error", stage: "validate", message: error instanceof Error ? error.message : String(error) }],
    };
  }
  const diagnostics = validateForMode(patched, options, targets);
  const target = targets.find((candidate) => candidate.reference === request.target);
  const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const predicted = ok ? request.target.startsWith("defaults:")
    ? projectDefaults(patched, targets, DEFAULT_FIELDS).fields[request.target]?.find((fact) => fact.field === request.field)
    : target ? fieldFacts(patched, target).find((fact) => fact.field === request.field) : undefined : undefined;
  return {
    mode: options.mode,
    ok,
    diagnostics,
    ...(predicted ? { predicted } : {}),
    ...(target && ok ? { lanes: targetLanes(patched, target, options), placement: targetPlacement(patched, target) } : {}),
  };
}
