import { DEFAULT_MODEL_OPTIONS, type ModelOptions } from "./catalog";
import { ChatBedrockConverse } from "@langchain/aws";
import { awsCredentials, awsRegion } from "./awsCredentials";

export function getModel(options: ModelOptions = {}) {
  const region = awsRegion();
  const credentials = awsCredentials();

  return new ChatBedrockConverse({
    region,
    // Omitted entirely when no AWS_PROFILE is set, so the SDK's default
    // provider chain resolves the ECS task role instead.
    ...(credentials ? { credentials } : {}),
    model: process.env.BEDROCK_MODEL_ID || "global.amazon.nova-2-lite-v1:0",
    temperature: options.temperature ?? DEFAULT_MODEL_OPTIONS.temperature,
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_OPTIONS.maxTokens,
  });
}
