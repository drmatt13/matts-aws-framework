import { validateTags, type DeclarationTags } from "./tags";
/** Independently declared VPCs. Configuration, CDK and local egress share these rules. */
import { INTERFACE_ENDPOINT_SERVICES } from "../generated/vpc-endpoint-services";

export { INTERFACE_ENDPOINT_SERVICES };

export const NETWORK_BRAND = "@repo/framework/network" as const;

/**
 * An AWS service an interface endpoint reaches, by the name AWS gives its
 * endpoint (com.amazonaws.<region>.<name>): "secretsmanager", "ecr.api",
 * "logs", "states" and every other service the deploying CDK knows.
 */
export type InterfaceEndpointService = (typeof INTERFACE_ENDPOINT_SERVICES)[number];

/** A service reachable through an endpoint: a gateway endpoint's or an interface endpoint's. */
export type EndpointService = InterfaceEndpointService | "s3" | "dynamodb";

/** The two gateway endpoints, which cost nothing. */
export interface GatewayEndpoints {
  /** S3 on every route table. Defaults to true. */
  readonly s3?: boolean;
  /** DynamoDB on every route table. Defaults to true. */
  readonly dynamodb?: boolean;
}

/** What `defineNetwork` takes. */
export interface NetworkDeclaration {
  readonly tags?: DeclarationTags;
  /** Stable identity, independent of the CIDR or registration order. */
  readonly id: string;
  /** Human-readable label. Changing it does not rename deployed constructs. */
  readonly name?: string;
  /** Deployed stack identity. Retain this when moving or renaming source. */
  readonly cloud?: { readonly constructId?: string };
  /**
   * The VPC's IPv4 range: a private /16 such as "10.0.0.0/16". The IPv6 range
   * is Amazon-provided and never written. Set once.
   */
  readonly cidr: string;
  /** Availability zones the subnets span. RDS needs at least two. Set once. */
  readonly zones: 2 | 3;
  /**
   * IPv6 out of the private subnets, through an egress-only internet gateway,
   * which AWS does not charge for. A Lambda in them then calls AWS's
   * dual-stack endpoints, so it reaches Secrets Manager, Cognito and most AWS
   * APIs without a NAT gateway. Nothing can connect in through it. Defaults
   * to true.
   */
  readonly egressOnlyInternetGateway?: boolean;
  /**
   * IPv4 out of the private subnets, through one NAT gateway: about $33 a
   * month plus $0.045 per GB. A private container needs it (or the interface
   * endpoints Fargate starts through), and with it a private Lambda reaches
   * IPv4-only hosts too. Defaults to false.
   */
  readonly natGateway?: boolean;
  /**
   * S3 and DynamoDB on every route table, free: their traffic never leaves
   * the VPC, and reaches them from any subnet, isolated included.
   */
  readonly gatewayEndpoints?: GatewayEndpoints;
  /**
   * PrivateLink endpoints, one per AWS service listed: about $7.30 a month
   * per zone each, plus $0.01 per GB. They reach that service privately from
   * every subnet, over IPv4, with no gateway at all — an alternative to the
   * NAT gateway for a container in a private subnet ("ecr.api", "ecr.dkr" and
   * "logs" are what Fargate starts through), and the only way out of the
   * isolated subnets.
   */
  readonly interfaceEndpoints?: readonly InterfaceEndpointService[];
}

/** A validated network declaration, with every default folded in. */
export interface FrameworkNetwork {
  readonly tags?: DeclarationTags;
  readonly $network: typeof NETWORK_BRAND;
  readonly id: string;
  readonly name: string;
  readonly cloud: { readonly constructId: string };
  readonly cidr: string;
  readonly zones: 2 | 3;
  readonly egressOnlyInternetGateway: boolean;
  readonly natGateway: boolean;
  readonly gatewayEndpoints: { readonly s3: boolean; readonly dynamodb: boolean };
  readonly interfaceEndpoints: readonly InterfaceEndpointService[];
}

/** The subnet tiers, as the fixed layout builds them in every zone. */
export const NETWORK_SUBNETS = ["public", "private", "isolated"] as const;
export type NetworkSubnet = (typeof NETWORK_SUBNETS)[number];

/**
 * Where a Lambda runs. "none": outside the VPC, with the whole internet.
 * "private": the private subnets, leaving as the selected VPC allows. "isolated":
 * the isolated subnets, which reach only the database and the network's
 * endpoints. Never "public": AWS gives a Lambda in a VPC no public IPv4
 * address, so a public subnet would only lose the NAT gateway.
 */
export const LAMBDA_SUBNETS = ["none", "private", "isolated"] as const;
export type LambdaSubnet = (typeof LAMBDA_SUBNETS)[number];

/**
 * Where a container runs. Fargate always runs in the VPC, so a container has
 * no "none". "public": a public subnet and a public IPv4 address per running
 * task (about $3.65 a month while it runs), no inbound rules. "private": a
 * private subnet, starting through the NAT gateway or the interface endpoints.
 */
export const CONTAINER_SUBNETS = ["public", "private"] as const;
export type ContainerSubnet = (typeof CONTAINER_SUBNETS)[number];

/**
 * The fixed per-zone layout, in the order addresses are allocated. Appending a
 * tier keeps every existing subnet's range; inserting or removing one does not,
 * which is why the public tier is always present even when nothing uses it.
 */
export const NETWORK_SUBNET_LAYOUT = [
  { name: "public", tier: "public", cidrMask: 24 },
  { name: "private", tier: "private", cidrMask: 20 },
  { name: "isolated", tier: "isolated", cidrMask: 24 },
] as const;

/** Approximate us-east-1 prices, quoted by the messages that name a cost. */
export const NETWORK_PRICES = {
  natGatewayMonthly: 32.85,
  interfaceEndpointMonthlyPerZone: 7.3,
  publicIpv4Monthly: 3.65,
} as const;

/** "$43.80". */
export function formatMonthlyCost(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** What `count` interface endpoints cost a month in this network. */
export function interfaceEndpointsMonthlyCost(network: FrameworkNetwork, count: number): number {
  return count * network.zones * NETWORK_PRICES.interfaceEndpointMonthlyPerZone;
}

const PRIVATE_SLASH_16 = /^(10\.(\d{1,3})|172\.(1[6-9]|2\d|3[01])|192\.168)\.0\.0\/16$/;
const DECLARATION_KEYS = [
  "id", "name", "cloud", "cidr", "zones", "egressOnlyInternetGateway", "natGateway", "gatewayEndpoints", "interfaceEndpoints", "tags",
] as const;
const KNOWN_INTERFACE_ENDPOINTS: ReadonlySet<string> = new Set(INTERFACE_ENDPOINT_SERVICES);

/**
 * Declares an independently selected VPC.
 *
 * ```ts
 * export const applicationVpc = defineNetwork({
 *   id: "application",
 *   cidr: "10.0.0.0/16",
 *   zones: 2,
 *   egressOnlyInternetGateway: true,
 *   natGateway: false,
 *   gatewayEndpoints: { s3: true, dynamodb: true },
 *   interfaceEndpoints: [],
 * });
 * ```
 */
export function defineNetwork(declaration: NetworkDeclaration): FrameworkNetwork {
  if (["region", "regions", "allowedRegions"].some(key => key in declaration)) throw new Error("Region belongs to framework:targets.<name>.region in cdk-app/cdk.json; all VPCs inherit the deployment region. Use separate deployment targets for separate regions.");
  if ("nat" in declaration) {
    throw new Error("defineNetwork() takes natGateway: true or false. nat was its earlier name.");
  }
  for (const key of Object.keys(declaration)) {
    if (!(DECLARATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`defineNetwork() does not take ${JSON.stringify(key)}. It takes ${DECLARATION_KEYS.join(", ")}.`);
    }
  }
  const {
    id, name = id, cloud = {}, cidr, zones, egressOnlyInternetGateway = true, natGateway = false, gatewayEndpoints = {}, interfaceEndpoints = [],
  } = declaration;
  if (typeof id !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new Error('defineNetwork() requires a stable kebab-case id, such as "application".');
  if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("A VPC name must contain 1–100 printable characters. Its stable id and cloud.constructId remain unchanged.");
  if (!cloud || typeof cloud !== "object" || Object.keys(cloud).some(key => key !== "constructId")) throw new Error("A network's cloud settings take only constructId.");
  const constructId = cloud.constructId ?? `${id.split("-").map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}NetworkStack`;
  if (typeof constructId !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(constructId)) throw new Error("A network cloud.constructId must be a stable alphanumeric stack identity.");
  const match = typeof cidr === "string" ? PRIVATE_SLASH_16.exec(cidr) : null;
  if (!match || (match[2] !== undefined && Number(match[2]) > 255)) {
    throw new Error(
      `defineNetwork() takes a private /16 for cidr, such as "10.0.0.0/16". Received ${JSON.stringify(cidr)}.`,
    );
  }
  if (zones !== 2 && zones !== 3) {
    throw new Error(
      `defineNetwork() spans 2 or 3 zones; RDS needs at least two. Received ${JSON.stringify(zones)}.`,
    );
  }
  for (const [name, value] of [["egressOnlyInternetGateway", egressOnlyInternetGateway], ["natGateway", natGateway]] as const) {
    if (typeof value !== "boolean") {
      throw new Error(`defineNetwork() takes true or false for ${name}. Received ${JSON.stringify(value)}.`);
    }
  }
  if (typeof gatewayEndpoints !== "object" || gatewayEndpoints === null || Array.isArray(gatewayEndpoints)) {
    throw new Error(`defineNetwork() takes gatewayEndpoints as { s3: true, dynamodb: true }. Received ${JSON.stringify(gatewayEndpoints)}.`);
  }
  for (const [name, value] of Object.entries(gatewayEndpoints)) {
    if (name !== "s3" && name !== "dynamodb") {
      throw new Error(`gatewayEndpoints has no ${JSON.stringify(name)}: AWS offers gateway endpoints for s3 and dynamodb only. Other services go in interfaceEndpoints.`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`gatewayEndpoints.${name} is true or false. Received ${JSON.stringify(value)}.`);
    }
  }
  if (!Array.isArray(interfaceEndpoints)) {
    throw new Error(`defineNetwork() takes interfaceEndpoints as a list of service names, such as ["secretsmanager"]. Received ${JSON.stringify(interfaceEndpoints)}.`);
  }
  const seen = new Set<string>();
  for (const service of interfaceEndpoints as readonly unknown[]) {
    if (service === "s3" || service === "dynamodb") {
      throw new Error(`interfaceEndpoints lists "${service}". The network reaches ${service} through its gateway endpoint, which is free: use gatewayEndpoints: { ${service}: true }.`);
    }
    if (typeof service !== "string" || !KNOWN_INTERFACE_ENDPOINTS.has(service)) {
      const suggestion = typeof service === "string" ? closestEndpointService(service) : undefined;
      throw new Error(
        `interfaceEndpoints lists ${JSON.stringify(service)}, which is not an AWS interface endpoint service.${suggestion ? ` Did you mean "${suggestion}"?` : ""} Names are the last part of com.amazonaws.<region>.<name>, such as "secretsmanager" or "ecr.api".`,
      );
    }
    if (seen.has(service)) throw new Error(`interfaceEndpoints lists "${service}" twice.`);
    seen.add(service);
  }
  return Object.freeze({
    $network: NETWORK_BRAND,
    tags: validateTags(declaration.tags, `Network "${id}"`),
    id,
    name: name.trim(),
    cloud: Object.freeze({ constructId }),
    cidr,
    zones,
    egressOnlyInternetGateway,
    natGateway,
    gatewayEndpoints: Object.freeze({ s3: gatewayEndpoints.s3 ?? true, dynamodb: gatewayEndpoints.dynamodb ?? true }),
    interfaceEndpoints: Object.freeze([...interfaceEndpoints]),
  });
}

export function isFrameworkNetwork(value: unknown): value is FrameworkNetwork {
  return typeof value === "object" && value !== null && (value as FrameworkNetwork).$network === NETWORK_BRAND;
}

/** The registry is explicit; there is no implicit/default VPC. */
export function networkRegistry(config: { readonly networks?: readonly FrameworkNetwork[] }): ReadonlyMap<string, FrameworkNetwork> {
  if (config.networks !== undefined && !Array.isArray(config.networks)) throw new Error("networks must be an array of imported defineNetwork declarations.");
  const byId = new Map<string, FrameworkNetwork>();
  const constructs = new Set<string>();
  for (const network of config.networks ?? []) {
    if (!isFrameworkNetwork(network)) throw new Error("networks takes imported defineNetwork declarations.");
    if (byId.has(network.id)) throw new Error(`networks declares duplicate VPC id "${network.id}".`);
    if (constructs.has(network.cloud.constructId)) throw new Error(`networks declares duplicate cloud.constructId "${network.cloud.constructId}".`);
    byId.set(network.id, network); constructs.add(network.cloud.constructId);
  }
  return byId;
}

export function resolveNetwork(config: { readonly networks?: readonly FrameworkNetwork[] }, reference: FrameworkNetwork | undefined): FrameworkNetwork {
  if (!isFrameworkNetwork(reference)) throw new Error("VPC placement requires an explicit imported vpc reference from defineNetwork().");
  const network = networkRegistry(config).get(reference.id);
  if (!network || network.cloud.constructId !== reference.cloud?.constructId) throw new Error(`VPC "${reference.id}" is not the declaration registered in networks.`);
  return network;
}

/** Legacy scopes belong to the preserved construct identity, never the first VPC in an array. */
export function networkConstructId(network: FrameworkNetwork, legacy: string): string {
  return network.cloud.constructId === "NetworkStack" ? legacy : `${network.cloud.constructId}-${legacy}`;
}

/** What leaves a subnet for the internet. Endpoints are separate: see {@link hasEndpoint}. */
export interface SubnetEgress {
  readonly ipv4: boolean;
  readonly ipv6: boolean;
}

/**
 * What leaves a subnet. A public subnet routes both families to the internet
 * gateway, which reaches only what has a public address — a container with its
 * public IPv4. A private subnet leaves as the selected VPC allows, and an isolated one
 * not at all.
 */
export function subnetEgress(network: FrameworkNetwork, subnet: NetworkSubnet): SubnetEgress {
  switch (subnet) {
    case "public":
      return { ipv4: true, ipv6: true };
    case "private":
      return { ipv4: network.natGateway, ipv6: network.egressOnlyInternetGateway };
    case "isolated":
      return { ipv4: false, ipv6: false };
  }
}

/**
 * Whether a Lambda here calls AWS's dual-stack endpoints
 * (`AWS_USE_DUALSTACK_ENDPOINT=true`): only where IPv6 leaves. The interface
 * endpoints are IPv4 and answer only a service's standard name, so a Lambda
 * whose subnet has no IPv6 way out calls that name instead.
 */
export function usesDualStackEndpoints(network: FrameworkNetwork, subnet: LambdaSubnet): boolean {
  return subnet !== "none" && subnetEgress(network, subnet).ipv6;
}

/** Every service the network reaches through an endpoint. */
export function endpointServices(network: FrameworkNetwork): readonly EndpointService[] {
  return [
    ...(network.gatewayEndpoints.s3 ? ["s3" as const] : []),
    ...(network.gatewayEndpoints.dynamodb ? ["dynamodb" as const] : []),
    ...network.interfaceEndpoints,
  ];
}

/** Whether the network reaches a service through an endpoint. */
export function hasEndpoint(network: FrameworkNetwork, service: EndpointService): boolean {
  return endpointServices(network).includes(service);
}

const REGIONAL_HOST = /^(.+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.(?:amazonaws\.com|api\.aws)$/;

/**
 * The endpoint service a regional AWS hostname belongs to, or undefined:
 * "secretsmanager" for secretsmanager.eu-west-2.amazonaws.com, "ecr.api" for
 * api.ecr.…, "ecr.dkr" for <account>.dkr.ecr.…, "s3" for <bucket>.s3.… and
 * s3.dualstack.…. Labels match in either order, because some services spell
 * their hostname backwards from their endpoint name, and the longest match wins.
 */
export function endpointServiceForHost(hostname: string): EndpointService | undefined {
  const match = REGIONAL_HOST.exec(hostname.toLowerCase().replace(/\.$/, ""));
  if (!match) return undefined;
  const labels = match[1]!.split(".").filter((label) => label !== "dualstack");
  for (let length = labels.length; length > 0; length -= 1) {
    for (let start = 0; start + length <= labels.length; start += 1) {
      const window = labels.slice(start, start + length);
      for (const candidate of [window.join("."), [...window].reverse().join(".")]) {
        if (candidate === "s3" || candidate === "dynamodb" || KNOWN_INTERFACE_ENDPOINTS.has(candidate)) {
          return candidate as EndpointService;
        }
      }
    }
  }
  return undefined;
}

function closestEndpointService(name: string): string | undefined {
  const wanted = name.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const candidate of INTERFACE_ENDPOINT_SERVICES) {
    const distance = editDistance(wanted, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  const contained = INTERFACE_ENDPOINT_SERVICES.find((candidate) => candidate.replace(/[.-]/g, "") === wanted.replace(/[.\-_ ]/g, ""));
  if (contained) return contained;
  return best && best.distance <= Math.max(2, Math.floor(wanted.length / 4)) ? best.name : undefined;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}
