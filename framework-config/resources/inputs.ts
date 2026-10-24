import { resource } from "@repo/framework/config";

// Author values only in cdk-app/.env.<mode>. Source contains metadata only;
// deploy:resources uploads the authored secrets as a separate deployment action.
export const openaiApiKey = resource.secret("OPENAI_API_KEY", { tags: { area: "examples" } });
export const googleClientSecret = resource.secret("GOOGLE_CLIENT_SECRET", { tags: { area: "auth" } });

export const enableWebSocketApi = resource
  .fromEnv("ENABLE_WEBSOCKET_API", { tags: { area: "realtime" } })
  .enum("true", "false")
  .default("true");

// Cohesive inputs stay together; their catalog paths do not depend on this file.
export const langgraph = {
  modelProvider: resource
    .fromEnv("LANGGRAPH_MODEL_PROVIDER", { tags: { area: "examples" } })
    .enum("bedrock-mantle", "bedrock", "openai")
    .default("bedrock-mantle"),
  bedrockModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MODEL_ID", { tags: { area: "examples" } }).default("global.amazon.nova-2-lite-v1:0"),
  bedrockMantleModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MANTLE_MODEL_ID", { tags: { area: "examples" } }).default("openai.gpt-oss-20b"),
  openaiModelId: resource.fromEnv("LANGGRAPH_OPENAI_MODEL_ID", { tags: { area: "examples" } }).default("gpt-4.1-mini"),
};
