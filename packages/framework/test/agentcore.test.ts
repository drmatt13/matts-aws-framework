import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  getAgentTools,
  getAgentBrowserRoutes,
  getFrameworkTargets,
  invokesAgent,
  resolveLambdaTarget,
  type FrameworkConfig,
  type FrameworkConfigInput,
  type FrameworkHttp,
} from "../src/config/index";
import { defaults } from "../../../framework-config/defaults";

/** The Cognito inputs a token verifier reads, which `auth: true` requires. */
const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };

const base = {
  defaults: { ...defaults, tools: { timeoutSeconds: 20 } },
  http: [],
  webSocket: [],
  events: [],
  services: [],
} satisfies FrameworkConfigInput;

const tools = {
  "lookup-case": { auth: true, environment: cognito },
  echo: {},
} as const;

const agents = {
  "support-agent": { auth: true, tools: ["lookup-case", "echo"], environment: cognito },
  "summarizer": { tools: ["echo"] },
} as const;

const config = (overrides: Partial<FrameworkConfigInput> = {}): FrameworkConfig =>
  defineFrameworkConfig({ ...base, tools: [tools], agents: [agents], ...overrides });

test("tools and agents take their directories from their ids", () => {
  const targets = new Map(getFrameworkTargets(config()).map((target) => [target.reference, target]));
  assert.equal(targets.get("lambda:lookup-case")?.role, "tool");
  assert.equal(targets.get("lambda:lookup-case")?.directory, "/lambda_functions/tool_functions/lookup-case");
  assert.equal(targets.get("agent:support-agent")?.directory, "/agentcore/support-agent");
});

test("a tool inherits defaults.tools like any other section", () => {
  assert.equal(resolveLambdaTarget(config(), "echo").timeoutSeconds, 20);
});

test("an agent's tools are its derived Gateway, named by tool id alone", () => {
  assert.deepEqual(getAgentTools(config(), "support-agent"), [
    { id: "lookup-case", auth: true, wireName: "lookup-case___lookup-case" },
    { id: "echo", auth: false, wireName: "echo___echo" },
  ]);
  assert.deepEqual(getAgentTools(config(), "summarizer").map((tool) => tool.id), ["echo"]);
});

test("an agent's tool list is checked like any other invocation edge", () => {
  assert.throws(
    () => config({ agents: [{ "support-agent": { auth: true, environment: cognito, tools: ["missing"] } }] }),
    /agents\["support-agent"\] tools\("missing"\) names "lambda:missing", which is not declared/,
  );
  assert.throws(
    () => config({ tools: [{ ...tools, echo: { deploy: "local-only" } }], agents: [{ summarizer: { tools: ["echo"] } }] }),
    /removes from the cloud lane/,
  );
  assert.throws(
    () =>
      config({
        http: [{ "/ping": { directory: "/lambda_functions/http_functions/ping", methods: ["GET"] } }],
        agents: [{ summarizer: { tools: ["ping"] } }],
      }),
    /tools\("ping"\) names an http Lambda\. An agent calls Lambdas declared under tools/,
  );
});

test("a tool that acts as the signed-in user is reachable only from an agent that has one", () => {
  assert.throws(
    () => config({ agents: [{ summarizer: { tools: ["lookup-case"] } }] }),
    /agents\["summarizer"\] lists tools\("lookup-case"\), which declares auth: true\. Only an agent with auth: true has a signed-in user to act as/,
  );
});

test("auth: true needs the Cognito inputs its verifier reads", () => {
  assert.throws(
    () => config({ tools: [{ ...tools, "lookup-case": { auth: true } }] }),
    /tools\["lookup-case"\] declares auth: true without environment USER_POOL_ID, USER_POOL_CLIENT_ID/,
  );
  assert.throws(
    () => config({ agents: [{ ...agents, "support-agent": { auth: true, tools: ["echo"] } }] }),
    /agents\["support-agent"\] declares auth: true without environment USER_POOL_ID, USER_POOL_CLIENT_ID/,
  );
});

test("invokesAgent derives a descriptor, and an agent with users is invoked only on a user's behalf", () => {
  const caller = (auth: boolean): FrameworkHttp => ({
    "/ask": {
      directory: "/lambda_functions/http_functions/ask",
      methods: ["POST" as const],
      ...(auth ? { auth: true as const } : {}),
      cloud: { bindings: [invokesAgent("support-agent")] },
    },
  });
  const ask = getFrameworkTargets(config({ http: [caller(true)] })).find((target) => target.id === "ask");
  assert.deepEqual(ask?.cloud.bindings, [
    { capability: "invokesAgent", agent: "support-agent", environment: "FRAMEWORK_AGENT_SUPPORT_AGENT" },
  ]);
  assert.throws(
    () => config({ http: [caller(false)] }),
    /http\["\/ask"\] cloud\.bindings invokesAgent\("support-agent"\) calls an agent with auth: true from a caller with no signed-in user/,
  );
});

test("agent and tool edges join the cycle check", () => {
  assert.throws(
    () => config({ tools: [{ ...tools, echo: { cloud: { bindings: [invokesAgent("summarizer")] } } }] }),
    /Invocation edges form a cycle: (lambda:echo -> agent:summarizer -> lambda:echo|agent:summarizer -> lambda:echo -> agent:summarizer)/,
  );
});

test("Runtime limits and ownership are refused where they are written", () => {
  assert.throws(
    () => config({ agents: [{ ...agents, summarizer: { tools: ["echo"], cloud: { idleSeconds: 30 } } }] }),
    /agents\["summarizer"\] cloud\.idleSeconds must be a whole number from 60 to 28800/,
  );
  assert.throws(
    () =>
      config({
        agents: [{ ...agents, summarizer: { tools: ["echo"], cloud: { idleSeconds: 900, maxLifetimeSeconds: 600 } } }],
      }),
    /agents\["summarizer"\] cloud\.maxLifetimeSeconds is shorter than cloud\.idleSeconds/,
  );
  assert.throws(
    () => config({ agents: [{ ...agents, summarizer: { tools: ["echo"], secrets: {} } } as never] }),
    /agents\["summarizer"\] declares secrets\. AgentCore Runtime has no startup secret injection/,
  );
});

test("agent browser routes are explicit, keep their full path, and do not change target identity", () => {
  assert.deepEqual(getAgentBrowserRoutes(config()), [], "auth alone does not expose a route");
  const routed = config({ agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route: "/chat/support" } }] });
  assert.deepEqual(getAgentBrowserRoutes(routed), [{ id: "support-agent", path: "/chat/support" }]);
  const target = getFrameworkTargets(routed).find((item) => item.reference === "agent:support-agent")!;
  const original = getFrameworkTargets(config()).find((item) => item.reference === "agent:support-agent")!;
  assert.equal(target.directory, original.directory);
  assert.equal(target.cloud.constructId, original.cloud.constructId);
  // /agents is no longer a globally reserved namespace.
  config({ http: [{ "/agents/report": { directory: "/lambda_functions/http_functions/report", methods: ["GET"] } }] });
});

test("agent browser routes require user auth and an exact literal path", () => {
  assert.throws(() => config({ agents: [{ summarizer: { route: "/chat/summary" } }] }), /agents\["summarizer"\]\.route requires auth: true/);
  for (const route of ["relative", "//chat", "/chat/", "/chat/*", "/chat/:id", "/chat?x=1", "/chat#x", "/chat/../other", "/chat%2fother"]) {
    assert.throws(() => config({ agents: [{ "support-agent": { ...agents["support-agent"], route } } as never] }), /agents\["support-agent"\]\.route/);
  }
});

test("duplicate agent routes name both owners even when one is disabled", () => {
  assert.throws(() => config({ agents: [{
    "support-agent": { ...agents["support-agent"], route: "/chat/support" },
    another: { auth: true, environment: cognito, route: "/chat/support", deploy: "none" },
  }] }), /Browser route collision: agents\["support-agent"\]\.route.*agents\["another"\]\.route.*\/chat\/support/);
});

test("agent routes cannot shadow HTTP paths, even on a different method or deployment lane", () => {
  assert.throws(() => config({
    agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route: "/api/report", deploy: "local-only" } }],
    http: [{ "/report": { directory: "/lambda_functions/http_functions/report", methods: ["GET"], deploy: "cloud-only" } }],
  }), /Browser route collision: agents\["support-agent"\]\.route.*http\["\/report"\].*\/api\/report/);
});

test("service mounts conflict at their root and descendants, but not sibling prefixes", () => {
  const withRoute = (route: `/${string}`) => config({
    agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route } }],
    services: [{ "/chat/*": { directory: "/ecs_containers/services/chat", methods: ["GET"] } }],
  });
  for (const route of ["/api/chat", "/api/chat/support"] as const) {
    assert.throws(() => withRoute(route), /Browser route collision: agents\["support-agent"\]\.route.*services\["\/chat\/\*"\]/);
  }
  withRoute("/api/chatbot");
  // This is a distinct browser path from the HTTP/service path /api/chat/support.
  withRoute("/chat/support");
  assert.throws(() => config({
    agents: [{ "support-agent": { ...agents["support-agent"], route: "/api/anywhere" } }],
    services: [{ "/*": { directory: "/ecs_containers/services/chat", methods: "*" } }],
  }), /Browser route collision/);
});

test("the gateways section is gone, and says where its declarations went", () => {
  assert.throws(
    () => defineFrameworkConfig({ ...base, gateways: [{}] } as never),
    /gateways is no longer a section\. An agent's Gateway is derived from its tools list/,
  );
});
