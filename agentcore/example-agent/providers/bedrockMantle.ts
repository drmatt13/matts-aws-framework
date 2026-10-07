import { DEFAULT_MODEL_OPTIONS, type ModelOptions } from "./catalog";
import { getTokenProvider } from "@aws/bedrock-token-generator";
import { ChatOpenAI } from "@langchain/openai";
import { awsProfile, awsRegion, memoizePerIdentity } from "./awsCredentials";

// The provider caches short-term API keys and refreshes them from the AWS
// profile. No Bedrock API key is stored in source or environment variables.
// With no profile -- the ECS case -- it falls back to the default credential
// chain and mints the same short-lived token from the task role.
//
// Memoized so that cache survives across calls; building a new provider per
// request would mint a fresh token every turn.
const tokenProvider = memoizePerIdentity((profile, region) =>
  getTokenProvider({
    ...(profile ? { profile } : {}),
    region,
    expiresInSeconds: 3600,
  }),
);

export async function getModel(options: ModelOptions = {}) {
  const region = awsRegion();
  const modelId = process.env.BEDROCK_MANTLE_MODEL_ID || "openai.gpt-oss-20b"; // openai.gpt-oss-120b

  const apiKey = await tokenProvider(awsProfile(), region)();

  return new ChatOpenAI({
    model: modelId,
    apiKey,
    temperature: options.temperature ?? DEFAULT_MODEL_OPTIONS.temperature,
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_OPTIONS.maxTokens,
    useResponsesApi: true,
    // Do not store response state on the Bedrock Mantle endpoint.
    zdrEnabled: true,
    configuration: {
      baseURL: `https://bedrock-mantle.${region}.api.aws/v1`,
    },
  });
}
