import { getModel as getBedrockModel } from "./bedrock";
import { getModel as getBedrockMantleModel } from "./bedrockMantle";
import { getModel as getOpenAIModel } from "./openai";
import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  type ModelProvider,
  type ModelOptions,
} from "./catalog";

export type { ModelProvider, ModelOptions };
export { extractText, toModelMessages } from "./messages";

function selectedProvider(): ModelProvider {
  const provider = (process.env.MODEL_PROVIDER?.trim() || DEFAULT_MODEL_PROVIDER).toLowerCase();

  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Unsupported MODEL_PROVIDER "${provider}". Use ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }

  return provider as ModelProvider;
}

/**
 * Return the requested provider model.
 *
 * Pass a provider explicitly for editor autocomplete, e.g.
 * `getModel("openai")`. When omitted, MODEL_PROVIDER is used.
 */
export async function getModel(provider: ModelProvider = selectedProvider(), options: ModelOptions = {}) {
  switch (provider) {
    case "bedrock":
      return getBedrockModel(options);
    case "openai":
      return getOpenAIModel(options);
    case "bedrock-mantle":
      return getBedrockMantleModel(options);
  }
}
