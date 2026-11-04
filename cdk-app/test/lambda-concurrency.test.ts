import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import {
  defineFrameworkConfig, invokeLambda, trigger, workflow,
  type LambdaTargetDefinition,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { SynchronousLambdaFunctionsStack } from "../lib/framework/synchronous-lambda-functions-stack";
import { WebSocketLambdaFunctionsStack } from "../lib/framework/websocket-lambda-functions-stack";
import { HttpApiGatewayStack } from "../lib/framework/http-api-gateway-stack";
import { WebSocketApiStack } from "../lib/framework/websocket-api-stack";
import { OrchestrationStack } from "../lib/framework/orchestration-stack";
import { buildEventLambdas, eventFunction } from "../lib/framework/framework-events";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";
import { agentFixtureDirectory, fixtureAgentSource, fixtureToolSource, toolFixtureDirectory, writeSourceFixtures } from "./support/source-fixtures";

const env = { account: "111122223333", region: "us-east-1" };
const handler = { directory: "/test/fixtures/workload-handler", id: "handler", methods: ["GET"], cloud: { constructId: "StableHandler", outputs: { arn: { id: "HandlerArn" } } } } as const;
const enabled = { reservedConcurrentExecutions: 5, provisionedConcurrentExecutions: 2 } as const;

function appFor(config: ReturnType<typeof defineFrameworkConfig>, mode: "dev" | "prod" = "prod") {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [], "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config, mode, deployment: "concurrency", env, readers: { env: {} } });
  return app;
}

function synth(settings: LambdaTargetDefinition = {}, value?: string) {
  const config = defineFrameworkConfig({ defaults, http: [{ "/handler": { ...handler, ...settings, ...(value === undefined ? {} : { environment: { EXAMPLE: value } }) } }], webSocket: [], events: [], services: [] });
  const app = appFor(config);
  const stack = new SynchronousLambdaFunctionsStack(app, "Lambdas", { env, config, cloud: { mode: "prod" } });
  finalizeFrameworkResources(app);
  return { stack, template: Template.fromStack(stack) };
}

test("disabled concurrency preserves existing Lambda identity and adds no versions or aliases", () => {
  const baseline = synth().template;
  const configured = synth(enabled).template;
  const cleared = synth().template;
  assert.deepEqual(Object.keys(configured.findResources("AWS::Lambda::Function")), Object.keys(baseline.findResources("AWS::Lambda::Function")));
  assert.deepEqual(cleared.toJSON(), baseline.toJSON());
  for (const template of [baseline, cleared]) {
    template.resourceCountIs("AWS::Lambda::Version", 0);
    template.resourceCountIs("AWS::Lambda::Alias", 0);
    assert.equal(Object.values(template.findResources("AWS::Lambda::Function"))[0].Properties.ReservedConcurrentExecutions, undefined);
  }
});

test("reserved concurrency zero synthesizes without publishing a version or alias", () => {
  const { template } = synth({ reservedConcurrentExecutions: 0 });
  template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 0 });
  template.resourceCountIs("AWS::Lambda::Version", 0);
  template.resourceCountIs("AWS::Lambda::Alias", 0);
});

test("provisioned concurrency publishes one version and the registry invokes its warm alias", () => {
  const { stack, template } = synth(enabled);
  template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 5 });
  template.resourceCountIs("AWS::Lambda::Version", 1);
  template.resourceCountIs("AWS::Lambda::Alias", 1);
  template.hasResourceProperties("AWS::Lambda::Alias", { Name: "provisioned", ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 } });
  assert.ok(stack.targets.requireLambda("lambda:handler" as never) instanceof lambda.Alias);
  assert.match(JSON.stringify(template.findOutputs("*")), /ProvisionedConcurrency/, "public invocation outputs use the same qualified target");
});

test("published versions include environment applied after function construction", () => {
  const before = synth(enabled, "before").template;
  const after = synth(enabled, "after").template;
  before.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: { EXAMPLE: "before" } } });
  after.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: { EXAMPLE: "after" } } });
  assert.notDeepEqual(Object.keys(before.findResources("AWS::Lambda::Version")), Object.keys(after.findResources("AWS::Lambda::Version")), "an environment update publishes a fresh immutable version");
  assert.deepEqual(Object.keys(before.findResources("AWS::Lambda::Alias")), Object.keys(after.findResources("AWS::Lambda::Alias")), "the caller's alias stays stable across versions");
});

test("HTTP and WebSocket integrations invoke provisioned aliases with qualified invocation grants", () => {
  const config = defineFrameworkConfig({
    defaults, http: [{ "/handler": { ...handler, ...enabled } }],
    webSocket: [{ $connect: {
      directory: "/lambda_functions/websocket_functions/ws-connect-route", ...enabled,
      authorizer: { directory: "/lambda_functions/websocket_functions/ws-authorizer", ...enabled },
    } }], events: [], services: [],
  });
  const app = appFor(config);
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const httpHandlers = new SynchronousLambdaFunctionsStack(app, "HttpHandlers", { env, config, cloud: { mode: "prod" } });
  const socketHandlers = new WebSocketLambdaFunctionsStack(app, "SocketHandlers", { env, config, cloud: { mode: "prod" } });
  const http = new HttpApiGatewayStack(app, "Http", { env, config, targets: httpHandlers.targets, cognito: { userPool, userPoolClient: userPool.addClient("Client") }, frontendUrls: [] });
  const socket = new WebSocketApiStack(app, "Socket", { env, config, targets: socketHandlers.targets, mode: "prod" });
  finalizeFrameworkResources(app);
  app.synth();
  for (const stack of [http, socket]) {
    const template = Template.fromStack(stack);
    assert.match(JSON.stringify(template.findResources("AWS::ApiGatewayV2::Integration")), /ProvisionedConcurrency/, stack.node.id);
    assert.match(JSON.stringify(template.findResources("AWS::Lambda::Permission")), /ProvisionedConcurrency/, `${stack.node.id} grant`);
  }
  assert.match(JSON.stringify(Template.fromStack(socket).findResources("AWS::ApiGatewayV2::Authorizer")), /ProvisionedConcurrency/);
});

test("event schedules, native Cognito hooks, and workflows invoke provisioned aliases in their supported modes", () => {
  for (const mode of ["dev", "prod"] as const) {
    const config = defineFrameworkConfig({
      defaults, http: [], webSocket: [], services: [],
      events: [{ worker: { directory: "/test/fixtures/workload-handler", ...enabled, triggers: [trigger.schedule({ id: "clock", accepts: "schedule", expression: "rate(1 hour)" })] } }],
      ...(mode === "prod" ? { workflows: [{ call: workflow(() => invokeLambda("worker" as never, {}), { timeoutSeconds: 60 }) }] } : {}),
    });
    const app = appFor(config, mode);
    const compute = new cdk.Stack(app, "AsynchronousLambdaFunctionsStack", { env });
    buildEventLambdas(compute, { config, targets: new FrameworkTargetRegistry(), cloud: { mode } }, ["worker"]);
    const identity = new cdk.Stack(app, "Identity", { env });
    const userPool = new cognito.UserPool(identity, "Pool", { lambdaTriggers: { preSignUp: eventFunction(identity, "worker" as never) } });
    const orchestration = mode === "prod" ? new OrchestrationStack(app, "Orchestration", { env, config, mode, cognito: { userPool, userPoolClient: userPool.addClient("Client") } }) : undefined;
    finalizeFrameworkResources(app);
    app.synth();
    assert.match(JSON.stringify(Template.fromStack(compute).findResources("AWS::Scheduler::Schedule")), /ProvisionedConcurrency/, `${mode} schedule`);
    assert.match(JSON.stringify(Template.fromStack(identity).findResources("AWS::Cognito::UserPool")), /ProvisionedConcurrency/, `${mode} native hook`);
    if (orchestration) assert.match(JSON.stringify(Template.fromStack(orchestration).findResources("AWS::StepFunctions::StateMachine")), /ProvisionedConcurrency/, "workflow invocation");
  }
});

test("AgentCore tools target the qualified provisioned alias", () => {
  const run = randomUUID().slice(0, 8);
  const dispose = writeSourceFixtures(run, { tools: { tool: fixtureToolSource }, agents: { agent: fixtureAgentSource("agent") } });
  try {
    const config = defineFrameworkConfig({
      defaults, http: [], webSocket: [], events: [], services: [],
      tools: [{ tool: { directory: toolFixtureDirectory(run, "tool"), ...enabled } }],
      agents: [{ agent: { directory: agentFixtureDirectory(run, "agent"), tools: ["tool"] } }],
    });
    const app = appFor(config);
    const identity = new cdk.Stack(app, "Identity", { env });
    const userPool = new cognito.UserPool(identity, "Pool");
    const stack = new OrchestrationStack(app, "Orchestration", {
      env, config, mode: "prod", cognito: { userPool, userPoolClient: userPool.addClient("Client") },
      tools: { tool: { description: "Example tool", auth: false, inputSchema: { type: "object" }, outputSchema: { type: "object" } } },
    });
    finalizeFrameworkResources(app);
    app.synth();
    const template = Template.fromStack(stack);
    assert.match(JSON.stringify(template.findResources("AWS::BedrockAgentCore::GatewayTarget")), /ProvisionedConcurrency/);
    assert.match(JSON.stringify(template.findResources("AWS::IAM::Policy")), /ProvisionedConcurrency/, "Gateway receives permission for its qualified Lambda target");
  } finally {
    dispose();
  }
});
