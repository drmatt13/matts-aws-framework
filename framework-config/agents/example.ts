import type { AgentsSection } from "../contracts";
import { models } from "../models";

/**
 * The AgentCore example: a LangGraph agent with users and a Gateway whose
 * Lambda tools are declared in framework-config/tools/example.ts.
 *
 * The tools follow this agent's deploy setting. Locally the browser streams
 * from /chat/example with the normal Cognito session, the agent runs in a
 * session process per conversation, and its Gateway is emulated by the
 * invocation runner — tool calls reach the real handlers through the same
 * Lambda executor every other local Lambda uses.
 */
export const exampleAgent = {
  "example-agent": {
    directory: "/agents/example-agent",
    auth: true,
    route: "/chat/example",
    tools: ["add-numbers", "multiply-numbers"],
    deploy: "both",
    // auth: true is handed framework.config.ts's userPool, which AgentCore and
    // this agent's adapter both verify the caller against.
    environment: {
      // The model: its variables, its IAM and its requirements, shared by
      // every agent built on @repo/models.
      ...models.environment,
    },
    cloud: {
      access: models.access,
      requirements: models.requirements,
    },
  },
} satisfies AgentsSection;
