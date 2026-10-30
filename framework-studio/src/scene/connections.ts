import type { Mode, ModelEdge, ModelResource, TargetKind } from "../../shared/model";
import { API_EDGE_COLOR, COMPUTE_EDGE_COLOR, EDGE_COLORS, GUARD_EDGE_COLOR, ICON_TINT, READ_EDGE_COLOR } from "./look";
import type { SceneEdge, SceneNode } from "./types";
import { isEventConnection, type EdgeCategory } from "../lookup";

/**
 * How a connection is coloured and dashed. Direction follows the model: reads point toward their
 * referenced input; conditional deployment points from the controlling input toward its workload.
 *
 * Resource interactions and event delivery are always solid and use the visible source icon's colour.
 * Conditional deployment connections use the same dashed style as supplied inputs.
 *
 * For input delivery, a value being read takes the look of an environment file supplying an input,
 * while a secret is red. Different relationship types retain separate wires and styles.
 */
export interface ConnectionStyle {
  readonly color: string;
  readonly dashed: boolean;
}

/** Category filters hide background wires; inspecting a resource always reveals its links. */
export function connectionVisible(edge: Pick<SceneEdge, "id" | "categories" | "from" | "to">, categories?: ReadonlySet<EdgeCategory>, selected?: string): boolean {
  return edge.id === selected || edge.from === selected || edge.to === selected || !categories || edge.categories.some((category) => categories.has(category));
}

/** Lambda functions and container services and tasks: the workloads AWS colours as compute. */
const COMPUTE_TARGETS: ReadonlySet<TargetKind> = new Set(["lambda", "service", "task"]);

/**
 * `source` is the visible resource the wire leaves, including folded stack members.
 * `destination` retains the actual referenced resource for non-interaction input styling.
 */
export function connectionStyle(
  edge: Pick<ModelEdge, "relation" | "permissionContext">,
  category: EdgeCategory,
  source: Pick<SceneNode, "icon" | "island" | "targetKind"> | undefined,
  destination: Pick<ModelResource, "kind"> | undefined,
): ConnectionStyle {
  const { relation } = edge;
  if (category === "interactions" || isEventConnection(edge)) return { color: ICON_TINT[source?.icon ?? "construct"], dashed: false };
  if (relation === "deployWhen") return { color: READ_EDGE_COLOR, dashed: true };
  if (relation === "maps") return { color: READ_EDGE_COLOR, dashed: true };
  // An authorizer guards its route.
  if (relation === "authorizes") return { color: GUARD_EDGE_COLOR, dashed: false };
  if (destination && (relation === "env" || relation === "secret")) {
    const guarded = relation === "secret" || destination.kind === "secret";
    return { color: guarded ? GUARD_EDGE_COLOR : READ_EDGE_COLOR, dashed: true };
  }
  // An environment file supplying a secret is as guarded as the secret.
  if (relation === "supplies" && destination?.kind === "secret") return { color: GUARD_EDGE_COLOR, dashed: true };
  // Anything else takes the colour of where it starts, solid out of the APIs island and out of compute.
  if (relation === "routes" || source?.island === "island:apis") return { color: API_EDGE_COLOR, dashed: false };
  if (source?.targetKind && COMPUTE_TARGETS.has(source.targetKind)) return { color: COMPUTE_EDGE_COLOR, dashed: false };
  return { color: EDGE_COLORS[category], dashed: true };
}

/**
 * How strongly an idle connection is drawn (the selected, hovered and searched states have their own).
 *
 * What is part of the environment being viewed reads clearly; what is not recedes. A connection outside the
 * viewed environment rests at a quarter of the strength it has inside it, so switching the view dims what the new
 * view leaves out and brightens what it brings in, and every connection keeps the same ratio between the two.
 */
export const EDGE_ALPHA = { declared: 0.3, derived: 0.18, outOfLens: 0.25 } as const;

/** Hover responds faster than captions; environment and selection changes stay immediate. */
export const EDGE_HOVER_DURATION = 0.05;

/** cubic-bezier(0.16, 1, 0.3, 1): immediate response, then a soft finish without overshoot. */
export function connectionHoverEase(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  // Time is the curve's x coordinate, so solve x(t) before evaluating y(t).
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const t = (low + high) / 2, inverse = 1 - t;
    const x = 3 * inverse * inverse * t * 0.16 + 3 * inverse * t * t * 0.3 + t * t * t;
    if (x < progress) low = t;
    else high = t;
  }
  return 1 - Math.pow(1 - (low + high) / 2, 3);
}

/** A node belongs to the environment being viewed when it is built or held there. */
const inLens = (node: Pick<SceneNode, "presence" | "tagFiltered"> | undefined): boolean => !node || !node.tagFiltered && (node.presence === "built" || node.presence === "present");

/**
 * Whether a connection is outside the environment being viewed: the other environment alone holds it, or
 * either end is enabled only there, in neither, or a catalog entry the viewed graph declares undefined.
 */
export function offLens(edge: { readonly otherLens?: Mode; readonly enabledInLens?: boolean }, from: Pick<SceneNode, "presence" | "tagFiltered"> | undefined, to: Pick<SceneNode, "presence" | "tagFiltered"> | undefined): boolean {
  return edge.enabledInLens === false || edge.otherLens !== undefined || !inLens(from) || !inLens(to);
}

export function restingAlpha(provenance: ModelEdge["provenance"], outOfLens: boolean): number {
  return (provenance === "derived" ? EDGE_ALPHA.derived : EDGE_ALPHA.declared) * (outOfLens ? EDGE_ALPHA.outOfLens : 1);
}
