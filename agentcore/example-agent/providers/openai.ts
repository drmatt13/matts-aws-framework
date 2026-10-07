import { DEFAULT_MODEL_OPTIONS, type ModelOptions } from "./catalog";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ChatOpenAI } from "@langchain/openai";
import { awsCredentials, awsRegion } from "./awsCredentials";

/**
 * AgentCore Runtime has no startup secret injection, so the agent is given the
 * key's ARN -- which also grants it the read -- and fetches the value itself,
 * once per session. Locally the ARN comes from the development resource
 * manifest, so the same read reaches the same secret.
 */
let apiKey: Promise<string> | undefined;

function readApiKey(): Promise<string> {
  const arn = process.env.OPENAI_API_KEY_SECRET_ARN;

  if (!arn) {
    throw new Error(
      "OPENAI_API_KEY is required when MODEL_PROVIDER=openai. Set OPENAI_API_KEY in cdk-app/.env and run npm run deploy: it uploads the value to Secrets Manager and hands its ARN to the agent, through the development resource manifest locally and the Runtime's environment in AWS.",
    );
  }

  apiKey ??= (async () => {
    const credentials = awsCredentials();
    // The secret's own region, which its ARN names.
    const client = new SecretsManagerClient({
      region: arn.split(":")[3] || awsRegion(),
      ...(credentials ? { credentials } : {}),
    });

    try {
      const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      if (!SecretString) throw new Error("The OpenAI API key secret has no string value.");
      return SecretString;
    } finally {
      client.destroy();
    }
  })();
  // A failed read is tried again on the next turn rather than remembered.
  apiKey.catch(() => {
    apiKey = undefined;
  });

  return apiKey;
}

export async function getModel(options: ModelOptions = {}) {
  return new ChatOpenAI({
    apiKey: await readApiKey(),
    model: process.env.OPENAI_MODEL_ID || "gpt-4.1-mini",
    temperature: options.temperature ?? DEFAULT_MODEL_OPTIONS.temperature,
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_OPTIONS.maxTokens,
  });
}
