import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct, IConstruct } from "constructs";
import {
  defineNetwork,
  getConnectsToBindings,
  isResourceAbsent,
  NETWORK_SUBNET_LAYOUT,
  resolveLambdaTarget,
  type ConnectsToBinding,
  type ContainerSubnet,
  type FrameworkNetwork,
  type NormalizedTarget,
} from "@repo/framework/config";
import { deferResourceAttachment, frameworkResourceOptions, linkedConstruct } from "./framework-resources";

/**
 * The application's network, built by a production deployment the first time
 * something needs it: an application stack calling `frameworkVpc(this)`, a
 * Lambda with `vpc: true`, a workload declaring `database: true`, or a
 * container.
 *
 * A development deployment never builds it. The database is absent from the
 * dev graph and runs under Compose instead, where the local
 * lane enforces the same rules — which is why asking for the network in a dev
 * deployment is an error rather than a smaller network.
 *
 * Costs nothing unless framework-config/network.ts turns on its NAT gateway:
 * subnets, the internet and egress-only gateways, security groups and the S3
 * and DynamoDB gateway endpoints are all free.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly nat: boolean;

  public constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { readonly network: FrameworkNetwork },
  ) {
    super(scope, id, props);
    this.nat = props.network.nat;
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.network.cidr),
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      maxAzs: props.network.zones,
      // Private subnets route IPv6 to the egress-only gateway either way. A NAT
      // gateway, and with it an IPv4 route out, exists only when the network
      // declaration turns it on; the config check refuses a private container
      // without one.
      natGateways: this.nat ? 1 : 0,
      subnetConfiguration: NETWORK_SUBNET_LAYOUT.map((layout) => ({
        name: layout.name,
        cidrMask: layout.cidrMask,
        subnetType: SUBNET_TYPE[layout.tier],
      })),
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });
  }
}

const SUBNET_TYPE = {
  public: ec2.SubnetType.PUBLIC,
  private: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  isolated: ec2.SubnetType.PRIVATE_ISOLATED,
} as const;

/** Subnets of one tier of the framework network. */
export function networkSubnets(tier: ContainerSubnet | "isolated"): ec2.SubnetSelection {
  return { subnetType: SUBNET_TYPE[tier] };
}

interface NetworkState {
  stack?: NetworkStack;
  /** The group the database admits, once a workload uses it. */
  databaseClients?: ec2.SecurityGroup;
  /** The group every other Lambda in the network shares. */
  vpcLambdas?: ec2.SecurityGroup;
  /** Workloads placed in the network, for the synth summary. */
  readonly placed: string[];
}
const states = new WeakMap<IConstruct, NetworkState>();
function state(scope: IConstruct): NetworkState {
  const root = scope.node.root;
  let value = states.get(root);
  if (!value) {
    value = { placed: [] };
    states.set(root, value);
  }
  return value;
}

function networkStack(scope: IConstruct, reason: string): NetworkStack {
  const network = state(scope);
  if (network.stack) return network.stack;
  const options = frameworkResourceOptions(scope);
  if (!options) {
    throw new Error("Initialize framework resources before asking for the framework network.");
  }
  if (options.mode === "dev") {
    throw new Error(
      `${reason}, but a dev deployment (PROD_DEPLOYMENT=false) never builds the network. What lives in it runs under Compose in development: build it only when PROD_DEPLOYMENT=true, and declare its catalog entry PROD_DEPLOYMENT ? resource.stack<...>() : undefined.`,
    );
  }
  const caller = cdk.Stack.of(scope);
  const env = cdk.Token.isUnresolved(caller.account) || cdk.Token.isUnresolved(caller.region)
    ? undefined
    : { account: caller.account, region: caller.region };
  network.stack = new NetworkStack(scope.node.root as Construct, `${options.deployment}-NetworkStack`, {
    ...(env ? { env } : {}),
    network: options.config.network ?? defineNetwork({ cidr: "10.0.0.0/16", zones: 2 }),
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
 *   vpc: frameworkVpc(this),
 *   vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
 * });
 * ```
 */
export function frameworkVpc(scope: IConstruct): ec2.IVpc {
  return networkStack(scope, `${cdk.Stack.of(scope).node.path} asks for the framework network`).vpc;
}

/**
 * The one security group every workload that uses the database joins, created
 * with the first of them. The database admits the group rather than each
 * workload, so the rule lives beside the database and points at the network
 * stack — never at a workload's stack, which already depends on the
 * database's for its IAM grant and would close a cycle.
 */
function databaseClients(scope: IConstruct, binding: ConnectsToBinding, origin: string): ec2.SecurityGroup {
  const network = state(scope);
  if (network.databaseClients) return network.databaseClients;
  const stack = networkStack(scope, `${origin} declares database: true`);
  const group = new ec2.SecurityGroup(stack, "DatabaseClients", {
    vpc: stack.vpc,
    description: "Workloads that declare database: true",
    allowAllOutbound: true,
    allowAllIpv6Outbound: true,
  });
  network.databaseClients = group;
  deferResourceAttachment(scope, () => admit(scope, binding, group, stack));
  return group;
}

function admit(scope: IConstruct, binding: ConnectsToBinding, group: ec2.SecurityGroup, stack: NetworkStack): void {
  const name = `resources.${binding.resource.path.join(".")}`;
  const linked = linkedConstruct(scope, binding.resource);
  if (!linked) {
    throw new Error(`The config's database, ${name}, is linked by nothing. End its stack's constructor with linkResources(this, resources.${binding.resource.path[0]}).`);
  }
  const construct = linked.construct as { readonly connections?: ec2.Connections; readonly vpc?: ec2.IVpc };
  if (!construct.connections?.defaultPort || typeof construct.connections.allowDefaultPortFrom !== "function") {
    throw new Error(`The config's database, ${name}, accepts no connections. It is an rds.DatabaseInstance.`);
  }
  if (construct.vpc && construct.vpc !== stack.vpc) {
    throw new Error(`The config's database, ${name}, is built in another VPC. Build it with vpc: frameworkVpc(this).`);
  }
  construct.connections.allowDefaultPortFrom(group, "database: true");
}

/** The database a target uses, when this deployment builds it. */
export function presentConnections(target: NormalizedTarget): readonly ConnectsToBinding[] {
  return getConnectsToBindings(target.cloud.bindings).filter((binding) => !isResourceAbsent(binding.resource));
}

/**
 * Whether a Lambda runs inside the network in this deployment: when it uses a
 * database this deployment builds, or has `vpc: true` in a deployment that
 * builds the network at all.
 */
export function isPlacedInNetwork(scope: IConstruct, target: NormalizedTarget): boolean {
  if (target.kind !== "lambda") return false;
  if (presentConnections(target).length > 0) return true;
  const options = frameworkResourceOptions(scope);
  return options !== undefined && options.mode !== "dev" && resolveLambdaTarget(options.config, target.id).vpc;
}

/**
 * The one security group a Lambda with `vpc: true` and no database joins,
 * created with the first of them. Shared, so the functions share their network
 * interfaces too; it admits nobody, and lets them out over both families.
 */
function vpcLambdas(scope: IConstruct, origin: string): ec2.SecurityGroup {
  const network = state(scope);
  if (network.vpcLambdas) return network.vpcLambdas;
  const stack = networkStack(scope, `${origin} has vpc: true`);
  network.vpcLambdas = new ec2.SecurityGroup(stack, "VpcLambdas", {
    vpc: stack.vpc,
    description: "Lambdas with vpc: true",
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
 * A function that reaches the database: the private subnets, the database's
 * clients group, IPv6 out through the egress-only gateway.
 */
export function databaseClientPlacement(scope: IConstruct, binding: ConnectsToBinding, origin: string): LambdaPlacement {
  return {
    vpc: networkStack(scope, `${origin} declares database: true`).vpc,
    vpcSubnets: networkSubnets("private"),
    securityGroups: [databaseClients(scope, binding, origin)],
    ipv6AllowedForDualStack: true,
  };
}

/**
 * Where a Lambda runs: outside the VPC unless {@link isPlacedInNetwork}. Inside,
 * one that uses the database goes where {@link databaseClientPlacement} says,
 * and any other joins the shared group in the same private subnets.
 */
export function lambdaPlacement(scope: IConstruct, target: NormalizedTarget): LambdaPlacement | undefined {
  if (!isPlacedInNetwork(scope, target)) return undefined;
  state(scope).placed.push(target.reference);
  const origin = target.origins[0] ?? target.reference;
  const [binding] = presentConnections(target);
  if (binding) return databaseClientPlacement(scope, binding, origin);
  return {
    vpc: networkStack(scope, `${origin} has vpc: true`).vpc,
    vpcSubnets: networkSubnets("private"),
    securityGroups: [vpcLambdas(scope, origin)],
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
    vpc: networkStack(scope, `${origin} is a container`).vpc,
    subnets: networkSubnets(subnet),
    assignPublicIp: subnet === "public",
    connectionGroups: presentConnections(target).map((binding) => databaseClients(scope, binding, origin)),
  };
  state(scope).placed.push(target.reference);
  return placement;
}

/**
 * One line for the synth output: what was placed in the network, and what it
 * costs. Undefined when this deployment built no network.
 */
export function describeFrameworkNetwork(scope: IConstruct): string | undefined {
  const network = state(scope);
  if (!network.stack) return undefined;
  const placed = network.placed.length > 0 ? network.placed.join(", ") : "nothing yet";
  return network.stack.nat
    ? `Network: ${placed} run in the VPC. One NAT gateway, turned on in framework-config/network.ts: about $33 a month plus $0.045 per GB.`
    : `Network: ${placed} run in the VPC. No NAT gateway: the private subnets leave over IPv6 only, which costs nothing.`;
}
