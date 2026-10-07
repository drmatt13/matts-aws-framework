import type { AgentsSection } from "../contracts";
import { resources } from "../resources";

/**
 * The AgentCore example: a LangGraph agent with users and a Gateway whose
 * Lambda tools are declared in framework-config/tools/example.ts.
 *
 * All three run only locally until their deploy settings change, so the
 * example costs nothing in AWS but its model calls. Locally the browser streams
 * from /chat/example with the normal Cognito session, the agent runs in a
 * session process per conversation, and its Gateway is emulated by the
 * invocation runner — tool calls reach the real handlers through the same
 * Lambda executor every other local Lambda uses.
 */
export const exampleAgent = {
  "example-agent": {
    directory: "/agentcore/example-agent",
    auth: true,
    route: "/chat/example",
    tools: ["add-numbers", "multiply-numbers"],
    deploy: "local-only",
    environment: {
      USER_POOL_ID: resources.cognito.userPool.userPoolId,
      USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
      MODEL_PROVIDER: resources.langgraph.modelProvider,
      BEDROCK_MODEL_ID: resources.langgraph.bedrockModelId,
      BEDROCK_MANTLE_MODEL_ID: resources.langgraph.bedrockMantleModelId,
      OPENAI_MODEL_ID: resources.langgraph.openaiModelId,
      // An agent reads its secrets itself: this is the ARN, and declaring it
      // is what grants the Runtime the read.
      OPENAI_API_KEY_SECRET_ARN: resources.openaiApiKey.arn,
    },
    cloud: {
      access: [
        {
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
            "bedrock:CallWithBearerToken",
          ],
          resources: [
            // The wildcard region is deliberate: global inference profiles such as
            // `global.amazon.nova-2-lite-v1:0` fan out across regions.
            "arn:{partition}:bedrock:*::foundation-model/*",
            "arn:{partition}:bedrock:*:{account}:inference-profile/*",
          ],
        },
      ],
      requirements: [
        {
          when: {
            resource: resources.langgraph.modelProvider,
            equals: "openai",
          },
          require: [resources.openaiApiKey],
          message:
            "The agent reads the key on its first turn and cannot answer without it.",
        },
      ],
    },
  },
} satisfies AgentsSection;
