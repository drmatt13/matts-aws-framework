import { networkCidrIdentity, networkCreationProblem, readCreationRequest, type CreationRequest } from "./creation";
import type { NetworkModel } from "./model";

export type NetworkSettings = Omit<Extract<CreationRequest, { kind: "vpc" }>, "kind" | "id" | "description" | "name" | "tags"> & { readonly name?: string };
export { networkCreationProblem };
/** Prefer consecutive 10/8 ranges, then the remaining private /16 blocks. */
export function unusedNetworkCidr(networks: readonly { readonly cidr: string }[]): string | undefined {
  const used = new Set(networks.map(network => networkCidrIdentity(network.cidr)));
  const candidates = [
    ...Array.from({ length: 256 }, (_, octet) => `10.${octet}.0.0/16`),
    ...Array.from({ length: 16 }, (_, octet) => `172.${octet + 16}.0.0/16`),
    "192.168.0.0/16",
  ];
  return candidates.find(cidr => !used.has(networkCidrIdentity(cidr)));
}
export interface PlacementEdit {
  readonly target: string;
  readonly vpc: string | null;
  readonly subnet: "none" | "public" | "private" | "isolated";
}
export const networkSettings = (network: NetworkModel): NetworkSettings => ({
  name: network.name ?? network.id, cidr: network.cidr, zones: network.zones as 2 | 3,
  nat: network.natGateway, ipv6: network.egressOnlyInternetGateway,
  s3: network.gatewayEndpoints.includes("s3"), dynamodb: network.gatewayEndpoints.includes("dynamodb"),
  endpoints: network.interfaceEndpoints,
});

export type NetworkDraft = ({ readonly kind: "placement" } & PlacementEdit) | { readonly kind: "network"; readonly network: string; readonly settings: NetworkSettings };

/** Decode only network identities and settings; never accept paths or source expressions. */
export function readNetworkDraft(raw: unknown): NetworkDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose VPC placement or VPC settings.");
  const item = raw as Record<string, unknown>;
  const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
  if (item.kind === "placement") {
    if (Object.keys(item).some(key => !["kind", "target", "vpc", "subnet"].includes(key)) || typeof item.target !== "string" || !/^(lambda|service|task):[a-z][a-z0-9-]*$/.test(item.target) || !(item.vpc === null || id(item.vpc)) || !["none", "public", "private", "isolated"].includes(String(item.subnet))) throw new Error("Placement requires a workload identity, a VPC identity (or null), and a supported subnet.");
    return { kind: "placement", target: item.target, vpc: item.vpc, subnet: item.subnet as PlacementEdit["subnet"] };
  }
  if (item.kind === "network" && id(item.network) && item.settings && typeof item.settings === "object" && !Array.isArray(item.settings)) {
    if (Object.keys(item).some(key => !["kind", "network", "settings"].includes(key)) || Object.keys(item.settings).some(key => !["name", "cidr", "zones", "nat", "ipv6", "s3", "dynamodb", "endpoints"].includes(key))) throw new Error("VPC settings cannot change identities or supply source expressions.");
    const request = readCreationRequest({ kind: "vpc", id: item.network, description: "", ...item.settings });
    if (request.kind !== "vpc") throw new Error("Invalid VPC settings.");
    const { name, cidr, zones, nat, ipv6, s3, dynamodb, endpoints } = request;
    return { kind: "network", network: item.network, settings: { ...("name" in item.settings ? { name } : {}), cidr, zones, nat, ipv6, s3, dynamodb, endpoints } };
  }
  throw new Error("Choose VPC placement or VPC settings.");
}
