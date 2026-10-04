import { once } from "node:events";
import type { Server } from "node:http";
import { AGENTCORE_AGENTS, AGENTCORE_TOOLS } from "../generated/agentcore";
import {
  createAgentServer,
  type AgentToolSpec,
  type DefinedAgent,
  type GatewayDescriptor,
} from "./agentcore";

/**
 * Starting an agent's adapter, in AgentCore Runtime or in a local session
 * process.
 *
 * Both lanes describe the adapter in one environment variable: which agent this
 * is, whether it has users, and where its Gateway answers. In AWS the tools come
 * from the generated projection bundled with the agent — the same schemas its
 * Gateway targets registered. Locally the runner supplies them read live from
 * source, so an edited tool description reaches the next session without a
 * generate step.
 */
export const ADAPTER_ENVIRONMENT = "FRAMEWORK_AGENTCORE_ADAPTER";

export interface AdapterSettings {
  readonly agent: string;
  readonly auth: boolean;
  readonly gateway?: GatewayDescriptor;
  readonly tools?: readonly AgentToolSpec[];
}

function readSettings(): AdapterSettings {
  const raw = process.env[ADAPTER_ENVIRONMENT];
  if (!raw) {
    throw new Error(`${ADAPTER_ENVIRONMENT} is not set. An agent is started by the framework, not directly.`);
  }
  return JSON.parse(raw) as AdapterSettings;
}

function generatedToolSpecs(agentId: string): readonly AgentToolSpec[] {
  const agent = (AGENTCORE_AGENTS as Readonly<Record<string, { readonly tools: readonly string[] }>>)[agentId];
  if (!agent) throw new Error(`agent:${agentId} has no generated projection. Run npm run framework:generate.`);
  const tools = AGENTCORE_TOOLS as Readonly<Record<string, Omit<AgentToolSpec, "id" | "wireName"> & { readonly auth: boolean }>>;
  return agent.tools.map((id) => ({
    id,
    auth: tools[id].auth,
    wireName: `${id}___${id}`,
    description: tools[id].description,
    inputSchema: tools[id].inputSchema,
  }));
}

/** Serves the module's `handler` on `port` (AgentCore's 8080 by default). */
export async function serveAgent(handler: unknown, port = Number(process.env.PORT ?? 8080)): Promise<Server> {
  const definition = handler as Partial<DefinedAgent> | undefined;
  if (definition?.kind !== "framework-agent" || typeof definition.id !== "string") {
    throw new Error(
      'An agent\'s index.ts must export `handler = agent(...).stream(...)` or `.respond(...)` from "@repo/framework/runtime/agentcore".',
    );
  }
  const settings = readSettings();
  if (definition.id !== settings.agent) {
    throw new Error(
      `This process serves agent "${settings.agent}", but its module exports agent("${definition.id}", ...). The id names the declaration.`,
    );
  }
  const server = createAgentServer(definition as DefinedAgent, {
    auth: settings.auth,
    tools: settings.tools ?? generatedToolSpecs(settings.agent),
    ...(settings.gateway ? { gateway: settings.gateway } : {}),
  });
  server.listen(port, "0.0.0.0");
  await once(server, "listening");
  return server;
}
