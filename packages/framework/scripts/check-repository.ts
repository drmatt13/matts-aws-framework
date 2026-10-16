import {
  formatResourceReference,
  getFrameworkTargets,
  isTargetDeployed,
  isTargetEnabled,
  type FrameworkConfig,
  type ResourceReference,
} from "../src/config/index";

/**
 * The templates a developer copies cdk-app/.env from, and the graph each one
 * sets up: the dev template a development deployment and the local lane, the
 * prod template a full deployment. A repository convention, checked by this
 * repository's framework:check rather than by the framework.
 */
export const INPUT_TEMPLATES = {
  "cdk-app/.env.dev.example": "dev",
  "cdk-app/.env.prod.example": "prod",
} as const satisfies Record<string, "dev" | "prod">;

export interface InputTemplate {
  readonly file: string;
  readonly graph: "dev" | "prod";
  readonly text: string;
}

/**
 * Each input a workload cannot run without that the template for its graph
 * leaves out, with the lines it should have.
 *
 * Only a required input is checked: one a workload names in
 * `cloud.requirements`. The catalog's own inputs are optional — a `fromEnv`
 * until a `.default()` answers it, a secret always — so leaving one out of a
 * template breaks nothing, and documenting it stays the author's choice. A
 * requirement is checked against the template whose graph runs the workload:
 * one only a full deployment builds does not belong in the dev template. A
 * template lists an input by `NAME=` or a commented `# NAME=`; nothing here
 * writes one.
 */
export function undocumentedRequiredInputs(
  config: FrameworkConfig,
  templates: readonly InputTemplate[],
): readonly string[] {
  const required = new Map<string, { readonly graphs: Set<"dev" | "prod">; readonly origin: string; readonly why: string }>();
  for (const target of getFrameworkTargets(config)) {
    const graphs = new Set<"dev" | "prod">();
    if (isTargetEnabled(config, target.kind, target.id, "local") || isTargetDeployed(config, target.kind, target.id, "dev")) graphs.add("dev");
    if (isTargetDeployed(config, target.kind, target.id, "prod")) graphs.add("prod");
    if (graphs.size === 0) continue;
    for (const requirement of target.cloud.requirements) {
      const when = requirement.when
        ? ` when ${requirement.when.resource.fromEnv ?? formatResourceReference(requirement.when.resource)} is ${requirement.when.equals}`
        : "";
      for (const reference of requirement.require as readonly ResourceReference[]) {
        const name = reference.fromEnv;
        if (!name) continue;
        const entry = required.get(name) ?? { graphs: new Set(), origin: target.origins[0] ?? target.reference, why: `${when}${requirement.message ? `: ${requirement.message}` : ""}` };
        for (const graph of graphs) entry.graphs.add(graph);
        required.set(name, entry);
      }
    }
  }
  const problems: string[] = [];
  for (const [name, { graphs, origin, why }] of required) {
    const listed = new RegExp(`^#?[ \\t]*${name}=`, "m");
    for (const template of templates) {
      if (!graphs.has(template.graph) || listed.test(template.text)) continue;
      problems.push(`${template.file} does not list ${name}, which ${origin} requires. Add:\n  # Required${why}\n  ${name}=`);
    }
  }
  return problems;
}
