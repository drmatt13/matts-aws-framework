/**
 * The model providers this service can construct, and the one it uses when
 * MODEL_PROVIDER says nothing.
 *
 * Declared here because this is where the choice is actually consumed: the
 * switch in `./index.ts` has one branch per entry and no default, so this list
 * is what makes it exhaustive — a provider added here is a type error until it
 * is wired up.
 *
 * `framework.config.ts` declares the same values as the deployment input, and
 * `cdk-app/test/langgraph-model-providers.test.ts` fails if the two drift. The
 * two halves fail at different times otherwise: a deployment that accepted a
 * fourth value would synth and deploy clean, then leave this container throwing
 * at startup.
 */

export const MODEL_PROVIDERS = ["bedrock-mantle", "bedrock", "openai"] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const DEFAULT_MODEL_PROVIDER: ModelProvider = "bedrock-mantle";

/**
 * Per-caller generation settings. The chat service keeps the defaults; a caller
 * that needs a longer structured answer asks for more tokens rather than every
 * provider being raised for everyone.
 */
export interface ModelOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export const DEFAULT_MODEL_OPTIONS = {
  maxTokens: 1000,
  temperature: 0.2,
} as const satisfies Required<ModelOptions>;
