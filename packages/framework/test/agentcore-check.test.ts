import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig } from "../src/config/index";
import { assertAgentCoreEntries } from "../scripts/check-agentcore";
import { defaults } from "../../../framework-config/defaults";

const cognito = { USER_POOL_ID: "pool", USER_POOL_CLIENT_ID: "client" };
const config = defineFrameworkConfig({
  defaults,
  http: [],
  webSocket: [],
  events: [],
  services: [],
  tools: [{ "lookup-case": { auth: true, environment: cognito }, echo: {} }],
  agents: [{ "support-agent": { auth: true, tools: ["lookup-case", "echo"], environment: cognito } }],
});

const good: Record<string, string> = {
  "lambda:lookup-case": "export const lambdaHandler = authenticatedTool(contract, async (input, session) => ({}));",
  "lambda:echo": "export const lambdaHandler = tool(contract, async (input) => ({}));",
  "agent:support-agent": 'export const handler = agent("support-agent", contract, async () => ({}));',
};
const read = (sources: Record<string, string>) => (reference: string) => sources[reference];

test("each tool and agent entry uses the wrapper its declaration implies", () => {
  assertAgentCoreEntries(config, read(good));

  assert.throws(
    () => assertAgentCoreEntries(config, read({ ...good, "lambda:lookup-case": good["lambda:echo"] })),
    /tools\["lookup-case"\] declares auth: true, but its handler does not use authenticatedTool/,
  );
  assert.throws(
    () => assertAgentCoreEntries(config, read({ ...good, "lambda:echo": good["lambda:lookup-case"] })),
    /tools\["echo"\] uses authenticatedTool, but does not declare auth: true/,
  );
  assert.throws(
    () => assertAgentCoreEntries(config, read({ ...good, "lambda:echo": "export async function lambdaHandler() {}" })),
    /tools\["echo"\]'s handler does not use tool\(\)/,
  );
  assert.throws(
    () =>
      assertAgentCoreEntries(
        config,
        read({ ...good, "agent:support-agent": 'export const handler = agent("other", contract, async () => ({}));' }),
      ),
    /agents\["support-agent"\] exports agent\("other", \.\.\.\)\. The id names the declaration/,
  );
});
