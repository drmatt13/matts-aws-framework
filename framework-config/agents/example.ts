import type { AgentsSection, ToolsSection } from "../contracts";
import { resources } from "../resources";

/**
 * The AgentCore sample: one agent with users, and one tool that acts as them.
 *
 * Both run only locally until their deploy settings change, so the sample
 * costs nothing in AWS. Locally the browser streams from /chat/echo
 * with the normal Cognito session, the agent runs in a session process, and its
 * Gateway is emulated by the invocation runner — tool calls reach the real
 * handler through the same Lambda executor every other local Lambda uses.
 */
const cognito = {
  USER_POOL_ID: resources.cognito.userPool.userPoolId,
  USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
};

export const exampleTools = {
  echo: { auth: true, deploy: "local-only", environment: { ...cognito } },
} satisfies ToolsSection;

export const exampleAgents = {
  "echo-agent": {
    auth: true,
    route: "/chat/echo",
    tools: ["echo"],
    deploy: "local-only",
    environment: { ...cognito },
  },
} satisfies AgentsSection;
