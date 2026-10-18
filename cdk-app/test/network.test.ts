import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import {
  defineFrameworkConfig,
  defineNetwork,
  defineResources,
  getFrameworkTargets,
  normalizeFrameworkConfig,
  resource,
  type FrameworkConfig,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { network as appNetwork } from "../../framework-config/network";
import { EcsServicesStack } from "../lib/framework/ecs-services-stack";
import { EcsTasksStack } from "../lib/framework/ecs-tasks-stack";
import { SynchronousLambdaFunctionsStack } from "../lib/framework/synchronous-lambda-functions-stack";
import { describeFrameworkNetwork, frameworkVpc, lambdaPlacement } from "../lib/framework/framework-network";
import { describeFrameworkDatabase } from "../lib/framework/framework-database";
import {
  finalizeFrameworkResources,
  initializeFrameworkResources,
  linkResources,
} from "../lib/framework/framework-resources";

const env = { account: "111122223333", region: "eu-west-2" };

/** An application stack as the framework expects one: built in frameworkVpc(this). */
class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public constructor(scope: Construct, id: string, overrides: Partial<rds.DatabaseInstanceProps> = {}) {
    super(scope, id, { env });
    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc: frameworkVpc(this),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      publiclyAccessible: false,
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      iamAuthentication: true,
      databaseName: "app_db",
      ...overrides,
    });
    linkResources(this, resources.data);
  }
}
const resources = defineResources({ data: resource.stack<DataStack>() });
const absent = defineResources({ data: (false as boolean) ? resource.stack<DataStack>() : undefined });

const connected = { database: true };
const route = { "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"], ...connected } };

function config(input: Record<string, unknown>): FrameworkConfig {
  return defineFrameworkConfig({
    resources, database: resources.data.database, defaults, http: [], webSocket: [], events: [], services: [], tasks: [], workflows: [],
    ...input,
  } as never);
}

function app(built: FrameworkConfig, mode: "dev" | "prod" = "prod"): cdk.App {
  const application = new cdk.App();
  initializeFrameworkResources(application, { config: built, mode, deployment: "example", readers: { env: {} } });
  return application;
}

const networkOf = (application: cdk.App) =>
  Template.fromStack(application.node.findChild("example-NetworkStack") as cdk.Stack);

test("database: true puts a Lambda in the private subnets, logging in with IAM, and the database admits only its group", () => {
  const built = config({ http: [route] });
  const application = app(built);
  const data = new DataStack(application, "Data");
  const lambdas = new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(application);

  const network = networkOf(application);
  network.resourceCountIs("AWS::EC2::NatGateway", 0);
  network.resourceCountIs("AWS::EC2::EgressOnlyInternetGateway", 1);
  network.resourceCountIs("AWS::EC2::VPCEndpoint", 2);
  network.resourceCountIs("AWS::EC2::Subnet", 6);
  const routes = Object.values(network.findResources("AWS::EC2::Route")).map((route) => (route as { Properties: Record<string, unknown> }).Properties);
  const privateRoutes = routes.filter((route) => "EgressOnlyInternetGatewayId" in route);
  assert.equal(privateRoutes.length, 2, "one IPv6 route per private subnet");
  assert.ok(privateRoutes.every((route) => route.DestinationIpv6CidrBlock === "::/0"));
  assert.ok(!routes.some((route) => "NatGatewayId" in route), "no IPv4 route out of the private subnets");

  const fn = Object.values(Template.fromStack(lambdas).findResources("AWS::Lambda::Function"))[0] as { Properties: { VpcConfig?: { Ipv6AllowedForDualStack?: boolean; SecurityGroupIds: unknown[] }; Environment?: { Variables?: Record<string, unknown> } } };
  assert.equal(fn.Properties.VpcConfig?.Ipv6AllowedForDualStack, true);
  assert.equal(fn.Properties.VpcConfig?.SecurityGroupIds.length, 1);
  assert.equal(fn.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, "true");

  const variables = fn.Properties.Environment?.Variables ?? {};
  assert.equal(variables.PRIMARY_DATABASE_AUTH, "iam");
  assert.match(JSON.stringify(variables.PRIMARY_DATABASE_URL), /"postgresql:\/\/app_user@"/);
  assert.ok(!JSON.stringify(variables.PRIMARY_DATABASE_URL).includes("password"), "the URL carries no password");
  const policies = JSON.stringify(Template.fromStack(lambdas).findResources("AWS::IAM::Policy"));
  assert.match(policies, /"rds-db:connect"/);
  assert.match(policies, /:dbuser:".*DbiResourceId.*"\/app_user"/);
  assert.ok(!policies.includes("secretsmanager"), "no workload reads a database secret");

  const ingress = Object.values(Template.fromStack(data).findResources("AWS::EC2::SecurityGroupIngress")).map((rule) => JSON.stringify((rule as { Properties: unknown }).Properties));
  assert.equal(ingress.length, 1);
  assert.match(ingress[0]!, /example-NetworkStack:ExportsOutputFnGetAttDatabaseClients/);
  assert.equal(describeFrameworkNetwork(application), "Network: lambda:verify-session run in the VPC. The private subnets leave over IPv6 only, with gateway endpoints for S3 and DynamoDB. It costs nothing.");
  assert.match(describeFrameworkDatabase(application) ?? "", /lambda:verify-session log in as app_user with IAM/);
});

test("the database's IAM login is created on deploy, once, by the only thing that reads the master secret", () => {
  const built = config({ http: [route, { "/sign-out": { directory: "/lambda_functions/http_functions/sign-out", methods: ["POST"], ...connected } }] });
  const application = app(built);
  const data = new DataStack(application, "Data");
  new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(application);

  const template = Template.fromStack(data);
  const logins = Object.values(template.findResources("Custom::DatabaseLogin")) as { Properties: Record<string, unknown> }[];
  assert.equal(logins.length, 1, "one per database, however many workloads use it");
  assert.equal(logins[0]!.Properties.Login, "app_user");
  assert.equal(logins[0]!.Properties.Database, "app_db");
  assert.equal(logins[0]!.Properties.PermissionsVersion, 2, "redeployment must reapply migration grants to existing logins");
  const handler = Object.entries(template.findResources("AWS::Lambda::Function"))
    .find(([id]) => id.startsWith("FrameworkDatabaseLoginHandler"))?.[1] as { Properties: { VpcConfig?: { SecurityGroupIds: unknown[]; Ipv6AllowedForDualStack?: boolean }; Environment?: { Variables?: Record<string, string> } } } | undefined;
  assert.ok(handler, "the login handler is in the database's stack");
  assert.equal(handler.Properties.VpcConfig?.Ipv6AllowedForDualStack, true);
  assert.match(JSON.stringify(handler.Properties.VpcConfig?.SecurityGroupIds), /DatabaseClients/);
  assert.equal(handler.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.match(JSON.stringify(template.findResources("AWS::IAM::Policy")), /secretsmanager:GetSecretValue/);
});

test("database: true reaches an rds.DatabaseInstance whose master secret the framework can read", () => {
  const cases: [Partial<rds.DatabaseInstanceProps>, RegExp][] = [
    [{ credentials: rds.Credentials.fromPassword("postgres", cdk.SecretValue.unsafePlainText("example")) }, /has no master secret\. Build it with credentials: rds\.Credentials\.fromGeneratedSecret\("postgres"\)/],
    [{ databaseName: undefined }, /names no database\. Give it databaseName/],
    [{ credentials: rds.Credentials.fromGeneratedSecret("app_user") }, /has the master user "app_user", which is the IAM login the framework creates/],
  ];
  for (const [overrides, refusal] of cases) {
    const built = config({ http: [route] });
    const application = app(built);
    new DataStack(application, "Data", overrides);
    assert.throws(() => {
      new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
      finalizeFrameworkResources(application);
    }, refusal);
  }
});

const withNat = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, natGateway: true });

test("only the network declaration builds a NAT gateway, never a container", () => {
  for (const [network, subnet, nat] of [[undefined, "public", 0], [withNat, "public", 1], [withNat, "private", 1]] as const) {
    const built = config({ ...(network ? { network } : {}), tasks: [{ "network-worker": { directory: "/test/fixtures/task-worker", deploy: "both", cloud: { subnet } } }] });
    const application = app(built);
    new EcsTasksStack(application, "Tasks", { env, config: built, cloud: { mode: "prod" } });
    finalizeFrameworkResources(application);
    networkOf(application).resourceCountIs("AWS::EC2::NatGateway", nat);
    assert.match(describeFrameworkNetwork(application) ?? "", nat ? /The private subnets leave over IPv6 and IPv4.*It costs one NAT gateway, about \$32\.85 a month plus \$0\.045 per GB/ : /It costs nothing\./);
  }
});

test("a service joins its connections' groups without opening them to its load balancer", () => {
  const built = config({ network: withNat, services: [{ "/example/*": {
    directory: "/ecs_containers/services/example-service", methods: "*", port: 5000, deploy: "both",
    ...connected,
    cloud: { constructId: "ExampleService", subnet: "private" },
  } }] });
  const application = app(built);
  new DataStack(application, "Data");
  const services = new EcsServicesStack(application, "Services", {
    env, config: built, cloud: { mode: "prod" },
    targets: getFrameworkTargets(built).filter((target) => target.kind === "service"),
  } as never);
  finalizeFrameworkResources(application);

  const service = Object.values(Template.fromStack(services).findResources("AWS::ECS::Service"))[0] as { Properties: { NetworkConfiguration: { AwsvpcConfiguration: { SecurityGroups: unknown[]; AssignPublicIp: string } } } };
  const groups = service.Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups.map((group) => JSON.stringify(group));
  assert.equal(groups.length, 2, "its own group and the database's");
  assert.ok(groups.some((group) => group.includes("DatabaseClients")));
  assert.match(JSON.stringify(Template.fromStack(services).findResources("AWS::IAM::Policy")), /"rds-db:connect"/, "the task role logs in with IAM");
  assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, "DISABLED", "a private service has no public address");
  const loadBalancerRules = Object.values(Template.fromStack(services).findResources("AWS::EC2::SecurityGroupIngress")).map((rule) => JSON.stringify(rule));
  assert.ok(!loadBalancerRules.some((rule) => rule.includes("DatabaseClients")), "the shared group admits nobody");
});

test("a dev deployment never builds the network", () => {
  const application = app(config({}), "dev");
  const stack = new cdk.Stack(application, "Data", { env });
  assert.throws(() => frameworkVpc(stack), /a dev deployment never builds the network.*-c prodDeployment=true/);
});

test("database: true places nothing when the deployment builds no database", () => {
  const built = config({ resources: absent, database: absent.data.database, http: [route] });
  const application = app(built, "dev");
  const stack = new cdk.Stack(application, "Lambdas", { env });
  const target = normalizeFrameworkConfig(built).targets.get("lambda:verify-session")!;
  assert.equal(lambdaPlacement(stack, target), undefined);
  assert.equal(describeFrameworkNetwork(application), undefined);
  assert.equal(describeFrameworkDatabase(application), undefined);
});

const inside = { "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"], subnet: "private" } };

test("subnet: \"private\" puts a Lambda in the private subnets, in a shared group the database does not admit", () => {
  const built = config({ http: [inside] });
  const application = app(built);
  const lambdas = new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(application);

  const network = networkOf(application);
  network.resourceCountIs("AWS::EC2::NatGateway", 0);
  network.hasResourceProperties("AWS::EC2::SecurityGroup", { GroupDescription: "Lambdas in the VPC" });

  const fn = Object.values(Template.fromStack(lambdas).findResources("AWS::Lambda::Function"))[0] as { Properties: { VpcConfig?: { Ipv6AllowedForDualStack?: boolean; SecurityGroupIds: unknown[]; SubnetIds: unknown[] }; Environment?: { Variables?: Record<string, unknown> } } };
  assert.equal(fn.Properties.VpcConfig?.Ipv6AllowedForDualStack, true);
  assert.match(JSON.stringify(fn.Properties.VpcConfig?.SecurityGroupIds), /VpcLambdas/);
  assert.match(JSON.stringify(fn.Properties.VpcConfig?.SubnetIds), /privateSubnet1/);
  assert.equal(fn.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal(fn.Properties.Environment?.Variables?.PRIMARY_DATABASE_URL, undefined, "a subnet is not database access");
  assert.ok(!JSON.stringify(Template.fromStack(lambdas).findResources("AWS::IAM::Policy")).includes("rds-db:connect"));
  assert.match(describeFrameworkNetwork(application) ?? "", /lambda:verify-session run in the VPC/);
});

test("a subnet places nothing in a dev deployment, which builds no network", () => {
  const built = config({ resources: absent, database: absent.data.database, http: [inside] });
  const application = app(built, "dev");
  const stack = new cdk.Stack(application, "Lambdas", { env });
  const target = normalizeFrameworkConfig(built).targets.get("lambda:verify-session")!;
  assert.equal(lambdaPlacement(stack, target), undefined);
  assert.equal(describeFrameworkNetwork(application), undefined);
});

/** The template the network built before network.ts owned its gateways and endpoints. */
const LOGICAL_IDS_BEFORE = [
  "Vpc8378EB38", "VpcDynamoDB6FB9CBF5", "VpcEIGW61416F369", "VpcIGWD7BA715C", "VpcS3A5408339", "VpcVPCGWBF912B6E",
  "Vpcipv6cidr40D3CB78", "VpcisolatedSubnet1RouteTableAssociationD259E31A", "VpcisolatedSubnet1RouteTableE442650B",
  "VpcisolatedSubnet1SubnetE62B1B9B", "VpcisolatedSubnet2RouteTable334F9764", "VpcisolatedSubnet2RouteTableAssociation25A4716F",
  "VpcisolatedSubnet2Subnet39217055", "VpcprivateSubnet1DefaultRoute649DFCF6C", "VpcprivateSubnet1RouteTable1979EACB",
  "VpcprivateSubnet1RouteTableAssociationEEBD93CE", "VpcprivateSubnet1SubnetCEAD3716", "VpcprivateSubnet2DefaultRoute67053E208",
  "VpcprivateSubnet2RouteTable4D0FFC8C", "VpcprivateSubnet2RouteTableAssociationB691E645", "VpcprivateSubnet2Subnet2DE7549C",
  "VpcpublicSubnet1DefaultRoute6AA4A2F50", "VpcpublicSubnet1DefaultRouteB88F9E93", "VpcpublicSubnet1RouteTable15C15F8E",
  "VpcpublicSubnet1RouteTableAssociation4E83B6E4", "VpcpublicSubnet1Subnet2BB74ED7", "VpcpublicSubnet2DefaultRoute671EE6EEE",
  "VpcpublicSubnet2DefaultRoute732F0BEB", "VpcpublicSubnet2RouteTableAssociationCCE257FF", "VpcpublicSubnet2RouteTableC5A6DF77",
  "VpcpublicSubnet2SubnetE34B022A",
];

/** The network stack alone, built for a config. */
function networkFor(network?: ReturnType<typeof defineNetwork>, input: Record<string, unknown> = {}) {
  const built = config({ ...(network ? { network } : {}), ...input });
  const application = app(built);
  frameworkVpc(new cdk.Stack(application, "Probe", { env }));
  finalizeFrameworkResources(application);
  return { application, template: networkOf(application) };
}

test("the app's network.ts builds exactly the network it built before, logical id for logical id", () => {
  const { template } = networkFor(appNetwork);
  assert.deepEqual(Object.keys(template.toJSON().Resources).sort(), [...LOGICAL_IDS_BEFORE].sort());
});

test("without an egress-only internet gateway the private subnets keep no IPv6 way out; the public ones keep theirs", () => {
  const { template, application } = networkFor(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false }));
  template.resourceCountIs("AWS::EC2::EgressOnlyInternetGateway", 0);
  const ids = Object.keys(template.toJSON().Resources);
  assert.ok(!ids.some((id) => /^VpcprivateSubnet\dDefaultRoute6/.test(id)), "no IPv6 route out of a private subnet");
  assert.equal(ids.filter((id) => /^VpcpublicSubnet\dDefaultRoute6/.test(id)).length, 2, "public subnets route IPv6 to the internet gateway");
  assert.deepEqual(ids.sort(), LOGICAL_IDS_BEFORE.filter((id) => !/EIGW|privateSubnet\dDefaultRoute6/.test(id)).sort(), "nothing else moves");
  assert.match(describeFrameworkNetwork(application) ?? "", /The private subnets have no way out, with gateway endpoints for S3 and DynamoDB\. It costs nothing\./);
});

test("the gateway endpoints are network.ts's to turn off, and keep their logical ids when on", () => {
  const { template } = networkFor(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, gatewayEndpoints: { s3: true, dynamodb: false } }));
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
  assert.ok("VpcS3A5408339" in template.toJSON().Resources);
});

test("interface endpoints sit in the private subnets with private DNS, behind one group that admits HTTPS from the VPC", () => {
  const { template, application } = networkFor(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["secretsmanager", "ecr.api"] }));
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
  const interfaces = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::EC2::VPCEndpoint" && resource.Properties.VpcEndpointType === "Interface");
  assert.deepEqual(interfaces.map(([id]) => id.replace(/[0-9A-F]{8}$/, "")).sort(), ["VpcEcrApiEndpoint", "VpcSecretsmanagerEndpoint"], "named for the service");
  for (const [, endpoint] of interfaces) {
    assert.equal(endpoint.Properties.PrivateDnsEnabled, true);
    assert.match(JSON.stringify(endpoint.Properties.SubnetIds), /privateSubnet1.*privateSubnet2/);
    assert.match(JSON.stringify(endpoint.Properties.SecurityGroupIds), /InterfaceEndpoints/);
    assert.equal(endpoint.Properties.IpAddressType, undefined, "IPv4, which every service supports");
  }
  assert.match(JSON.stringify(interfaces.map(([, endpoint]) => endpoint.Properties.ServiceName)), /\.secretsmanager".*\.ecr\.api"|\.ecr\.api".*\.secretsmanager"/);
  const groups = Object.values(resources).filter((resource) => resource.Type === "AWS::EC2::SecurityGroup");
  assert.equal(groups.length, 1, "one group for every endpoint");
  assert.deepEqual(
    (groups[0]!.Properties.SecurityGroupIngress as { FromPort: number; ToPort: number; IpProtocol: string }[]).map(({ FromPort, ToPort, IpProtocol }) => ({ FromPort, ToPort, IpProtocol })),
    [{ FromPort: 443, ToPort: 443, IpProtocol: "tcp" }],
  );
  assert.match(describeFrameworkNetwork(application) ?? "", /interface endpoints for secretsmanager, ecr\.api\. It costs 2 interface endpoints in 2 zones, about \$29\.20 a month plus \$0\.01 per GB/);

  const reordered = networkFor(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["ecr.api", "secretsmanager"] })).template;
  assert.deepEqual(Object.keys(reordered.toJSON().Resources).sort(), Object.keys(resources).sort(), "listing them in another order replaces nothing");
});

test("subnet: \"isolated\" puts a Lambda in the isolated subnets, calling the standard hostnames the endpoints answer", () => {
  const isolated = { "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"], subnet: "isolated" } };
  const built = config({ http: [isolated] });
  const application = app(built);
  const lambdas = new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(application);
  const fn = Object.values(Template.fromStack(lambdas).findResources("AWS::Lambda::Function"))[0] as { Properties: { VpcConfig?: { SubnetIds: unknown[] }; Environment?: { Variables?: Record<string, unknown> } } };
  assert.match(JSON.stringify(fn.Properties.VpcConfig?.SubnetIds), /isolatedSubnet1.*isolatedSubnet2/);
  assert.equal(fn.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, undefined);
});

test("a private Lambda and the database login call dual-stack endpoints only where IPv6 leaves the private subnets", () => {
  const natOnly = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false, natGateway: true });
  const built = config({ network: natOnly, http: [route] });
  const application = app(built);
  const data = new DataStack(application, "Data");
  const lambdas = new SynchronousLambdaFunctionsStack(application, "Lambdas", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(application);
  const fn = Object.values(Template.fromStack(lambdas).findResources("AWS::Lambda::Function"))[0] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } };
  assert.equal(fn.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, undefined);
  assert.equal(fn.Properties.Environment?.Variables?.PRIMARY_DATABASE_AUTH, "iam");
  const login = Object.entries(Template.fromStack(data).findResources("AWS::Lambda::Function"))
    .find(([id]) => id.startsWith("FrameworkDatabaseLoginHandler"))?.[1] as { Properties: { Environment?: { Variables?: Record<string, string> } } };
  assert.equal(login.Properties.Environment?.Variables?.AWS_USE_DUALSTACK_ENDPOINT, undefined);
  assert.match(describeFrameworkNetwork(application) ?? "", /The private subnets leave over IPv4 only/);
});
