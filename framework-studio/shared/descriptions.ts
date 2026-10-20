import type { ModeModel, ModelEdge, NetworkModel } from "./model";

export const DESCRIPTION_FILE = "framework-config/descriptions.ts";
export const DESCRIPTION_LIMIT = 8000;
export const ISLAND_IDS = ["island:apis", "island:lambda", "island:vpc", "island:agentcore", "island:orchestration", "island:stacks", "island:inputs", "island:environment", "island:client-environment"] as const;

export function networkFixtureIds(network: NetworkModel | undefined): string[] {
  return ["prop:internet-gateway", ...(network?.egressOnlyInternetGateway ? ["prop:egress-only-gateway"] : []),
    ...(network?.natGateway ? ["prop:nat-gateway"] : []),
    ...new Set([...(network?.gatewayEndpoints ?? []), ...(network?.interfaceEndpoints ?? [])].map((name) => `prop:endpoint:${name}`))];
}

/** Keep notes on the same relationship when graph ordering or environment details change.
 * Identical relationships share notes; differently named mappings between a pair do not. */
export function connectionDescriptionId(edge: ModelEdge): string {
  return `connection-description:${JSON.stringify([edge.relation, edge.from, edge.to, edge.label, edge.attachment ?? null])}`;
}

/** Uses canonical model identities, including public stack fields and individual relationships. */
export function descriptionEntityIds(models: readonly ModeModel[]): ReadonlySet<string> {
  return new Set([...ISLAND_IDS, ...models.flatMap((model) => [
    ...model.targets.map((target) => target.ref), ...model.routes.map((route) => route.id),
    ...model.resources.map((resource) => resource.id), ...(model.localServices ?? []).map((service) => service.id),
    ...model.edges.map(connectionDescriptionId),
    ...networkFixtureIds(model.network),
  ])]);
}

export function descriptionError(value: string): string | undefined {
  return value.length > DESCRIPTION_LIMIT ? `Use at most ${DESCRIPTION_LIMIT} characters.`
    : value.includes("\0") ? "Descriptions cannot contain null characters." : undefined;
}
