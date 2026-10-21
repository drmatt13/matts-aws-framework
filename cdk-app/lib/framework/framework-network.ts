import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct, IConstruct } from "constructs";
import {
  formatMonthlyCost,
  getConnectsToBindings,
  interfaceEndpointsMonthlyCost,
  isResourceAbsent,
  NETWORK_PRICES,
  NETWORK_SUBNET_LAYOUT,
  resolveLambdaTarget,
  resolveNetwork,
  usesDualStackEndpoints,
  type ConnectsToBinding,
  type ContainerSubnet,
  type FrameworkNetwork,
  type InterfaceEndpointService,
  type NetworkSubnet,
  type NormalizedTarget,
} from "@repo/framework/config";
import { deferResourceAttachment, frameworkResourceOptions } from "./framework-resources";

import { databaseConnectionTarget, type DatabaseEndpoint } from "./framework-database";
import { markInfrastructure } from "./framework-inventory";

/**
 * One declared VPC, built by a production deployment the first time a native
 * application resource or deployed workload selects it explicitly.
 *
 * A development deployment never builds it. The database is absent from the
 * dev graph and runs under Compose instead, where the local
 * lane enforces the same rules — which is why asking for the network in a dev
 * deployment is an error rather than a smaller network.
 *
 * Everything about its way out belongs to its VPC declaration: the
 * egress-only internet gateway, the NAT gateway, and the gateway and interface
 * endpoints. Subnets, the internet and egress-only gateways, security groups
 * and the gateway endpoints are free; the NAT gateway and interface endpoints
 * are what it costs.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly network: FrameworkNetwork;

  public constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { readonly network: FrameworkNetwork },
  ) {
    super(scope, id, props);
    const network = this.network = props.network;
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(network.cidr),
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      maxAzs: network.zones,
      // An IPv4 route out of the private subnets exists only when the network
      // declaration turns its NAT gateway on.
      natGateways: network.natGateway ? 1 : 0,
      subnetConfiguration: NETWORK_SUBNET_LAYOUT.map((layout) => ({
        name: layout.name,
        cidrMask: layout.cidrMask,
        subnetType: SUBNET_TYPE[layout.tier],
      })),
      // Keyed S3 and DynamoDB, as they always have been: the key is the
      // construct id, and so part of each endpoint's logical id.
      gatewayEndpoints: {
        ...(network.gatewayEndpoints.s3 ? { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } } : {}),
        ...(network.gatewayEndpoints.dynamodb ? { DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } } : {}),
      },
    });
    markInfrastructure(this, `island:vpc:${network.id}`, "supporting");
    markInfrastructure(this.vpc, `island:vpc:${network.id}`);

    // CDK gives a dual-stack VPC's private subnets an egress-only internet
    // gateway and an IPv6 default route to it, unasked. Without one, they keep
    // no IPv6 way out.
    if (!network.egressOnlyInternetGateway) {
      for (const subnet of this.vpc.privateSubnets) {
        if (!subnet.node.tryRemoveChild("DefaultRoute6")) {
          throw new Error(`The private subnet ${subnet.node.path} has no IPv6 default route to remove: CDK has changed how it builds the egress-only internet gateway.`);
        }
      }
      if (!this.vpc.node.tryRemoveChild("EIGW6")) {
        throw new Error("The VPC has no egress-only internet gateway to remove: CDK has changed how it builds one.");
      }
    }

    // One security group for every interface endpoint: HTTPS from anything in
    // the VPC. The endpoints are IPv4, which every subnet has.
    if (network.interfaceEndpoints.length > 0) {
      // Preserve the original security-group description as well as its logical ID.
      const group = new ec2.SecurityGroup(this, "InterfaceEndpoints", {
        vpc: this.vpc,
        description: "Interface endpoints declared in framework-config/network.ts",
        allowAllOutbound: false,
      });
      group.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), "HTTPS from the VPC");
      for (const name of network.interfaceEndpoints) {
        // Named for the service, so listing endpoints in another order
        // replaces none of them.
        this.vpc.addInterfaceEndpoint(endpointConstructId(name), {
          service: interfaceEndpointService(name),
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          privateDnsEnabled: true,
          securityGroups: [group],
          open: false,
        });
      }
    }
  }
}

/** "secretsmanager" → "SecretsmanagerEndpoint", "ecr.dkr" → "EcrDkrEndpoint". */
function endpointConstructId(name: string): string {
  return `${name.split(/[.-]/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")}Endpoint`;
}

let endpointServicesByName: ReadonlyMap<string, ec2.InterfaceVpcEndpointAwsService> | undefined;

/** CDK's description of an interface endpoint service, by its endpoint name. */
function interfaceEndpointService(name: InterfaceEndpointService): ec2.InterfaceVpcEndpointAwsService {
  if (!endpointServicesByName) {
    const byName = new Map<string, ec2.InterfaceVpcEndpointAwsService>();
    for (const key of Object.getOwnPropertyNames(ec2.InterfaceVpcEndpointAwsService)) {
      const value = (ec2.InterfaceVpcEndpointAwsService as unknown as Record<string, unknown>)[key];
      // A few services have two names in CDK (EVENTBRIDGE, CLOUDWATCH_EVENTS); either is the same endpoint.
      if (value instanceof ec2.InterfaceVpcEndpointAwsService && !byName.has(value.shortName)) byName.set(value.shortName, value);
    }
    endpointServicesByName = byName;
  }
  const service = endpointServicesByName.get(name);
  if (!service) {
    throw new Error(`aws-cdk-lib has no interface endpoint service "${name}". Run npm run framework:generate after changing aws-cdk-lib.`);
  }
  return service;
}

const SUBNET_TYPE = {
  public: ec2.SubnetType.PUBLIC,
  private: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  isolated: ec2.SubnetType.PRIVATE_ISOLATED,
} as const;

/** Subnets of one tier of the framework network. */
export function networkSubnets(tier: NetworkSubnet): ec2.SubnetSelection {
  return { subnetType: SUBNET_TYPE[tier] };
}

interface NetworkState {
  stack?: NetworkStack;
  /** The group the database admits, once a workload uses it. */
  databaseClients?: ec2.SecurityGroup;
  databaseProxyClients?: ec2.SecurityGroup;
  databaseReaderClients?: ec2.SecurityGroup;
  readonly admissions: Set<string>;
  /** The group every other Lambda in the network shares. */
  vpcLambdas?: ec2.SecurityGroup;
  /** Workloads placed in the network, for the synth summary. */
  readonly placed: string[];
}
const states = new WeakMap<IConstruct, Map<string, NetworkState>>();
function state(scope: IConstruct, reference: FrameworkNetwork): NetworkState {
  const options = frameworkResourceOptions(scope);
  if (!options) throw new Error("Initialize framework resources before asking for a VPC.");
  const network = resolveNetwork(options.config, reference);
  const root = scope.node.root;
  let registry = states.get(root);
  if (!registry) { registry = new Map(); states.set(root, registry); }
  let value = registry.get(network.id);
  if (!value) { value = { placed: [], admissions: new Set() }; registry.set(network.id, value); }
  return value;
}

function databaseNetwork(scope: IConstruct): FrameworkNetwork {
  const options = frameworkResourceOptions(scope);
  const reference = options?.config.database?.vpc;
  if (!options || !reference) throw new Error("Configure database: { resource, vpc } before requesting database placement.");
  return resolveNetwork(options.config, reference);
}

function networkStack(scope: IConstruct, reason: string, reference: FrameworkNetwork): NetworkStack {
  const network = state(scope, reference);
  const options = frameworkResourceOptions(scope);
  if (!options) {
    throw new Error("Initialize framework resources before asking for the framework network.");
  }
  if (options.mode === "dev") {
    throw new Error(
      `${reason}, but a dev deployment never builds the network. What lives in it runs under Compose in development: build it only in a production deployment (-c prodDeployment=true), and declare its catalog entry PROD_DEPLOYMENT ? resource.stack<...>() : undefined.`,
    );
  }
  const caller = cdk.Stack.of(scope);
  const existing = [...(states.get(scope.node.root)?.values() ?? [])].find((value) => value.stack)?.stack;
  const account = options.env?.account ?? existing?.account;
  const region = options.env?.region ?? existing?.region;
  if ((account !== undefined && caller.account !== account) || (region !== undefined && caller.region !== region)) {
    throw new Error(
      `${caller.node.path} selects VPC "${reference.id}" in ${caller.account}/${caller.region}, but deployment "${options.deployment}" uses ${account ?? caller.account}/${region ?? caller.region}. Keep application stacks on the deployment's shared stackEnv. Use a separate named deployment target for another account or region.`,
    );
  }
  if (network.stack) return network.stack;
  const env = cdk.Token.isUnresolved(caller.account) || cdk.Token.isUnresolved(caller.region)
    ? undefined
    : { account: caller.account, region: caller.region };
  network.stack = new NetworkStack(scope.node.root as Construct, `${options.deployment}-${reference.cloud.constructId}`, {
    ...(env ? { env } : {}),
    network: resolveNetwork(options.config, reference),
  });
  return network.stack;
}

/**
 * The framework network's VPC, for an application stack that builds something
 * inside it — a database in the isolated subnets, say. A native `ec2.IVpc`, so
 * everything else about the resource stays ordinary CDK:
 *
 * ```ts
 * new rds.DatabaseInstance(this, "Database", {
 *   vpc: frameworkVpc(this, importedVpc),
 *   vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
 * });
 * ```
 */
export function frameworkVpc(scope: IConstruct, reference: FrameworkNetwork): ec2.IVpc {
  return networkStack(scope, `${cdk.Stack.of(scope).node.path} asks for VPC "${reference?.id}"`, reference).vpc;
}

/**
 * The one security group every workload that uses the database joins, created
 * with the first of them. The database admits the group rather than each
 * workload, so the rule lives beside the database and points at the network
 * stack — never at a workload's stack, which already depends on the
 * database's for its IAM grant and would close a cycle.
 */
function databaseClientGroup(scope: IConstruct, kind: DatabaseEndpoint["kind"], origin: string, reference: FrameworkNetwork): ec2.SecurityGroup {
  const network = state(scope, reference);
  const field = kind === "proxy" ? "databaseProxyClients" : kind === "reader" ? "databaseReaderClients" : "databaseClients";
  if (network[field]) return network[field]!;
  const stack = networkStack(scope, `${origin} declares database access`, reference);
  const id = kind === "proxy" ? "DatabaseProxyClients" : kind === "reader" ? "DatabaseReaderClients" : "DatabaseClients";
  return network[field] = new ec2.SecurityGroup(stack, id, {
    vpc: stack.vpc, description: kind === "direct" ? "Workloads that declare database: true" : `Database ${kind} clients`,
    allowAllOutbound: true, allowAllIpv6Outbound: true,
  });
}

function databaseClientGroups(scope: IConstruct, binding: ConnectsToBinding, origin: string, reference: FrameworkNetwork): ec2.SecurityGroup[] {
  const target = databaseConnectionTarget(scope, binding);
  const writer = binding.connection === "direct" ? target.directWriter : target.applicationWriter;
  const endpoints = [writer, ...(binding.readers ? target.readers : [])];
  const groups = new Set<ec2.SecurityGroup>();
  for (const endpoint of endpoints) {
    const group = databaseClientGroup(scope, endpoint.kind, origin, reference);
    groups.add(group);
    const key = `${JSON.stringify(binding.resource.path)}:${endpoint.kind}:${endpoint.hostname}`;
    if (!state(scope, reference).admissions.has(key)) {
      state(scope, reference).admissions.add(key);
      deferResourceAttachment(scope, () => {
        if (endpoint.vpc !== networkStack(scope, origin, reference).vpc) throw new Error("The database is built in another VPC. Build it with vpc: frameworkVpc(this, selectedVpc).");
        endpoint.connections.allowFrom(group, endpoint.connections.defaultPort ?? ec2.Port.tcp(typeof endpoint.port === "number" ? endpoint.port : cdk.Token.asNumber(endpoint.port)), "database: true");
      });
    }
  }
  return [...groups];
}

/** The database a target uses, when this deployment builds it. */
export function presentConnections(target: NormalizedTarget): readonly ConnectsToBinding[] {
  return getConnectsToBindings(target.cloud.bindings).filter((binding) => !isResourceAbsent(binding.resource));
}

/**
 * Whether a Lambda runs inside the network in this deployment: when it uses a
 * database this deployment builds, or declares a subnet in a deployment that
 * builds the network at all.
 */
export function isPlacedInNetwork(scope: IConstruct, target: NormalizedTarget): boolean {
  if (target.kind !== "lambda") return false;
  if (presentConnections(target).length > 0) return true;
  const options = frameworkResourceOptions(scope);
  return options !== undefined && options.mode !== "dev" && resolveLambdaTarget(options.config, target.id).subnet !== "none";
}

/**
 * The subnet a Lambda placed in the network runs in: the one it declares, or
 * the private subnets for one whose database brought it in.
 */
function placedLambdaSubnet(scope: IConstruct, target: NormalizedTarget): "private" | "isolated" {
  const options = frameworkResourceOptions(scope);
  const subnet = options ? resolveLambdaTarget(options.config, target.id).subnet : "none";
  return subnet === "isolated" ? "isolated" : "private";
}

/**
 * `AWS_USE_DUALSTACK_ENDPOINT=true` for a function in the network's `subnet`
 * when IPv6 leaves it, as several AWS APIs answer IPv6 only on their
 * dual-stack hostnames; otherwise nothing, so the SDK calls the standard
 * hostnames the network's interface endpoints answer. Set in both lanes.
 */
export function dualStackEnvironment(scope: IConstruct, subnet: "private" | "isolated", reference: FrameworkNetwork): Record<string, string> {
  const options = frameworkResourceOptions(scope);
  const network = resolveNetwork(options?.config ?? {}, reference);
  return usesDualStackEndpoints(network, subnet) ? { AWS_USE_DUALSTACK_ENDPOINT: "true" } : {};
}

/** {@link dualStackEnvironment} for a Lambda, which is empty outside the network. */
export function lambdaNetworkEnvironment(scope: IConstruct, target: NormalizedTarget): Record<string, string> {
  return isPlacedInNetwork(scope, target) ? dualStackEnvironment(scope, placedLambdaSubnet(scope, target), target.vpc!) : {};
}

/**
 * The one security group a Lambda in the network that uses no database joins,
 * created with the first of them. Shared, so the functions share their network
 * interfaces too; it admits nobody, and lets them out over both families.
 */
function vpcLambdas(scope: IConstruct, origin: string, reference: FrameworkNetwork): ec2.SecurityGroup {
  const network = state(scope, reference);
  if (network.vpcLambdas) return network.vpcLambdas;
  const stack = networkStack(scope, `${origin} runs in the VPC`, reference);
  network.vpcLambdas = new ec2.SecurityGroup(stack, "VpcLambdas", {
    vpc: stack.vpc,
    description: "Lambdas in the VPC",
    allowAllOutbound: true,
    allowAllIpv6Outbound: true,
  });
  return network.vpcLambdas;
}

export interface LambdaPlacement {
  readonly vpc: ec2.IVpc;
  readonly vpcSubnets: ec2.SubnetSelection;
  readonly securityGroups: ec2.ISecurityGroup[];
  readonly ipv6AllowedForDualStack: true;
}

/**
 * A function that reaches the database: its subnet (private unless it declares
 * isolated), the database's clients group, and whatever leaves that subnet.
 */
export function databaseClientPlacement(
  scope: IConstruct,
  binding: ConnectsToBinding,
  origin: string,
  subnet: "private" | "isolated" = "private",
  reference: FrameworkNetwork = databaseNetwork(scope),
): LambdaPlacement {
  return {
    vpc: networkStack(scope, `${origin} declares database: true`, reference).vpc,
    vpcSubnets: networkSubnets(subnet),
    securityGroups: databaseClientGroups(scope, binding, origin, reference),
    ipv6AllowedForDualStack: true,
  };
}

/**
 * Where a Lambda runs: outside the VPC unless {@link isPlacedInNetwork}. Inside,
 * one that uses the database goes where {@link databaseClientPlacement} says,
 * and any other joins the shared group in the subnet it declares.
 */
export function lambdaPlacement(scope: IConstruct, target: NormalizedTarget): LambdaPlacement | undefined {
  if (!isPlacedInNetwork(scope, target)) return undefined;
  state(scope, target.vpc!).placed.push(target.reference);
  const origin = target.origins[0] ?? target.reference;
  const subnet = placedLambdaSubnet(scope, target);
  const [binding] = presentConnections(target);
  if (binding) return databaseClientPlacement(scope, binding, origin, subnet, target.vpc!);
  return {
    vpc: networkStack(scope, `${origin} has subnet: "${subnet}"`, target.vpc!).vpc,
    vpcSubnets: networkSubnets(subnet),
    securityGroups: [vpcLambdas(scope, origin, target.vpc!)],
    ipv6AllowedForDualStack: true,
  };
}

export interface ContainerPlacement {
  readonly vpc: ec2.IVpc;
  readonly subnets: ec2.SubnetSelection;
  readonly assignPublicIp: boolean;
  /** The database's clients group when it uses the database; its own group is the caller's. */
  readonly connectionGroups: ec2.ISecurityGroup[];
}

/** Where a container runs: the subnet it resolved to, plus its connections' groups. */
export function containerPlacement(scope: IConstruct, target: NormalizedTarget, subnet: ContainerSubnet): ContainerPlacement {
  const origin = target.origins[0] ?? target.reference;
  const placement: ContainerPlacement = {
    vpc: networkStack(scope, `${origin} is a container`, target.vpc!).vpc,
    subnets: networkSubnets(subnet),
    assignPublicIp: subnet === "public",
    connectionGroups: presentConnections(target).flatMap((binding) => databaseClientGroups(scope, binding, origin, target.vpc!)),
  };
  state(scope, target.vpc!).placed.push(target.reference);
  return placement;
}

/**
 * One line for the synth output: what was placed in the network, how its
 * private subnets leave, and what that costs. Undefined when this deployment
 * built no network.
 */
export function describeFrameworkNetwork(scope: IConstruct): string | undefined {
  return [...(states.get(scope.node.root)?.values() ?? [])].map(describeNetwork).filter(Boolean).join("\n") || undefined;
}

function describeNetwork(built: NetworkState): string | undefined {
  if (!built.stack) return undefined;
  const { network } = built.stack;
  const placed = built.placed.length > 0 ? built.placed.join(", ") : "nothing yet";
  const egress = network.natGateway && network.egressOnlyInternetGateway
    ? "The private subnets leave over IPv6 and IPv4"
    : network.natGateway
      ? "The private subnets leave over IPv4 only"
      : network.egressOnlyInternetGateway
        ? "The private subnets leave over IPv6 only"
        : "The private subnets have no way out";
  const gateways = [network.gatewayEndpoints.s3 ? "S3" : undefined, network.gatewayEndpoints.dynamodb ? "DynamoDB" : undefined].filter(Boolean);
  const endpoints = [
    ...(gateways.length > 0 ? [`gateway endpoints for ${gateways.join(" and ")}`] : []),
    ...(network.interfaceEndpoints.length > 0 ? [`interface endpoints for ${network.interfaceEndpoints.join(", ")}`] : []),
  ];
  const costs = [
    ...(network.natGateway ? [`one NAT gateway, about ${formatMonthlyCost(NETWORK_PRICES.natGatewayMonthly)} a month plus $0.045 per GB`] : []),
    ...(network.interfaceEndpoints.length > 0
      ? [`${network.interfaceEndpoints.length} interface endpoint${network.interfaceEndpoints.length === 1 ? "" : "s"} in ${network.zones} zones, about ${formatMonthlyCost(interfaceEndpointsMonthlyCost(network, network.interfaceEndpoints.length))} a month plus $0.01 per GB`]
      : []),
  ];
  return `Network ${network.id}: ${placed} run in the VPC. ${egress}${endpoints.length > 0 ? `, with ${endpoints.join(" and ")}` : ""}. ${costs.length > 0 ? `It costs ${costs.join(", and ")}, as the selected VPC declaration specifies.` : "It costs nothing."}`;
}
