import { DEFAULT_MODEL_OPTIONS, type ModelOptions } from "./catalog";
import { ChatOpenAI } from "@langchain/openai";

export function getModel(options: ModelOptions = {}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required when MODEL_PROVIDER=openai. Set OPENAI_API_KEY in cdk-app/.env: Compose passes it straight through locally, and npm run deploy copies it into Secrets Manager for a deployment.",
    );
  }

  return new ChatOpenAI({
    apiKey,
    model: process.env.OPENAI_MODEL_ID || "gpt-4.1-mini",
    temperature: options.temperature ?? DEFAULT_MODEL_OPTIONS.temperature,
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_OPTIONS.maxTokens,
  });
}
