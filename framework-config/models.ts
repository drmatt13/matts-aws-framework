import type { AgentsSection } from "./contracts";
import { resources } from "./resources";

type Agent = AgentsSection[string];
type AgentCloud = NonNullable<Agent["cloud"]>;

/**
 * What every agent that builds its model with `@repo/models` declares: the
 * variables `getModel()` reads, the IAM its providers call with, and the input
 * the OpenAI provider cannot run without. Spread it beside the agent's own:
 *
 *   environment: { ...models.environment, SUPPORT_QUEUE_URL: ... },
 *   cloud: { access: models.access, requirements: models.requirements },
 *
 * Written once because none of it is a fact about one agent — the providers
 * decide it — and because forgetting it fails late: locally the model is called
 * with your AWS profile, so only the deployed Runtime's first turn finds the
 * missing grant. `cdk-app/test/langgraph-model-providers.test.ts` fails instead
 * for an agent that imports the package without this.
 *
 * An agent on another model overrides one variable after the spread, say
 * `BEDROCK_MODEL_ID: resources.x.supportModelId`, and needs no new permission:
 * the access covers every model, not this default one. Permissions the agent
 * needs for itself are appended: `access: [...models.access, { ... }]`.
 */
export const models = {
  environment: {
    MODEL_PROVIDER: resources.langgraph.modelProvider,
    BEDROCK_MODEL_ID: resources.langgraph.bedrockModelId,
    BEDROCK_MANTLE_MODEL_ID: resources.langgraph.bedrockMantleModelId,
    OPENAI_MODEL_ID: resources.langgraph.openaiModelId,
    // An agent reads its secrets itself: this is the ARN, and declaring it
    // is what grants the Runtime the read.
    OPENAI_API_KEY_SECRET_ARN: resources.openaiApiKey.arn,
  },
  access: [
    {
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        // The wildcard region is deliberate: global inference profiles such as
        // `global.amazon.nova-2-lite-v1:0` fan out across regions.
        "arn:{partition}:bedrock:*::foundation-model/*",
        "arn:{partition}:bedrock:*:{account}:inference-profile/*",
      ],
    },
    {
      // Mantle uses project permissions, separate from bedrock-runtime's
      // foundation-model and inference-profile permissions above.
      actions: ["bedrock-mantle:CreateInference"],
      resources: ["arn:{partition}:bedrock-mantle:{region}:{account}:project/default"],
    },
    {
      // The Mantle provider authenticates with a short-lived bearer token.
      // This action does not support resource-level permissions.
      actions: ["bedrock-mantle:CallWithBearerToken"],
      resources: ["*"],
    },
  ],
  requirements: [
    {
      when: { resource: resources.langgraph.modelProvider, equals: "openai" },
      require: [resources.openaiApiKey],
      message: "The agent reads the key on its first turn and cannot answer without it.",
    },
  ],
} as const satisfies {
  readonly environment: NonNullable<Agent["environment"]>;
  readonly access: NonNullable<AgentCloud["access"]>;
  readonly requirements: NonNullable<AgentCloud["requirements"]>;
};
