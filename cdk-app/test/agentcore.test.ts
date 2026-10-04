import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import {
  defineFrameworkConfig,
  getCloudTargets,
  invokeAgent,
  invokesAgent,
  workflow,
  type Flow,
  type FrameworkConfig,
} from "@repo/framework/config";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { defaults } from "../../framework-config/defaults";
import { hasAgentCoreCloudResources } from "../lib/framework/framework-agentcore";
import { buildFrameworkLambdas } from "../lib/framework/framework-cloud";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";
import { OrchestrationStack } from "../lib/framework/orchestration-stack";
import { findCycle, reaches, resourceGraph, type TemplateJson } from "./support/template-graph";

const env = { account: "111122223333", region: "us-east-1" };
const root = findRepositoryRoot(__dirname);
const cognitoEnvironment = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };

/**
 * A second agent and a service tool, written for this test beside the
 * repository's echo sample, so the synthesized graph has two Gateways to keep
 * apart. Removed afterwards.
 */
function fixtures() {
  const suffix = randomUUID().slice(0, 8);
  const toolId = `lookup-${suffix}`;
  const agentId = `worker-${suffix}`;
  const toolDirectory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", toolId);
  const agentDirectory = path.join(root, "agentcore", agentId);
  mkdirSync(toolDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(path.join(toolDirectory, "index.ts"), "export const lambdaHandler = async () => ({});");
  writeFileSync(
    path.join(agentDirectory, "index.ts"),
    `export const handler = { kind: "framework-agent", id: ${JSON.stringify(agentId)} };`,
  );
  return {
    toolId,
    agentId,
    dispose: () => {
      rmSync(toolDirectory, { recursive: true, force: true });
      rmSync(agentDirectory, { recursive: true, force: true });
    },
  };
}

function config(toolId: string, agentId: string, http = {}): FrameworkConfig {
  return defineFrameworkConfig({
    defaults,
    http: [http],
    webSocket: [],
    events: [],
    services: [],
    tools: [
      {
        echo: {
          auth: true,
          deploy: "both",
          environment: cognitoEnvironment,
          cloud: { access: [{ actions: ["s3:GetObject"], resources: ["arn:{partition}:s3:::example-bucket/*"] }] },
        },
        [toolId]: { directory: `/lambda_functions/tool_functions/${toolId}`, deploy: "both" },
      },
    ],
    agents: [
      {
        "echo-agent": {
          auth: true,
          route: "/chat/echo",
          tools: ["echo"],
          deploy: "both",
          environment: cognitoEnvironment,
          cloud: { idleSeconds: 600, access: [{ actions: ["bedrock:InvokeModel"], resources: ["arn:{partition}:bedrock:*::foundation-model/*"] }] },
        },
        [agentId]: { directory: `/agentcore/${agentId}`, tools: [toolId], deploy: "both" },
      },
    ],
  });
}

const manifest = (toolId: string) => ({
  echo: {
    description: "Echo.",
    auth: true,
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    outputSchema: { type: "object" },
  },
  [toolId]: { description: "Look up.", auth: false, inputSchema: { type: "object" }, outputSchema: { type: "object" } },
}) as const;

function synthesize(framework: FrameworkConfig, mode: "dev" | "prod", toolId: string, withCaller = false) {
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config: framework, mode, deployment: "agentcore-test", readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const userPoolClient = userPool.addClient("Client");
  const stack = new OrchestrationStack(app, "WorkflowsStack", {
    env,
    config: framework,
    mode,
    cognito: { userPool, userPoolClient },
    tools: manifest(toolId),
  });
  if (withCaller) {
    buildFrameworkLambdas(stack, stack.agentcore!.targets, getCloudTargets(framework, ["http"], mode), { config: framework, mode });
  }
  finalizeFrameworkResources(app);
  return Template.fromStack(stack);
}

test("a full deployment builds one Gateway per agent, holding exactly that agent's tools", () => {
  const { toolId, agentId, dispose } = fixtures();
  try {
    const template = synthesize(config(toolId, agentId), "prod", toolId);
    template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 2);
    template.allResourcesProperties("AWS::BedrockAgentCore::Gateway", { AuthorizerType: "AWS_IAM" });
    template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 2);

    const targets = Object.values(template.findResources("AWS::BedrockAgentCore::GatewayTarget")) as {
      Properties: { Name: string; GatewayIdentifier: unknown; TargetConfiguration: unknown };
    }[];
    const names = targets.map((target) => target.Properties.Name).sort();
    assert.deepEqual(names, ["echo", toolId].sort());
    const gatewayOf = (name: string) => JSON.stringify(targets.find((target) => target.Properties.Name === name)!.Properties.GatewayIdentifier);
    assert.notEqual(gatewayOf("echo"), gatewayOf(toolId), "each agent's tools sit on that agent's own Gateway");

    // A user tool lists the identity argument so Gateway carries it through.
    const echo = JSON.stringify(targets.find((target) => target.Properties.Name === "echo")!.Properties.TargetConfiguration);
    assert.match(echo, /__framework_identity/);
    assert.doesNotMatch(
      JSON.stringify(targets.find((target) => target.Properties.Name === toolId)!.Properties.TargetConfiguration),
      /__framework_identity/,
    );
  } finally {
    dispose();
  }
});

test("agents deploy as Node code, with Cognito in front of an agent that has users", () => {
  const { toolId, agentId, dispose } = fixtures();
  try {
    const template = synthesize(config(toolId, agentId), "prod", toolId);
    template.resourceCountIs("AWS::BedrockAgentCore::Runtime", 2);
    const runtimes = Object.values(template.findResources("AWS::BedrockAgentCore::Runtime")) as {
      Properties: Record<string, any>;
    }[];
    for (const runtime of runtimes) {
      assert.equal(runtime.Properties.AgentRuntimeArtifact.CodeConfiguration.Runtime, "NODE_22");
    }
    const withUsers = runtimes.find((runtime) => runtime.Properties.AuthorizerConfiguration);
    assert.ok(withUsers, "the agent with users has an authorizer");
    const jwt = withUsers.Properties.AuthorizerConfiguration.CustomJWTAuthorizer;
    assert.match(JSON.stringify(jwt.DiscoveryUrl), /well-known\/openid-configuration/);
    assert.ok(jwt.AllowedAudience, "ID tokens carry aud, so the client id is the allowed audience");
    assert.equal(jwt.AllowedClients, undefined);
    assert.deepEqual(withUsers.Properties.RequestHeaderConfiguration, { RequestHeaderAllowlist: ["Authorization"] });
    assert.equal(withUsers.Properties.LifecycleConfiguration.IdleRuntimeSessionTimeout, 600);
    assert.match(JSON.stringify(withUsers.Properties.EnvironmentVariables), /FRAMEWORK_AGENTCORE_ADAPTER/);
    assert.equal(runtimes.filter((runtime) => !runtime.Properties.AuthorizerConfiguration).length, 1);

    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, /bedrock-agentcore:InvokeGateway/);
    assert.match(serialized, /example-bucket/, "a tool's own access lands on its Lambda");
    const runtimePolicy = JSON.stringify(
      Object.entries(template.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith("AgentCoreRuntimesEchoAgent")),
    );
    assert.match(runtimePolicy, /bedrock:InvokeModel/, "an agent's own access lands on its Runtime role");
    // Each Runtime has its MMDSv2 setting applied, through one shared provider.
    template.resourceCountIs("AWS::CloudFormation::CustomResource", 2);
    const providers = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => (fn as { Properties: { Handler?: string } }).Properties.Handler === "framework.onEvent",
    );
    assert.equal(providers.length, 1, "one MMDSv2 provider serves every Runtime");
  } finally {
    dispose();
  }
});

test("a dev deployment holds nothing for agents: they, their Gateways and their tools all run locally", () => {
  const { toolId, agentId, dispose } = fixtures();
  try {
    assert.equal(hasAgentCoreCloudResources(config(toolId, agentId), "dev"), false);
    assert.equal(hasAgentCoreCloudResources(config(toolId, agentId), "prod"), true);
  } finally {
    dispose();
  }
});

test("invokesAgent: an agent with users is called with the caller's token, a service agent with an IAM grant", () => {
  const { toolId, agentId, dispose } = fixtures();
  const caller = {
    "/ask": {
      directory: "/lambda_functions/http_functions/test-run-task",
      methods: ["POST" as const],
      auth: true as const,
      deploy: "both" as const,
      cloud: { bindings: [invokesAgent("echo-agent"), invokesAgent(agentId)] },
    },
  };
  try {
    const template = JSON.stringify(synthesize(config(toolId, agentId, caller), "prod", toolId, true).toJSON());
    assert.match(template, /FRAMEWORK_AGENT_ECHO_AGENT/);
    assert.match(template, /\\"kind\\":\\"agent\\"/);
    assert.match(template, /\\"auth\\":true/);
    assert.match(template, /\\"auth\\":false/);
    // One grant: the service agent's. The agent with users accepts the user's token instead.
    assert.equal((template.match(/bedrock-agentcore:InvokeAgentRuntime/g) ?? []).length, 1);
  } finally {
    dispose();
  }
});

test("a workflow's invokeAgent step calls the Runtime with the workflow's role, granted on that Runtime only", () => {
  const { toolId, agentId, dispose } = fixtures();
  const invokeStep = invokeAgent as unknown as (agent: string, input: unknown) => Flow<unknown>;
  try {
    const base = config(toolId, agentId);
    const framework = defineFrameworkConfig({
      defaults,
      http: [],
      webSocket: [],
      events: [],
      services: [],
      tools: [{ [toolId]: { directory: `/lambda_functions/tool_functions/${toolId}`, deploy: "both" } }],
      agents: [{ [agentId]: base.agents![agentId]! }],
      workflows: [
        {
          review: workflow<{ caseId: string }>(({ input }) => invokeStep(agentId, { caseId: input.caseId }), {
            timeoutSeconds: 600,
          }),
        },
      ],
    });

    const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
    initializeFrameworkResources(app, { config: framework, mode: "prod", deployment: "agentcore-test", readers: { env: {} } });
    const identity = new cdk.Stack(app, "Identity", { env });
    const userPool = new cognito.UserPool(identity, "Pool");
    const stack = new OrchestrationStack(app, "WorkflowsStack", {
      env,
      config: framework,
      mode: "prod",
      cognito: { userPool, userPoolClient: userPool.addClient("Client") },
      tools: manifest(toolId),
    });
    finalizeFrameworkResources(app);
    app.synth();

    const template = Template.fromStack(stack).toJSON() as TemplateJson & { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    const [machineId, machine] = Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::StepFunctions::StateMachine")!;
    const definition = JSON.stringify(machine.Properties.DefinitionString);
    assert.match(definition, /arn:aws:states:::aws-sdk:bedrockagentcore:invokeAgentRuntime/);
    // The state machine and the Runtime share the stack: a reference, not an import.
    const runtimeId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === "AWS::BedrockAgentCore::Runtime")!;
    const graph = resourceGraph(template);
    assert.ok(reaches(graph, machineId, runtimeId));
    assert.equal(findCycle(graph), undefined);
    assert.doesNotMatch(definition, /Fn::ImportValue/);

    const statements = Object.values(template.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy")
      .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement);
    const invoke = statements.filter((statement) => JSON.stringify(statement.Action).includes("bedrock-agentcore:InvokeAgentRuntime"));
    assert.equal(invoke.length, 1, "one grant, for the one Runtime the graph names");
    const resources = JSON.stringify(invoke[0].Resource);
    assert.match(resources, /AgentRuntimeArn/, "scoped to the Runtime's own ARN, not a wildcard");
    assert.doesNotMatch(resources, /runtime\/\*"/);
    assert.doesNotMatch(JSON.stringify(invoke[0].Action), /ForUser/);
  } finally {
    dispose();
  }
});
