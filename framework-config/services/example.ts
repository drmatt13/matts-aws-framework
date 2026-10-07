import type { ServicesSection } from "../contracts";
import { resources } from "../resources";

export const langgraphService = {
  "/langgraph/*": {
    directory: "/ecs_containers/services/langgraph",
    methods: "*",
    auth: true,
    port: 5000,
    healthCheckPath: "/health",
    deploy: "local-only",
    environment: {
      USER_POOL_ID: resources.cognito.userPool.userPoolId,
      USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
      MODEL_PROVIDER: resources.langgraph.modelProvider,
      COGNITO_DOMAIN_URL: resources.cognito.userPoolDomainUrl,
      BEDROCK_MODEL_ID: resources.langgraph.bedrockModelId,
      BEDROCK_MANTLE_MODEL_ID: resources.langgraph.bedrockMantleModelId,
      OPENAI_MODEL_ID: resources.langgraph.openaiModelId,
    },
    secrets: {
      OPENAI_API_KEY: resources.openaiApiKey.value,
    },
    cloud: {
      constructId: "LanggraphService",
      cpu: 256,
      memoryMiB: 512,
      desiredCount: 1,
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
            "The task reads the key at startup and cannot answer a chat without it.",
        },
      ],
      outputs: { url: { id: "LanggraphServiceUrl" } },
    },
  },
} satisfies ServicesSection;
