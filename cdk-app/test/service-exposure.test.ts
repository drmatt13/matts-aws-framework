import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import {
  defineFrameworkConfig,
  defineResources,
  getFrameworkTargets,
  type FrameworkConfig,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { EcsServicesStack } from "../lib/framework/ecs-services-stack";
import { HttpApiGatewayStack } from "../lib/framework/http-api-gateway-stack";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import {
  finalizeFrameworkResources,
  initializeFrameworkResources,
} from "../lib/framework/framework-resources";

/**
 * A service with `auth: true` must be reachable only through the HTTP API, as
 * it is through the local dev server's proxy: an internal load balancer, and a
 * VPC link from the API to it. Declares its own service, because the example
 * service is local-only and reaches no cloud graph.
 */
const env = { account: "111122223333", region: "eu-west-2" };

function config(): FrameworkConfig {
  return defineFrameworkConfig({
    resources: defineResources({}),
    defaults,
    http: [],
    webSocket: [],
    services: [
      {
        "/example/*": {
          directory: "/ecs_containers/services/example-service",
          methods: "*",
          auth: true,
          port: 5000,
          deploy: "both",
          cloud: { constructId: "ExampleService", cpu: 256, memoryMiB: 512, desiredCount: 1 },
        },
      },
    ],
    events: [],
    tasks: [],
    workflows: [],
  } as never);
}

test("an authenticated service sits behind an internal load balancer and a VPC link", () => {
  const app = new cdk.App();
  const built = config();
  initializeFrameworkResources(app, { config: built, mode: "prod", deployment: "example", readers: { env: {} } });
  const services = new EcsServicesStack(app, "Services", {
    env,
    config: built,
    cloud: { mode: "prod" },
    targets: getFrameworkTargets(built).filter((target) => target.kind === "service"),
  } as never);
  const auth = new cdk.Stack(app, "Auth", { env });
  const userPool = new cognito.UserPool(auth, "Pool");
  const userPoolClient = userPool.addClient("Client");
  const api = new HttpApiGatewayStack(app, "Api", {
    env,
    config: built,
    targets: new FrameworkTargetRegistry().merge(services.targets),
    cognito: { userPool, userPoolClient },
    frontendUrls: [],
  });
  finalizeFrameworkResources(app);

  const loadBalancers = Template.fromStack(services).findResources(
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
  );
  const schemes = Object.values(loadBalancers).map(
    (resource) => (resource as { Properties: { Scheme?: string } }).Properties.Scheme,
  );
  assert.deepEqual(schemes, ["internal"]);

  const apiTemplate = Template.fromStack(api);
  apiTemplate.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  const integrations = Object.values(apiTemplate.findResources("AWS::ApiGatewayV2::Integration")).map(
    (resource) => (resource as { Properties: { ConnectionType?: string } }).Properties.ConnectionType,
  );
  assert.ok(integrations.length > 0);
  assert.ok(integrations.every((type) => type === "VPC_LINK"), JSON.stringify(integrations));
  // Every route to the service still carries the authorizer.
  const routes = Object.values(apiTemplate.findResources("AWS::ApiGatewayV2::Route")).map(
    (resource) => (resource as { Properties: { AuthorizationType?: string } }).Properties.AuthorizationType,
  );
  assert.ok(routes.length > 0 && routes.every((type) => type === "JWT"), JSON.stringify(routes));
});
