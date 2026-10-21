import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineNetwork, defineResources, resource, type FrameworkConfigInput } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { EcsServicesStack } from "../lib/framework/ecs-services-stack";
import { EcsTasksStack } from "../lib/framework/ecs-tasks-stack";
import { HttpApiGatewayStack } from "../lib/framework/http-api-gateway-stack";
import { initializeFrameworkResources, finalizeFrameworkResources, linkResource } from "../lib/framework/framework-resources";
import { frameworkVpc } from "../lib/framework/framework-network";

const env = { account: "111122223333", region: "eu-west-2" };
const alpha = defineNetwork({ id: "alpha", cidr: "10.0.0.0/16", zones: 2 });
const beta = defineNetwork({ id: "beta", cidr: "10.1.0.0/16", zones: 2 });
const unused = defineNetwork({ id: "unused", cidr: "10.2.0.0/16", zones: 2, natGateway: true });
const config = (input: Partial<FrameworkConfigInput> = {}) => defineFrameworkConfig({ networks: [unused, beta, alpha], defaults, http: [], webSocket: [], events: [], services: [], ...input });
const appFor = (built: ReturnType<typeof config>) => {
  const app = new cdk.App();
  initializeFrameworkResources(app, { config: built, mode: "prod", deployment: "multi", readers: { env: {} } });
  return app;
};

test("services have separate clusters, load-balancer VPCs and API VPC links; unused declarations stay unbuilt", () => {
  const built = config({ services: [{
    "/alpha/*": { id: "alpha-service", directory: "/ecs_containers/services/example-service", methods: "*", port: 5000, cloud: { vpc: alpha } },
    "/beta/*": { id: "beta-service", directory: "/test/fixtures/task-worker", methods: "*", port: 5000, cloud: { vpc: beta } },
  }] });
  const app = appFor(built);
  const services = new EcsServicesStack(app, "Services", { env, config: built, cloud: { mode: "prod" } });
  const auth = new cdk.Stack(app, "Auth", { env });
  const userPool = new cognito.UserPool(auth, "Pool");
  const api = new HttpApiGatewayStack(app, "Api", { env, config: built, targets: services.targets, cognito: { userPool, userPoolClient: userPool.addClient("Client") }, frontendUrls: [] });
  finalizeFrameworkResources(app);
  Template.fromStack(services).resourceCountIs("AWS::ECS::Cluster", 2);
  const links = Object.values(Template.fromStack(api).findResources("AWS::ApiGatewayV2::VpcLink"));
  assert.equal(links.length, 2);
  assert.notDeepEqual(links[0]!.Properties.SubnetIds, links[1]!.Properties.SubnetIds);
  const balancers = Object.values(Template.fromStack(services).findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"));
  assert.notDeepEqual(balancers[0]!.Properties.Subnets, balancers[1]!.Properties.Subnets);
  assert.equal(app.node.tryFindChild("multi-UnusedNetworkStack"), undefined, "looking up a VPC link must not build unused VPCs");
  for (const network of [alpha, beta]) {
    const template = Template.fromStack(app.node.findChild(`multi-${network.cloud.constructId}`) as cdk.Stack);
    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::VPCPeeringConnection", 0);
  }
});

test("task launch descriptors select their own cluster, subnets and security groups", () => {
  const built = config({ tasks: [{
    "invocation-test-task": { cloud: { vpc: alpha } },
    "db-migrate": { cloud: { vpc: beta } },
  }] });
  const app = appFor(built);
  const tasks = new EcsTasksStack(app, "Tasks", { env, config: built, cloud: { mode: "prod" } });
  finalizeFrameworkResources(app);
  const first = tasks.targets.requireTask("task:invocation-test-task").launch;
  const second = tasks.targets.requireTask("task:db-migrate").launch;
  assert.notDeepEqual(first.cluster, second.cluster);
  assert.notDeepEqual(first.subnets, second.subnets);
  assert.notDeepEqual(first.securityGroups, second.securityGroups);
  Template.fromStack(tasks).resourceCountIs("AWS::ECS::Cluster", 2);
  assert.equal(app.node.tryFindChild("multi-UnusedNetworkStack"), undefined);
});

test("native database placement is checked against its declared VPC without workload consumers", () => {
  for (const actual of [alpha, beta]) {
    const resources = defineResources({ data: resource.stack<{ database: rds.DatabaseInstance }>() });
    const built = config({ resources, database: { resource: resources.data.database, vpc: beta } });
    const app = appFor(built);
    const data = new cdk.Stack(app, "Data", { env });
    const instance = new rds.DatabaseInstance(data, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc: frameworkVpc(data, actual), vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      databaseName: "app_db", iamAuthentication: true,
    });
    linkResource(data, resources.data.database, instance);
    if (actual === alpha) assert.throws(() => finalizeFrameworkResources(app), /database is built in another VPC/);
    else {
      finalizeFrameworkResources(app);
      assert.equal(app.node.tryFindChild("multi-AlphaNetworkStack"), undefined);
      assert.equal(app.node.tryFindChild("multi-UnusedNetworkStack"), undefined);
      assert.equal(Object.keys(Template.fromStack(data).findResources("AWS::RDS::DBInstance")).length, 1);
    }
  }
});

test("network stacks retain identities across registration order and are absent from development", () => {
  const stacks = (networks: typeof alpha[]) => {
    const built = config({ networks });
    const app = appFor(built);
    const scope = new cdk.Stack(app, "Probe", { env });
    for (const network of [alpha, beta]) frameworkVpc(scope, network);
    finalizeFrameworkResources(app);
    return app.synth().stacks.filter(stack => /NetworkStack$/.test(stack.stackName)).map(stack => [stack.stackName, stack.template]);
  };
  assert.deepEqual(stacks([alpha, beta]), stacks([beta, alpha]));
  const built = config();
  const app = new cdk.App();
  initializeFrameworkResources(app, { config: built, mode: "dev", deployment: "dev", readers: { env: {} } });
  const probe = new cdk.Stack(app, "Probe", { env });
  assert.throws(() => frameworkVpc(probe, undefined as never), /explicit imported vpc/);
  assert.throws(() => frameworkVpc(probe, alpha), /dev deployment never builds the network/);
  assert.equal(app.node.children.filter(child => child.node.id.includes("NetworkStack")).length, 0);
});
