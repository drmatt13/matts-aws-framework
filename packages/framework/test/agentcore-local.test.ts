import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { defineFrameworkConfig, invokesAgent, type FrameworkConfig } from "../src/config/index";
import { localInvocationDescriptors } from "../src/local/invocation";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { parseAgentDescriptor } from "../src/runtime/descriptor";
import { findRepositoryRoot } from "../src/config/source";
import { LocalLambdaExecutor } from "../src/local/index";
import { handleLocalGatewayRequest, type GatewayToolManifest, type LocalToolInvoker } from "../src/local/agentcore";
import { loadToolManifest } from "../src/local/agentcore-contracts";
import { IDENTITY_ARGUMENT } from "../src/protocol/agentcore";
import { defaults } from "../../../framework-config/defaults";

const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };
const schema = { type: "object", properties: { message: { type: "string" } }, required: ["message"] } as const;
const manifest: GatewayToolManifest = {
  echo: { description: "Echo.", auth: false, inputSchema: schema, outputSchema: schema },
  whoami: { description: "Who am I.", auth: true, inputSchema: { type: "object" }, outputSchema: schema },
  other: { description: "Not this agent's.", auth: false, inputSchema: schema, outputSchema: schema },
};

const config = (): FrameworkConfig =>
  defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ echo: {}, whoami: { auth: true, environment: cognito }, other: {} }],
    agents: [{ "support-agent": { auth: true, tools: ["echo", "whoami"], environment: cognito } }],
  });

const rpc = (method: string, params?: unknown, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const notification = (method: string) => ({ jsonrpc: "2.0", method });

test("the emulator lists exactly the agent's tools, under Gateway's names and schemas", async () => {
  const invoker: LocalToolInvoker = { invoke: async () => ({}) };
  const reply = (await handleLocalGatewayRequest(config(), invoker, "support-agent", rpc("tools/list"), manifest)) as {
    result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
  };
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), ["echo___echo", "whoami___whoami"]);
  // A user tool lists the identity argument, as its deployed target does, so
  // Gateway carries it through; the agent hides it from the model.
  assert.ok(IDENTITY_ARGUMENT in (reply.result.tools[1].inputSchema.properties ?? {}));
  assert.equal(
    await handleLocalGatewayRequest(config(), invoker, "support-agent", notification("notifications/initialized"), manifest),
    undefined,
  );
  const initialized = (await handleLocalGatewayRequest(config(), invoker, "support-agent", rpc("initialize", {}), manifest)) as {
    result: { protocolVersion: string };
  };
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
});

test("a call reaches the tool as Gateway invokes a Lambda target, and failures come back as tool errors", async () => {
  const seen: { target: string; event: unknown; context: unknown }[] = [];
  const invoker: LocalToolInvoker = {
    invoke: async (target, event, context) => {
      seen.push({ target, event, context });
      if ((event as { message?: string }).message === "fail") {
        throw Object.assign(new Error("Invalid arguments. message: Required"), { name: "ToolInputError" });
      }
      return { message: "ok" };
    },
  };
  const reply = await handleLocalGatewayRequest(
    config(),
    invoker,
    "support-agent",
    rpc("tools/call", { name: "echo___echo", arguments: { message: "hi" } }, 7),
    manifest,
  );
  assert.deepEqual(reply, {
    jsonrpc: "2.0",
    id: 7,
    result: { isError: false, structuredContent: { message: "ok" }, content: [{ type: "text", text: '{"message":"ok"}' }] },
  });
  assert.equal(seen[0].target, "lambda:echo");
  assert.deepEqual(seen[0].event, { message: "hi" });
  const custom = (seen[0].context as { clientContext: { custom: Record<string, string> } }).clientContext.custom;
  assert.equal(custom.bedrockAgentCoreToolName, "echo___echo");
  assert.equal(custom.bedrockAgentCoreMcpMessageId, "7");
  assert.equal(custom.bedrockAgentCoreMessageVersion, "1.0");

  const failed = (await handleLocalGatewayRequest(
    config(),
    invoker,
    "support-agent",
    rpc("tools/call", { name: "echo___echo", arguments: { message: "fail" } }),
    manifest,
  )) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, "Invalid arguments. message: Required");

  const undeclared = (await handleLocalGatewayRequest(
    config(),
    invoker,
    "support-agent",
    rpc("tools/call", { name: "other___other", arguments: {} }),
    manifest,
  )) as { error: { code: number } };
  assert.equal(undeclared.error.code, -32602);
});

test("a local agent gets no database URL, as its Runtime gets none: tools touch data", async () => {
  const root = findRepositoryRoot(__dirname);
  const environment = await resolveLocalWorkloadEnvironment(config(), "agent:support-agent", { repositoryRoot: root });
  assert.equal(environment.PRIMARY_DATABASE_URL, undefined);
  const tool = await resolveLocalWorkloadEnvironment(config(), "lambda:echo", { repositoryRoot: root });
  assert.ok(tool.PRIMARY_DATABASE_URL, "a tool is a Lambda, and gets the local database like any other");
});

test("a caller's local invokesAgent descriptor is one the runtime reads", () => {
  const caller = defineFrameworkConfig({
    defaults,
    http: [
      {
        "/ask": {
          directory: "/lambda_functions/http_functions/ask",
          methods: ["POST"],
          auth: true,
          cloud: { bindings: [invokesAgent("support-agent")] },
        },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ echo: {}, whoami: { auth: true, environment: cognito } }],
    agents: [{ "support-agent": { auth: true, tools: ["echo", "whoami"], environment: cognito } }],
  });
  const descriptors = localInvocationDescriptors(caller, "lambda:ask", "http://runner:8090/");
  assert.deepEqual(parseAgentDescriptor(descriptors.FRAMEWORK_AGENT_SUPPORT_AGENT, "support-agent"), {
    version: 1,
    kind: "agent",
    transport: "local",
    target: "support-agent",
    auth: true,
    runnerUrl: "http://runner:8090",
    caller: "lambda:ask",
  });
});

test("locally, a tool's contract is read live: an edited description is what the next call lists", async () => {
  const root = findRepositoryRoot(__dirname);
  const id = `live-contract-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", id);
  mkdirSync(directory, { recursive: true });
  const contract = (description: string) =>
    `import { z } from "zod";\nexport const contract = { description: ${JSON.stringify(description)}, request: z.object({ q: z.string() }), response: z.object({ a: z.string() }) };\n`;
  writeFileSync(path.join(directory, "index.ts"), "export const lambdaHandler = async () => ({});");
  writeFileSync(path.join(directory, "contract.ts"), contract("First wording."));
  const probe = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ [id]: { directory: `/lambda_functions/tool_functions/${id}` } }],
  });
  try {
    assert.equal((await loadToolManifest(probe, root))[id].description, "First wording.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(path.join(directory, "contract.ts"), contract("Second wording."));
    assert.equal((await loadToolManifest(probe, root))[id].description, "Second wording.");
    assert.deepEqual((await loadToolManifest(probe, root))[id].inputSchema, {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("through the real local executor, a tool receives the argument map and Gateway's client context", async () => {
  const root = findRepositoryRoot(__dirname);
  const id = `gateway-probe-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, "cdk-app", "lambda_functions", "tool_functions", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "index.ts"),
    "export async function lambdaHandler(event: unknown, context: { clientContext?: { custom?: unknown } }) { return { event, custom: context.clientContext?.custom }; }",
  );
  const probe = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ [id]: { directory: `/lambda_functions/tool_functions/${id}` } }],
    agents: [{ probe: { tools: [id] } }],
  });
  const executor = new LocalLambdaExecutor({ config: probe, repositoryRoot: root, pool: null });
  try {
    const reply = (await handleLocalGatewayRequest(
      probe,
      executor,
      "probe",
      rpc("tools/call", { name: `${id}___${id}`, arguments: { message: "hi" } }),
      { [id]: { description: "Probe.", auth: false, inputSchema: schema, outputSchema: { type: "object" } } },
    )) as { result: { structuredContent: { event: unknown; custom: Record<string, string> } } };
    assert.deepEqual(reply.result.structuredContent.event, { message: "hi" });
    assert.equal(reply.result.structuredContent.custom.bedrockAgentCoreToolName, `${id}___${id}`);
  } finally {
    executor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
