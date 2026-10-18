import type { Mode, ModelEdge, ModelResource, Relation, TargetKind } from "../../shared/model";
import { API_EDGE_COLOR, COMPUTE_EDGE_COLOR, EDGE_COLORS, GUARD_EDGE_COLOR, READ_EDGE_COLOR, STEP_EDGE_COLOR, TOOL_EDGE_COLOR } from "./look";
import type { SceneNode } from "./build";
import type { EdgeCategory } from "../lookup";

/**
 * How a connection is coloured and dashed, decided from the model alone. Every connection points the way
 * the model records it, from the workload to what it references.
 *
 * Solid lines are the exceptions, each named: an API route, a Lambda or container leaving for another
 * workload, an authorizer, an agent calling a tool and a workflow step. Everything else is dashed.
 *
 * What a workload references decides the colour: a value being read takes the look of an environment file
 * supplying an input, while a secret and a grant are red, so a parameter being read never looks like a
 * permission being given.
 */
export interface ConnectionStyle {
  readonly color: string;
  readonly dashed: boolean;
}

const REFERENCES: ReadonlySet<Relation> = new Set(["env", "secret", "grant"]);
/** Lambda functions and container services and tasks: the workloads AWS colours as compute. */
const COMPUTE_TARGETS: ReadonlySet<TargetKind> = new Set(["lambda", "service", "task"]);

/**
 * `destination` is the model resource the edge points at, which can be a stack field the map shows as
 * its owning stack: what is referenced decides the style, not what is drawn.
 */
export function connectionStyle(
  edge: Pick<ModelEdge, "relation">,
  category: EdgeCategory,
  source: Pick<SceneNode, "island" | "targetKind"> | undefined,
  destination: Pick<ModelResource, "kind"> | undefined,
): ConnectionStyle {
  const { relation } = edge;
  // An authorizer guards its route.
  if (relation === "authorizes") return { color: GUARD_EDGE_COLOR, dashed: false };
  if (destination && REFERENCES.has(relation)) {
    const guarded = relation === "grant" || relation === "secret" || destination.kind === "secret";
    return { color: guarded ? GUARD_EDGE_COLOR : READ_EDGE_COLOR, dashed: true };
  }
  // An environment file supplying a secret is as guarded as the secret.
  if (relation === "supplies" && destination?.kind === "secret") return { color: GUARD_EDGE_COLOR, dashed: true };
  if (relation === "usesTool") return { color: TOOL_EDGE_COLOR, dashed: false };
  if (relation === "step") return { color: STEP_EDGE_COLOR, dashed: false };
  // Anything else takes the colour of where it starts, solid out of the APIs island and out of compute.
  if (source?.island === "island:apis") return { color: API_EDGE_COLOR, dashed: false };
  if (source?.targetKind && COMPUTE_TARGETS.has(source.targetKind)) return { color: COMPUTE_EDGE_COLOR, dashed: false };
  return { color: EDGE_COLORS[category], dashed: true };
}

/**
 * How strongly an idle connection is drawn (the selected, hovered and searched states have their own).
 *
 * What is part of the environment being viewed reads clearly; what is not recedes. A connection outside the
 * viewed environment rests at half the strength it has inside it, so switching the view dims what the new
 * view leaves out and brightens what it brings in, and every connection keeps the same ratio between the two.
 */
export const EDGE_ALPHA = { declared: 0.3, derived: 0.18, outOfLens: 0.5 } as const;

/** A node belongs to the environment being viewed when it is built or held there. */
const inLens = (node: Pick<SceneNode, "presence"> | undefined): boolean => !node || node.presence === "built" || node.presence === "present";

/**
 * Whether a connection is outside the environment being viewed: the other environment alone holds it, or
 * either end is enabled only there, in neither, or a catalog entry the viewed graph declares undefined.
 */
export function offLens(edge: { readonly otherLens?: Mode }, from: Pick<SceneNode, "presence"> | undefined, to: Pick<SceneNode, "presence"> | undefined): boolean {
  return edge.otherLens !== undefined || !inLens(from) || !inLens(to);
}

export function restingAlpha(provenance: ModelEdge["provenance"], outOfLens: boolean): number {
  return (provenance === "derived" ? EDGE_ALPHA.derived : EDGE_ALPHA.declared) * (outOfLens ? EDGE_ALPHA.outOfLens : 1);
}
