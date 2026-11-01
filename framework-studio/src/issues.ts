import type { InputRequirement } from "../shared/deployment-inputs";
import type { Diagnostic, Mode, ModelResource, ModelTarget } from "../shared/model";
import type { IconKey } from "./icons";
import { entryCount, groupEntries } from "./input-groups";

/**
 * Something wrong with an entity that its owner can fix. An error stops synthesis or a run; a
 * warning leaves something out of it. Every surface reads these producers, so the map badge and
 * caption, the hover card, the Resources row and the inspector notice say the same thing.
 */
export type IssueSeverity = "error" | "warning";

export interface EntityIssue {
  readonly severity: IssueSeverity;
  /** A few words: the notice heading, the badge's meaning and the Resources marker's name. */
  readonly title: string;
  /** What is wrong and how to fix it, one sentence or message each. Names and presence only, never a value. */
  readonly details: readonly string[];
  /** Painted at the map icon's right corner; a connection marks its wire instead. */
  readonly badge: IconKey;
}

const ENVIRONMENT: Readonly<Record<Mode, string>> = { dev: "Development", prod: "Production" };

/** Errors first, so the first issue is the one the map paints. */
const ordered = (issues: readonly EntityIssue[]): readonly EntityIssue[] =>
  [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

/**
 * `resources` is the viewed graph's catalog: a group's issue reads its entries there. Requirements
 * are per graph, so the other environment's missing values recede with it.
 */
export function resourceIssues(resource: ModelResource, resources?: Iterable<ModelResource>): readonly EntityIssue[] {
  const issues: EntityIssue[] = [];
  const file = resource.deploymentFile;
  if (file && !file.exists) {
    issues.push({ severity: "error", title: "Not generated", badge: "error",
      details: [`${ENVIRONMENT[file.mode]} synthesis reads its inputs from this file. Generate it from ${file.template}.`] });
  } else if (file?.problem) {
    issues.push({ severity: "error", title: "Could not be read", badge: "error", details: [file.problem] });
  }
  if (resource.stackUsage?.status === "unreferenced") {
    issues.push({ severity: "warning", title: "Not added to CDK app", badge: "unattached",
      details: ["Declared in the catalog, with no constructor reference in the CDK app's runtime imports. Add it to the app to include it in synthesis."] });
  }
  const unset = missingValueIssue(resource, resources);
  if (unset) issues.push(unset);
  return ordered(issues);
}

const valueMissing = (entry: ModelResource): boolean => !entry.absent && entry.inputRequirement?.status === "missing";

/**
 * A required input or secret that no value or default supplies, or a group holding any. Hover
 * cards show these words, so they name variables and files only, never values or private reasons.
 */
function missingValueIssue(resource: ModelResource, resources?: Iterable<ModelResource>): EntityIssue | undefined {
  if (resource.kind === "input" || resource.kind === "secret") {
    if (!valueMissing(resource)) return undefined;
    const { name, file, mode } = resource.inputRequirement!;
    return { severity: "error", title: "Required value missing", badge: "error", details: [
      `${name} is required for ${ENVIRONMENT[mode]}, and ${file} gives it no value.`,
      resource.kind === "secret" ? `Set it in ${file}; a secret never takes a source default.` : `Set it in ${file}, or define a default on the parameter.`,
    ] };
  }
  if (resource.kind !== "group" || !resources) return undefined;
  const unmet = groupEntries(resource, resources).filter(valueMissing);
  if (!unmet.length) return undefined;
  const one = unmet.length === 1;
  const files = [...new Set(unmet.map(entry => entry.inputRequirement!.file))].join(" and ");
  const defaults = unmet.some(entry => entry.kind === "input");
  return { severity: "error", title: one ? "Required value missing" : "Required values missing", badge: "error", details: [
    `${entryCount(unmet)} ${one ? "is missing its required value" : "are missing their required values"} in ${files}.`,
    `Set ${one ? "it" : "them"} there${defaults ? `, or define ${one ? "a default on the parameter" : "defaults on the parameters"}` : ""}.`,
  ] };
}

/** Missing source artifacts, and the framework's own validation messages that name this workload. */
export function targetIssues(target: ModelTarget, diagnostics: readonly Diagnostic[] = []): readonly EntityIssue[] {
  const issues: EntityIssue[] = [];
  const problems = target.implementation?.ready === false ? target.implementation.problems : [];
  if (target.implementation?.ready === false) {
    issues.push({ severity: "error", title: "Implementation needs attention", badge: "error",
      details: problems.length ? problems : ["Required source artifacts are missing."] });
  }
  for (const severity of ["error", "warning"] as const) {
    const messages = [...new Set(diagnostics
      .filter(diagnostic => diagnostic.entity === target.ref && diagnostic.severity === severity && !problems.includes(diagnostic.message))
      .map(diagnostic => diagnostic.message))];
    if (messages.length) issues.push({ severity, title: severity === "error" ? "Configuration error" : "Configuration warning",
      badge: severity === "error" ? "error" : "warning", details: messages });
  }
  return ordered(issues);
}

/** A required input that no value or default supplies. Reasons are inspector copy; previews never show them. */
export function requirementIssue(requirement: InputRequirement | undefined): EntityIssue | undefined {
  if (!requirement?.required || requirement.status !== "missing") return undefined;
  return { severity: "error", title: "Required value missing", badge: "error",
    details: [`${requirement.name} is required for ${ENVIRONMENT[requirement.mode]}. No non-blank environment value or declaration default supplies it.`, ...requirement.reasons] };
}
