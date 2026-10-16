import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Template } from "aws-cdk-lib/assertions";
import {
  defineFrameworkConfig,
  defineResources,
  getFrameworkTargets,
  resource,
  type FrameworkConfig,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { attachContainerResources, attachLambdaResources } from "../lib/framework/framework-cloud";
import {
  finalizeFrameworkResources,
  initializeFrameworkResources,
  linkResource,
} from "../lib/framework/framework-resources";

/**
 * What `userPool: true` becomes in a template, on the two functions that
 * deliver every Lambda's and every container's environment.
 *
 * The application's own synth exercises the Lambda and AgentCore lanes; no
 * container there is deployed with the pool, so this pins that lane directly.
 * Neither function builds an image here, so no build context is copied. The
 * pool arrives as the linked construct's own reference, exactly as a
 * hand-written `USER_POOL_ID: resources.pool.userPoolId` would, and ahead of
 * the workload's own entries, because ECS renders a container's environment in
 * order and a converted declaration almost always had the two names first.
 */

const env = { account: "111122223333", region: "eu-west-2" };
const resources = defineResources({ pool: resource.cdk<IUserPool>(), client: resource.cdk<IUserPoolClient>() });

function config(workload: Record<string, unknown>): FrameworkConfig {
  return defineFrameworkConfig({
    resources,
    defaults,
    userPool: { userPoolId: resources.pool.userPoolId, userPoolClientId: resources.client.userPoolClientId },
    http: [{ "/reports": { directory: "/lambda_functions/http_functions/reports", methods: ["GET"], auth: true, ...workload } }],
    services: [{ "/accounts/*": { directory: "/ecs_containers/services/accounts", methods: "*", auth: true, port: 5000, deploy: "both", ...workload } }],
    webSocket: [], events: [], tasks: [], workflows: [],
  } as never);
}

/** Both lanes for one declaration, against a pool linked in its own stack. */
function synthesize(workload: Record<string, unknown>) {
  const built = config(workload);
  const target = (reference: string) => getFrameworkTargets(built).find((candidate) => candidate.reference === reference)!;
  const app = new App();
  initializeFrameworkResources(app, { config: built, mode: "prod", deployment: "example" });
  const identity = new Stack(app, "Identity", { env });
  const pool = new cognito.UserPool(identity, "UserPool");
  linkResource(identity, resources.pool, pool);
  linkResource(identity, resources.client, pool.addClient("UserPoolClient"));

  const consumer = new Stack(app, "Consumer", { env });
  const fn = new lambda.Function(consumer, "Reports", {
    runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};"),
  });
  attachLambdaResources(consumer, fn, target("lambda:reports"), { config: built, mode: "prod" });
  const definition = new ecs.FargateTaskDefinition(consumer, "Accounts");
  const container = definition.addContainer("App", { image: ecs.ContainerImage.fromRegistry("public.ecr.aws/example/accounts") });
  attachContainerResources(consumer, container, definition.taskRole, target("service:accounts"), { config: built, mode: "prod" });
  finalizeFrameworkResources(app);

  const template = Template.fromStack(consumer);
  const [lambdaResource] = Object.values(template.findResources("AWS::Lambda::Function")) as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }[];
  const [taskResource] = Object.values(template.findResources("AWS::ECS::TaskDefinition")) as { Properties: { ContainerDefinitions: { Environment?: { Name: string; Value: unknown }[] }[] } }[];
  return {
    lambda: lambdaResource!.Properties.Environment?.Variables ?? {},
    container: taskResource!.Properties.ContainerDefinitions[0]!.Environment ?? [],
  };
}

test("userPool: true reaches a Lambda and a container as the pool's own references, ahead of their own", () => {
  const { lambda: variables, container } = synthesize({ userPool: true, environment: { FEATURE: "on" } });
  assert.deepEqual(container.map((entry) => entry.Name), ["USER_POOL_ID", "USER_POOL_CLIENT_ID", "FEATURE"]);
  assert.deepEqual(Object.keys(variables).sort(), ["FEATURE", "USER_POOL_CLIENT_ID", "USER_POOL_ID"]);
  for (const name of ["USER_POOL_ID", "USER_POOL_CLIENT_ID"]) {
    const values = [JSON.stringify(variables[name]), JSON.stringify(container.find((entry) => entry.Name === name)?.Value)];
    for (const value of values) {
      assert.match(value, /Fn::ImportValue/, `${name} is the Identity stack's own export, resolved at deploy time`);
      assert.doesNotMatch(value, /eu-west-2_/, `${name} carries no literal pool id`);
    }
  }
});

test("a workload that does not declare it is handed nothing", () => {
  const { lambda: variables, container } = synthesize({ environment: { FEATURE: "on" } });
  assert.deepEqual(Object.keys(variables), ["FEATURE"]);
  assert.deepEqual(container.map((entry) => entry.Name), ["FEATURE"]);
});
