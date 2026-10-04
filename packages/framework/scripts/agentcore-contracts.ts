import { compile, type JSONSchema } from "json-schema-to-typescript";
import type { AgentContractFacts, JsonSchemaDocument, ToolContractFacts } from "../src/local/agentcore-contracts";

export {
  readAgentContract,
  readToolContract,
  type AgentContractFacts,
  type ToolContractFacts,
} from "../src/local/agentcore-contracts";

/**
 * Tool and agent contracts, projected once for everything that consumes them.
 *
 * A contract is the Zod module beside a tool or agent. Generation is the one
 * build step that *evaluates* a contract module rather than reading it as a
 * syntax tree, and only after `readContractModule` has proved it imports
 * nothing but Zod: a contained contract can build schemas and nothing else,
 * while a handler is still never imported. Evaluation is what turns a Zod
 * schema into the JSON Schema Gateway needs; there is no other way to read one.
 *
 * The output is `packages/framework/src/generated/agentcore.ts`: the schema each
 * tool's Gateway target lists in AWS, which tools each agent may call, and the
 * TypeScript types `tools.call` and `invokeAgent` are checked against. Because
 * it is committed, a change to what the model reads — a description, a field —
 * is a reviewable diff. The local lane reads the same contracts live instead
 * (see `src/local/agentcore-contracts`), and framework:check keeps the two equal.
 */

/**
 * What the browser package says about agents with users: the route each is
 * streamed from, and the contract module that types it — the one copied into
 * `@repo/api-contract` beside every other payload contract.
 */
export function agentRouteDeclarations(agents: readonly { readonly id: string; readonly path: string }[]): {
  readonly imports: readonly string[];
  readonly body: string;
} {
  const sorted = [...agents].sort((left, right) => left.id.localeCompare(right.id));
  const namespace = (id: string) => `agent${pascal(id)}`;
  return {
    imports: sorted.map(({ id }) => `import type * as ${namespace(id)} from "./contracts/agent-${id}";`),
    body: [
      "/** Explicit full same-origin agent paths. No /api prefix is added. */",
      "export const AGENT_ROUTE = {",
      ...sorted.map(({ id, path }) => `  ${JSON.stringify(id)}: ${JSON.stringify(path)},`),
      "} as const;",
      "",
      "/** What each of those agents accepts and answers, from its contract. */",
      "export interface AgentEndpoints {",
      ...sorted.map(({ id }) => `  ${JSON.stringify(id)}: typeof ${namespace(id)}.contract;`),
      "}",
    ].join("\n"),
  };
}

/**
 * A workflow step's result is one document, so an `invokeAgent` step needs an
 * agent with a `response` contract. Whether an agent streams is a fact of its
 * contract, evaluated during generation and nowhere earlier, so this is where a
 * step naming a streaming agent is refused.
 */
export function assertWorkflowAgentsRespond(
  workflows: readonly { readonly origin: string; readonly targets: readonly string[] }[],
  agents: readonly AgentContractFacts[],
): void {
  for (const workflow of workflows) {
    for (const reference of workflow.targets) {
      const agent = agents.find((candidate) => `agent:${candidate.id}` === reference);
      if (agent?.streaming) {
        throw new Error(
          `${workflow.origin} invokeAgent("${agent.id}") calls an agent whose contract streams events, and a workflow step needs one response. Give the agent a response contract instead of an event one.`,
        );
      }
    }
  }
}

/** `lookup-case` → `LookupCase`, for generated type names. */
function pascal(id: string): string {
  return id
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

async function declaration(schema: JsonSchemaDocument, name: string): Promise<string> {
  return (
    await compile(schema as JSONSchema, name, {
      bannerComment: "",
      additionalProperties: false,
      declareExternallyReferenced: true,
      format: true,
    })
  ).trim();
}

export async function agentCoreModule(
  tools: readonly ToolContractFacts[],
  agents: readonly AgentContractFacts[],
): Promise<string> {
  const sortedTools = [...tools].sort((left, right) => left.id.localeCompare(right.id));
  const sortedAgents = [...agents].sort((left, right) => left.id.localeCompare(right.id));

  const toolManifest = Object.fromEntries(
    sortedTools.map((tool) => [
      tool.id,
      { description: tool.description, auth: tool.auth, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
    ]),
  );
  const agentManifest = Object.fromEntries(
    sortedAgents.map((agent) => [agent.id, { auth: agent.auth, streaming: agent.streaming, tools: agent.tools }]),
  );

  const declarations: string[] = [];
  for (const tool of sortedTools) {
    declarations.push(await declaration(tool.request, `Tool${pascal(tool.id)}Request`));
    declarations.push(await declaration(tool.response, `Tool${pascal(tool.id)}Response`));
  }
  for (const agent of sortedAgents) {
    declarations.push(await declaration(agent.request, `Agent${pascal(agent.id)}Request`));
    declarations.push(
      await declaration(agent.result, `Agent${pascal(agent.id)}${agent.streaming ? "Event" : "Response"}`),
    );
  }

  const toolEntries = sortedTools.map(
    (tool) =>
      `  ${JSON.stringify(tool.id)}: { request: Tool${pascal(tool.id)}Request; response: Tool${pascal(tool.id)}Response };`,
  );
  const agentEntries = sortedAgents.map((agent) => {
    const toolIds = agent.tools.length > 0 ? agent.tools.map((id) => JSON.stringify(id)).join(" | ") : "never";
    const result = agent.streaming
      ? `event: Agent${pascal(agent.id)}Event`
      : `response: Agent${pascal(agent.id)}Response`;
    return `  ${JSON.stringify(agent.id)}: { tools: ${toolIds}; request: Agent${pascal(agent.id)}Request; ${result} };`;
  });

  return [
    "/* Generated by npm run framework:generate from tool and agent contracts. Do not edit. */",
    "",
    "/**",
    " * What each tool's Gateway target lists in AWS: the model reads these",
    " * descriptions and schemas. Edit the tool's contract.ts and regenerate.",
    " */",
    `export const AGENTCORE_TOOLS = ${JSON.stringify(toolManifest, null, 2)} as const;`,
    "",
    "/** Each agent: whether it has users, whether it streams, and the tools its Gateway holds. */",
    `export const AGENTCORE_AGENTS = ${JSON.stringify(agentManifest, null, 2)} as const;`,
    "",
    ...declarations.flatMap((text) => [text, ""]),
    "/** Tool ids to the types `tools.call` checks a call against. */",
    "export interface AgentCoreTools {",
    ...toolEntries,
    "}",
    "",
    "/** Agent ids to the tools they may call and the types they are invoked with. */",
    "export interface AgentCoreAgents {",
    ...agentEntries,
    "}",
    "",
  ].join("\n");
}
