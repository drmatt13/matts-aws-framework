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
  invokeAgent,
  startsWorkflow,
  wait,
  workflow,
  type Flow,
  type FrameworkConfig,
  type FrameworkConfigInput,
} from "@repo/framework/config";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { defaults } from "../../framework-config/defaults";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";
import { hasOrchestrationCloudResources, OrchestrationStack, STACK_RESOURCE_LIMIT } from "../lib/framework/orchestration-stack";
import { findCycle, reaches, resourceGraph, type TemplateJson } from "./support/template-graph";

/**
 * Workflows and agents in the one stack they share: both directions of
 * invocation deploy, the resource graph stays acyclic, a genuine invocation
 * cycle is refused before synthesis, and sharing the stack moves nothing that
 * was already there.
 */

const env = { account: "111122223333", region: "us-east-1" };
const root = findRepositoryRoot(__dirname);
const step = invokeAgent as unknown as (agent: string, input: unknown) => Flow<unknown>;

/** Agents and tools written for the test, each with a source directory, removed afterwards. */
function fixtures(count: number) {
  const suffix = randomUUID().slice(0, 6);
  const ids = Array.from({ length: count }, (_, index) => ({ agent: `agent${index}-${suffix}`, tool: `tool${index}-${suffix}` }));
  const directories: string[] = [];
  for (const { agent, tool } of ids) {
    const toolDirectory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", tool);
    const agentDirectory = path.join(root, "agentcore", agent);
    mkdirSync(toolDirectory, { recursive: true });
    mkdirSync(agentDirectory, { recursive: true });
    writeFileSync(path.join(toolDirectory, "index.ts"), "export const lambdaHandler = async () => ({});");
    writeFileSync(path.join(agentDirectory, "index.ts"), `export const handler = { kind: "framework-agent", id: ${JSON.stringify(agent)} };`);
    directories.push(toolDirectory, agentDirectory);
  }
  const manifest = Object.fromEntries(
    ids.map(({ tool }) => [tool, { description: "Look up.", auth: false, inputSchema: { type: "object" }, outputSchema: { type: "object" } }]),
  );
  return {
    ids,
    manifest,
    dispose: () => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })),
  };
}

const base = { defaults, http: [], webSocket: [], events: [], services: [] } satisfies FrameworkConfigInput;
const intake = { intake: workflow(() => wait({ seconds: 1 }), { timeoutSeconds: 60 }) };

function synthesize(config: FrameworkConfig, manifest: Record<string, unknown>) {
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config, mode: "prod", deployment: "orchestration-test", readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const stack = new OrchestrationStack(app, "WorkflowsStack", {
    env,
    config,
    mode: "prod",
    cognito: { userPool, userPoolClient: userPool.addClient("Client") },
    tools: manifest as never,
  });
  finalizeFrameworkResources(app);
  // Synthesizing the whole app is what refuses a cycle between stacks.
  app.synth();
  return { app, stack, template: Template.fromStack(stack).toJSON() as TemplateJson & { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> } };
}

function logicalId(template: TemplateJson, type: string, includes: string): string {
  const found = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === type && id.includes(includes));
  assert.equal(found.length, 1, `exactly one ${type} whose logical id includes ${includes}: ${found.map(([id]) => id).join(", ")}`);
  return found[0][0];
}

test("a workflow invokes an agent whose tool and Runtime start another workflow, in one acyclic stack", () => {
  const { ids, manifest, dispose } = fixtures(1);
  const [{ agent, tool }] = ids;
  try {
    const config = defineFrameworkConfig({
      ...base,
      tools: [{ [tool]: { cloud: { bindings: [startsWorkflow("intake")] } } }],
      agents: [{ [agent]: { tools: [tool], cloud: { bindings: [startsWorkflow("intake")] } } }],
      workflows: [{ ...intake, review: workflow(() => step(agent, { caseId: "x" }), { timeoutSeconds: 600 }) }],
    });
    const { app, template } = synthesize(config, manifest);
    assert.equal(app.node.findAll().filter((construct) => construct instanceof cdk.Stack).length, 2, "Identity, and one orchestration stack");

    const review = logicalId(template, "AWS::StepFunctions::StateMachine", "Review");
    const intakeMachine = logicalId(template, "AWS::StepFunctions::StateMachine", "Intake");
    const runtime = logicalId(template, "AWS::BedrockAgentCore::Runtime", "Agent0");
    const toolFunction = logicalId(template, "AWS::Lambda::Function", "Tool0");
    const graph = resourceGraph(template);

    // Workflow -> agent: the definition names the Runtime.
    assert.ok(reaches(graph, review, runtime));
    // Agent -> workflow, both ways a Runtime reaches one: its own environment, and its tool's.
    assert.ok(graph.get(runtime)!.has(intakeMachine), "the Runtime's descriptor names the started workflow");
    assert.ok(graph.get(toolFunction)!.has(intakeMachine), "the tool's descriptor names the started workflow");
    assert.ok(reaches(graph, review, intakeMachine), "the chain workflow -> agent -> tool -> workflow is ordered");
    assert.ok(!reaches(graph, intakeMachine, runtime), "and runs one way");
    // Every role, policy, Gateway and custom resource included: CloudFormation can order it.
    assert.equal(findCycle(graph), undefined);

    // Each grant names its one destination.
    const statements = Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === "AWS::IAM::Policy")
      .flatMap(([id, resource]) =>
        (resource.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.map((statement) => ({ id, statement })),
      );
    // (The MMDSv2 provider's own waiter is started by CDK's provider framework,
    // on that waiter only; it is not one of these.)
    const starters = statements.filter(
      ({ statement }) => JSON.stringify(statement.Action).includes("states:StartExecution") && JSON.stringify(statement.Resource).includes(intakeMachine),
    );
    assert.deepEqual(
      starters.map(({ id }) => (id.startsWith("AgentCoreTools") ? "tool" : id.startsWith("AgentCoreRuntimes") ? "runtime" : id)).sort(),
      ["runtime", "tool"],
      "the tool and the Runtime may each start the workflow, and nothing else may",
    );
    for (const { statement } of starters) assert.deepEqual(statement.Resource, { Ref: intakeMachine });
    const invokers = statements.filter(({ statement }) => JSON.stringify(statement.Action).includes("bedrock-agentcore:InvokeAgentRuntime"));
    assert.equal(invokers.length, 1);
    assert.match(JSON.stringify(invokers[0].statement.Resource), new RegExp(`${runtime}.*AgentRuntimeArn`));
  } finally {
    dispose();
  }
});

test("a genuine invocation cycle is still refused, naming the edges that form it", () => {
  const { ids, dispose } = fixtures(1);
  const [{ agent, tool }] = ids;
  try {
    assert.throws(
      () =>
        defineFrameworkConfig({
          ...base,
          tools: [{ [tool]: { cloud: { bindings: [startsWorkflow("review")] } } }],
          agents: [{ [agent]: { tools: [tool] } }],
          workflows: [{ review: workflow(() => step(agent, {}), { timeoutSeconds: 600 }) }],
        }),
      (error: Error) => {
        assert.match(error.message, /^Invocation edges form a cycle: /);
        for (const edge of ["workflow:review", `agent:${agent}`, `lambda:${tool}`]) assert.ok(error.message.includes(edge), edge);
        return true;
      },
    );
    // An agent starting the workflow that invokes it, directly, is the same cycle.
    assert.throws(
      () =>
        defineFrameworkConfig({
          ...base,
          agents: [{ [agent]: { cloud: { bindings: [startsWorkflow("review")] } } }],
          workflows: [{ review: workflow(() => step(agent, {}), { timeoutSeconds: 600 }) }],
        }),
      /Invocation edges form a cycle: .*workflow:review.*agent:/,
    );
  } finally {
    dispose();
  }
});

test("what shares the stack cannot collide in it", () => {
  const { ids, dispose } = fixtures(1);
  const [{ agent, tool }] = ids;
  try {
    assert.throws(
      () => defineFrameworkConfig({ ...base, workflows: [{ "agent-core": workflow(() => wait({ seconds: 1 }), { timeoutSeconds: 60 }) }] }),
      /workflows\["agent-core"\] resolves to construct id "AgentCore"/,
    );
    assert.throws(
      () =>
        defineFrameworkConfig({
          ...base,
          tools: [{ [tool]: { cloud: { outputs: { arn: { id: "ReviewArn" } } } } }],
          agents: [{ [agent]: { tools: [tool], cloud: { outputs: { arn: { id: "ReviewArn" } } } } }],
        }),
      /both declare the output id "ReviewArn"/,
    );
  } finally {
    dispose();
  }
});

test("adding agents moves no workflow: its role, log group and state machine keep their logical ids", () => {
  const { ids, manifest, dispose } = fixtures(1);
  const [{ agent, tool }] = ids;
  try {
    const workflowsOnly = synthesize(defineFrameworkConfig({ ...base, workflows: [intake] }), {}).template;
    const withAgents = synthesize(
      defineFrameworkConfig({ ...base, tools: [{ [tool]: {} }], agents: [{ [agent]: { tools: [tool] } }], workflows: [intake] }),
      manifest,
    ).template;
    const workflowIds = (template: TemplateJson) =>
      Object.keys(template.Resources).filter((id) => id.startsWith("Intake")).sort();
    assert.deepEqual(workflowIds(withAgents), workflowIds(workflowsOnly));
    assert.ok(workflowIds(workflowsOnly).length >= 4, "role, policy, log group and state machine");
    // AgentCore's own resources all live under its construct.
    for (const [id, resource] of Object.entries(withAgents.Resources)) {
      if (resource.Type.startsWith("AWS::BedrockAgentCore::")) assert.ok(id.startsWith("AgentCore"), id);
    }
  } finally {
    dispose();
  }
});

test("one MMDSv2 provider serves every Runtime, each granted that Runtime alone", () => {
  const { ids, manifest, dispose } = fixtures(2);
  try {
    const { template } = synthesize(
      defineFrameworkConfig({
        ...base,
        tools: [Object.fromEntries(ids.map(({ tool }) => [tool, {}]))],
        agents: [Object.fromEntries(ids.map(({ agent, tool }) => [agent, { tools: [tool] }]))],
      }),
      manifest,
    );
    const runtimes = Object.keys(template.Resources).filter((id) => template.Resources[id].Type === "AWS::BedrockAgentCore::Runtime");
    assert.equal(runtimes.length, 2);
    assert.equal(Object.values(template.Resources).filter((resource) => resource.Type === "AWS::CloudFormation::CustomResource").length, 2);
    assert.equal(
      Object.values(template.Resources).filter((resource) => resource.Type === "AWS::StepFunctions::StateMachine").length,
      1,
      "the provider's one waiter, not one per agent",
    );

    const handlerPolicy = Object.entries(template.Resources).find(
      ([id, resource]) => resource.Type === "AWS::IAM::Policy" && id.startsWith("AgentCoreRuntimeMetadataHandler"),
    )!;
    const statements = (handlerPolicy[1].Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement;
    const resources = JSON.stringify(statements.map((statement) => statement.Resource));
    for (const runtime of runtimes) assert.ok(resources.includes(runtime), `the handler may update ${runtime}`);
    assert.doesNotMatch(resources, /"\*"|runtime\/\*/, "and nothing it was not given");
    const passRole = statements.filter((statement) => JSON.stringify(statement.Action).includes("iam:PassRole"));
    assert.equal(passRole.length, 2, "one pass per Runtime's own execution role");
  } finally {
    dispose();
  }
});

test("each agent costs a fixed number of resources, and the stack refuses to outgrow CloudFormation's quota", () => {
  const { ids, manifest, dispose } = fixtures(2);
  try {
    const count = (agents: number) => {
      const used = ids.slice(0, agents);
      const { template } = synthesize(
        defineFrameworkConfig({
          ...base,
          tools: [Object.fromEntries(used.map(({ tool }) => [tool, {}]))],
          agents: [Object.fromEntries(used.map(({ agent, tool }) => [agent, { tools: [tool] }]))],
          workflows: [{ ...intake, ...Object.fromEntries(used.map(({ agent }) => [`call-${agent}`, workflow(() => step(agent, {}), { timeoutSeconds: 60 })])) }],
        }),
        manifest,
      );
      return Object.keys(template.Resources).length;
    };
    const one = count(1);
    const two = count(2);
    // An agent with its Gateway and MMDSv2 patch (8), its tool (3 — no policy
    // until it is granted something), and a workflow calling it (4).
    assert.equal(two - one, 15);
    // The shared provider (23) and the intake workflow (4) are paid once.
    assert.equal(one, 15 + 23 + 4);
  } finally {
    dispose();
  }

  const app = new cdk.App();
  const config = defineFrameworkConfig({ ...base, workflows: [intake] });
  initializeFrameworkResources(app, { config, mode: "prod", deployment: "orchestration-test", readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const stack = new OrchestrationStack(app, "WorkflowsStack", { env, config, mode: "prod", cognito: { userPool, userPoolClient: userPool.addClient("Client") } });
  for (let index = 0; index < STACK_RESOURCE_LIMIT; index++) {
    new cdk.CfnResource(stack, `Filler${index}`, { type: "AWS::SNS::Topic" });
  }
  finalizeFrameworkResources(app);
  assert.throws(() => app.synth(), /over CloudFormation's 500 per stack/);
});

test("a dev deployment builds no orchestration stack: workflows and agents run locally", () => {
  const { ids, dispose } = fixtures(1);
  const [{ agent, tool }] = ids;
  try {
    const config = defineFrameworkConfig({ ...base, tools: [{ [tool]: {} }], agents: [{ [agent]: { tools: [tool] } }], workflows: [intake] });
    assert.equal(hasOrchestrationCloudResources(config, "dev"), false);
    assert.equal(hasOrchestrationCloudResources(config, "prod"), true);
    assert.equal(hasOrchestrationCloudResources(defineFrameworkConfig({ ...base, workflows: [intake] }), "prod"), true);
    assert.equal(hasOrchestrationCloudResources(defineFrameworkConfig(base), "prod"), false);
  } finally {
    dispose();
  }
});
