import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import {
  attempt,
  defineFrameworkConfig,
  invokeAgent as invokeAgentStepBuilder,
  invokesAgent,
  sequence,
  succeed,
  transform,
  workflow,
  WORKFLOW_ERROR_NAMES,
  type Flow,
} from "@repo/framework/config";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { LocalLambdaExecutor, loadToolManifest, localInvocationDescriptors } from "@repo/framework/local";
import { invokeAgent } from "@repo/framework/runtime/agentcore";
import { withInvocationEnvironment } from "../../packages/framework/src/runtime/context";
import { defaults } from "../../framework-config/defaults";
import { registerAgentRoutes } from "../src/agent-routes";
import { LocalAgentSupervisor } from "../src/agents";
import { LocalWorkflowEngine } from "../src/workflows";

/**
 * The local lane end to end, with nothing stubbed: a workload's invokeAgent,
 * the runner's agent route, a session process serving a real agent module, the
 * agent's tools.call through the emulated Gateway, and the tool's real handler
 * in a Lambda child process — validated by its contract on the way in and out.
 */
test("a workload invokes an agent, which calls a tool through its emulated Gateway, entirely locally", async () => {
  const root = findRepositoryRoot(__dirname);
  const suffix = randomUUID().slice(0, 8);
  const toolId = `lookup-${suffix}`;
  const agentId = `assistant-${suffix}`;
  const toolDirectory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", toolId);
  const agentDirectory = path.join(root, "agentcore", agentId);
  mkdirSync(toolDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    path.join(toolDirectory, "contract.ts"),
    [
      'import { z } from "zod";',
      "export const contract = {",
      '  description: "Look up a number.",',
      "  request: z.object({ n: z.number().int() }),",
      "  response: z.object({ doubled: z.number().int() }),",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    path.join(toolDirectory, "index.ts"),
    [
      'import { tool } from "@repo/framework/runtime/tools";',
      'import { contract } from "./contract";',
      "export const lambdaHandler = tool(contract, async (input) => ({ doubled: input.n * 2 }));",
    ].join("\n"),
  );
  writeFileSync(
    path.join(agentDirectory, "index.ts"),
    [
      'import { z } from "zod";',
      'import { agent } from "@repo/framework/runtime/agentcore";',
      `export const handler = agent(${JSON.stringify(agentId)}, { request: z.object({ n: z.number() }), response: z.object({ answer: z.number(), tools: z.array(z.string()) }) })`,
      "  .respond(async (input, { tools }) => {",
      `    const result = (await tools.call(${JSON.stringify(toolId)}, { n: input.n })) as { doubled: number };`,
      "    return { answer: result.doubled, tools: tools.specs.map((spec) => spec.name) };",
      "  });",
    ].join("\n"),
  );

  const config = defineFrameworkConfig({
    defaults,
    http: [
      {
        "/ask": {
          directory: "/lambda_functions/http_functions/test-run-task",
          id: "ask",
          methods: ["POST"],
          deploy: "local-only",
          cloud: { bindings: [invokesAgent(agentId)] },
        },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ [toolId]: { directory: `/lambda_functions/tool_functions/${toolId}`, deploy: "local-only" } }],
    agents: [{ [agentId]: { directory: `/agentcore/${agentId}`, tools: [toolId], deploy: "local-only" } }],
  });

  const app = express();
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const runnerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executor = new LocalLambdaExecutor({ config, repositoryRoot: root, runnerUrl, pool: null });
  const supervisor = new LocalAgentSupervisor(config, root, runnerUrl);
  registerAgentRoutes(app, {
    config,
    agents: supervisor,
    tools: executor,
    loadTools: () => loadToolManifest(config, root),
  });

  try {
    const descriptors = localInvocationDescriptors(config, "lambda:ask", runnerUrl);
    const invoke = invokeAgent as unknown as (id: string, input: unknown, options: { conversationId: string; timeoutMs: number }) => Promise<unknown>;
    const result = await withInvocationEnvironment(descriptors, () =>
      invoke(agentId, { n: 21 }, { conversationId: "e2e-1", timeoutMs: 60_000 }),
    );
    assert.deepEqual(result, { answer: 42, tools: [toolId] });

    // A refused argument reaches the agent as a tool error naming the field.
    const refused = await withInvocationEnvironment(descriptors, () =>
      invoke(agentId, { n: 1.5 }, { conversationId: "e2e-2", timeoutMs: 60_000 }),
    ).catch((error: Error) => error);
    assert.ok(refused instanceof Error, "the agent's call failed, so its invocation fails");
  } finally {
    supervisor.close();
    executor.close();
    server.close();
    rmSync(toolDirectory, { recursive: true, force: true });
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

/**
 * `invokeAgent` as a workflow step, through the runner's own engine: the graph
 * calls a real agent session process twice — the second call reading the
 * first's result — the agent calls its tool through the emulated Gateway, and
 * an agent failure arrives under the name Step Functions gives it.
 */
test("a workflow step invokes an agent and reads its result, entirely locally", async () => {
  const root = findRepositoryRoot(__dirname);
  const suffix = randomUUID().slice(0, 8);
  const toolId = `double-${suffix}`;
  const agentId = `analyst-${suffix}`;
  const toolDirectory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", toolId);
  const agentDirectory = path.join(root, "agentcore", agentId);
  mkdirSync(toolDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    path.join(toolDirectory, "contract.ts"),
    [
      'import { z } from "zod";',
      "export const contract = {",
      '  description: "Double a whole number.",',
      "  request: z.object({ n: z.number().int() }),",
      "  response: z.object({ doubled: z.number().int() }),",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    path.join(toolDirectory, "index.ts"),
    [
      'import { tool } from "@repo/framework/runtime/tools";',
      'import { contract } from "./contract";',
      "export const lambdaHandler = tool(contract, async (input) => ({ doubled: input.n * 2 }));",
    ].join("\n"),
  );
  writeFileSync(
    path.join(agentDirectory, "index.ts"),
    [
      'import { z } from "zod";',
      'import { agent } from "@repo/framework/runtime/agentcore";',
      `export const handler = agent(${JSON.stringify(agentId)}, { request: z.object({ n: z.number() }), response: z.object({ answer: z.number(), conversationId: z.string() }) })`,
      "  .respond(async (input, { tools, conversationId }) => {",
      `    const result = (await tools.call(${JSON.stringify(toolId)}, { n: input.n })) as { doubled: number };`,
      "    return { answer: result.doubled, conversationId };",
      "  });",
    ].join("\n"),
  );

  const step = invokeAgentStepBuilder as unknown as <Out>(agent: string, input: unknown) => Flow<Out>;
  const config = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ [toolId]: { directory: `/lambda_functions/tool_functions/${toolId}`, deploy: "local-only" } }],
    agents: [{ [agentId]: { directory: `/agentcore/${agentId}`, tools: [toolId], deploy: "local-only" } }],
    workflows: [
      {
        "agent-chain": workflow<{ n: number }>(
          ({ input }) => {
            const first = step<{ answer: number; conversationId: string }>(agentId, { n: input.n });
            const second = step<{ answer: number; conversationId: string }>(agentId, { n: first.output.answer });
            return sequence(first, second, transform({ first: first.output, second: second.output }));
          },
          { deploy: "local-only", timeoutSeconds: 120 },
        ),
        "agent-failure": workflow(
          () =>
            attempt(step(agentId, { n: 1.5 }), (error) => succeed({ caught: error.error }), {
              on: [WORKFLOW_ERROR_NAMES.agentFailed],
            }),
          { deploy: "local-only", timeoutSeconds: 120 },
        ),
      },
    ],
  });

  const app = express();
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const runnerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executor = new LocalLambdaExecutor({ config, repositoryRoot: root, runnerUrl, pool: null });
  const supervisor = new LocalAgentSupervisor(config, root, runnerUrl);
  registerAgentRoutes(app, { config, agents: supervisor, tools: executor, loadTools: () => loadToolManifest(config, root) });
  const engine = new LocalWorkflowEngine({
    config,
    repositoryRoot: root,
    runnerUrl,
    tasks: {
      submit: () => {
        throw new Error("no tasks here");
      },
      wait: async () => ({ runId: "none" }),
      stop: async () => undefined,
    },
    agents: supervisor,
  });
  const settled = async (id: string, input: unknown) => {
    const execution = engine.start(id, input);
    const deadline = Date.now() + 90_000;
    while (execution.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return execution;
  };

  try {
    const chain = await settled("agent-chain", { n: 5 });
    assert.equal(chain.status, "succeeded", JSON.stringify(chain.error));
    const output = chain.output as { first: { answer: number; conversationId: string }; second: { answer: number; conversationId: string } };
    assert.equal(output.first.answer, 10);
    assert.equal(output.second.answer, 20, "the second call read the first's result");
    assert.equal(output.second.conversationId, output.first.conversationId, "one conversation per execution");
    assert.match(output.first.conversationId, /^[0-9a-f]{64}$/);

    const failure = await settled("agent-failure", {});
    assert.equal(failure.status, "succeeded", JSON.stringify(failure.error));
    assert.deepEqual(failure.output, { caught: "BedrockAgentCore.RuntimeClientErrorException" });
  } finally {
    supervisor.close();
    executor.close();
    server.close();
    rmSync(toolDirectory, { recursive: true, force: true });
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});
