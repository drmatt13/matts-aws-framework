#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { quoteOutputValue } from "./cdk-output-environment.mjs";

// tsx loads these TypeScript modules as CommonJS in this workspace. Load their
// actual exports rather than relying on Node's inferred ESM named exports.
const require = createRequire(import.meta.url);
const { localExportValues, replaceGeneratedEnvironment } = require("./local-export.ts");
const { collectDevelopmentResources, readDeploymentStackPages, writeDevelopmentFiles } = require("./resource-export.ts");
const { RESOURCE_MANIFEST_FILE } = require("@repo/framework/config");
const { default: framework } = require("../framework.config.ts");

const BASE_STACK_OUTPUT_MAPPINGS = {
  CognitoStack: {
    UserPoolId: "USER_POOL_ID",
    UserPoolClientId: "USER_POOL_CLIENT_ID",
    UserPoolDomainUrl: "COGNITO_DOMAIN_URL",
    UserPoolDomainCloudFrontEndpoint: "COGNITO_DOMAIN_CLOUDFRONT_ENDPOINT",
    OAuthProviderRedirectUri: "OAUTH_PROVIDER_REDIRECT_URI",
  },
  DevLambdaReplayStack: {
    ReplayBucketName: "DEV_LAMBDA_REPLAY_BUCKET_NAME",
    ReplayQueueUrl: "DEV_LAMBDA_REPLAY_QUEUE_URL",
    ReplayQueueArn: "DEV_LAMBDA_REPLAY_QUEUE_ARN",
  },
  FrontendWebsiteS3Stack: {
    FrontendWebsiteBucketName: "FRONTEND_WEBSITE_BUCKET_NAME",
    CloudFrontUrl: "CLOUDFRONT_URL",
    FrontendWebsiteUrl: "CLOUDFRONT_URL",
    CloudFrontDomainName: "CLOUDFRONT_DOMAIN_NAME",
    CloudFrontId: "CLOUDFRONT_ID",
    FrontendDistributionId: "CLOUDFRONT_ID",
  },
  HttpApiGatewayStack: {
    HttpApiUrl: "HTTP_API_URL",
  },
  RdsStack: {
    RdsProxyEndpoint: "RDS_PROXY_ENDPOINT",
    RdsProxyEnabled: "RDS_PROXY_ENABLED",
    RdsProxyPort: "RDS_PROXY_PORT",
    RdsDatabaseEndpoint: "RDS_DATABASE_ENDPOINT",
    RdsPrimaryEndpoint: "RDS_PRIMARY_ENDPOINT",
    PrimaryDatabaseUrlTemplate: "PRIMARY_DATABASE_URL_TEMPLATE",
    DirectDatabaseUrlTemplate: "DIRECT_DATABASE_URL_TEMPLATE",
    RdsCredentialsSecretArn: "RDS_CREDENTIALS_SECRET_ARN",
  },
  WebSocketApiStack: {
    WebSocketAPIEndpoint: "VITE_API_GATEWAY_WS_URL",
  },
};

const BASE_STACK_NAME_ENV_NAMES = {
  CognitoStack: "COGNITO_STACK_NAME",
  DevLambdaReplayStack: "DEV_LAMBDA_REPLAY_STACK_NAME",
  FrontendWebsiteS3Stack: "FRONTEND_WEBSITE_S3_STACK_NAME",
  HttpApiGatewayStack: "HTTP_API_GATEWAY_STACK_NAME",
  RdsStack: "RDS_STACK_NAME",
  WebSocketApiStack: "WEB_SOCKET_API_STACK_NAME",
};

const GENERATED_ENV_SECTIONS = [
  {
    heading: "Deployment / stack names",
    envNames: [
      "CDK_APP_NAME",
      "COGNITO_STACK_NAME",
      "DEV_LAMBDA_REPLAY_STACK_NAME",
      "FRONTEND_WEBSITE_S3_STACK_NAME",
      "HTTP_API_GATEWAY_STACK_NAME",
      "RDS_STACK_NAME",
      "WEB_SOCKET_API_STACK_NAME",
    ],
  },
  {
    heading: "Cognito / OAuth",
    envNames: [
      "USER_POOL_ID",
      "USER_POOL_CLIENT_ID",
      "COGNITO_DOMAIN_URL",
      "COGNITO_DOMAIN_CLOUDFRONT_ENDPOINT",
      "OAUTH_PROVIDER_REDIRECT_URI",
    ],
  },
  {
    heading: "Frontend / CloudFront",
    envNames: [
      "FRONTEND_WEBSITE_BUCKET_NAME",
      "CLOUDFRONT_URL",
      "CLOUDFRONT_DOMAIN_NAME",
      "CLOUDFRONT_ID",
    ],
  },
  {
    heading: "APIs",
    envNames: ["HTTP_API_URL", "VITE_API_GATEWAY_WS_URL"],
  },
  {
    heading: "Database",
    envNames: [
      "RDS_PROXY_ENABLED",
      "RDS_PROXY_ENDPOINT",
      "RDS_PROXY_PORT",
      "RDS_PRIMARY_ENDPOINT",
      "RDS_DATABASE_ENDPOINT",
      "PRIMARY_DATABASE_URL_TEMPLATE",
      "DIRECT_DATABASE_URL_TEMPLATE",
      "RDS_CREDENTIALS_SECRET_ARN",
    ],
  },
  {
    heading: "Development replay",
    envNames: [
      "DEV_LAMBDA_REPLAY_BUCKET_NAME",
      "DEV_LAMBDA_REPLAY_QUEUE_URL",
      "DEV_LAMBDA_REPLAY_QUEUE_ARN",
    ],
  },
];

// How bindWorkflowIntegration announces which reference an output is for. The
// output key is PascalCase and cannot be reversed unambiguously, so the
// description carries the key instead.
const INTEGRATION_OUTPUT_DESCRIPTION_PREFIX = "framework:workflow-integration:";
const WORKFLOW_BINDINGS_VERSION = 1;

const GENERATED_BLOCK_START = "# BEGIN GENERATED CDK OUTPUTS";
const GENERATED_BLOCK_END = "# END GENERATED CDK OUTPUTS";

const args = new Map(
  process.argv.slice(2).flatMap((arg, index, allArgs) => {
    if (!arg.startsWith("--")) {
      return [];
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = allArgs[index + 1]?.startsWith("--")
      ? undefined
      : allArgs[index + 1];

    return [[key, inlineValue ?? nextValue ?? "true"]];
  }),
);

const getOption = (...names) => {
  for (const name of names) {
    const argValue = args.get(name);
    if (argValue !== undefined) {
      return argValue;
    }

    const npmConfigNames = [
      name,
      name.toLowerCase(),
      name.replace(/-/g, "_").toLowerCase(),
      name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
      name
        .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
        .replace(/-/g, "_")
        .replace(/^_/, ""),
    ];

    for (const npmConfigName of npmConfigNames) {
      const envValue = process.env[`npm_config_${npmConfigName}`];
      if (envValue !== undefined) {
        return envValue;
      }
    }
  }

  return undefined;
};

const authoredEnvPath = resolve(process.cwd(), "cdk-app/.env");
const authoredEnv = existsSync(authoredEnvPath)
  ? parseEnv(readFileSync(authoredEnvPath, "utf8"))
  : {};
const envPath = resolve(process.cwd(), getOption("env-file") ?? ".env");
if (envPath.toLowerCase() === authoredEnvPath.toLowerCase()) {
  throw new Error("The output file cannot be cdk-app/.env, which contains authored deployment inputs.");
}
if (envPath.toLowerCase() === resolve(process.cwd(), RESOURCE_MANIFEST_FILE).toLowerCase()) {
  throw new Error("The Compose output file cannot overwrite the resource manifest.");
}
const profile = getOption("profile") ?? process.env.AWS_PROFILE ?? authoredEnv.AWS_PROFILE;
const region = getOption("region") ?? process.env.AWS_REGION ?? authoredEnv.AWS_REGION;
const deploymentName =
  getOption("cdkAppName", "cdk-app-name") ??
  process.env.CDK_APP_NAME ??
  authoredEnv.CDK_APP_NAME ??
  "matts-aws-framework";

if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(deploymentName)) {
  throw new Error(
    `--cdkAppName/--cdk-app-name/CDK_APP_NAME must be 1-63 lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${deploymentName}`,
  );
}

const stackName = (baseName) => `${deploymentName}-${baseName}`;

const awsArgsBase = [];
if (profile) {
  awsArgsBase.push("--profile", profile);
}
if (region) {
  awsArgsBase.push("--region", region);
}

const runAws = (args) => {
  const output = execFileSync("aws", [...awsArgsBase, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return JSON.parse(output);
};

// Discover every deployed stack; no application stack list is maintained.
let listed;
try { listed = readDeploymentStackPages(token => runAws(["cloudformation", "describe-stacks", "--no-paginate", "--output", "json", ...(token ? ["--next-token", token] : [])])); }
catch { throw new Error("Unable to read deployment stacks. Check AWS credentials and permissions; existing local files were preserved."); }
const { manifest, stacks: deploymentStacks } = collectDevelopmentResources(listed, deploymentName, framework);
if (region && manifest.region !== region) throw new Error("The requested region differs from the deployed resources.");
const describeStackOutputs = (name) => deploymentStacks.find((stack) => stack.StackName === name)?.Outputs ?? null;

const normalizeWebSocketUrl = (url) => {
  const cleanUrl = url.replace(/^wss:\/\/wss:\/\//, "wss://");
  return cleanUrl.includes("?token=") ? cleanUrl : `${cleanUrl}?token=`;
};

const renderGeneratedSections = (envValues) =>
  GENERATED_ENV_SECTIONS.flatMap(({ heading, envNames }) => {
    const values = envNames
      .filter((envName) => envValues.has(envName))
      .map((envName) => `${envName}=${quoteOutputValue(envValues.get(envName))}`);

    return values.length === 0 ? [] : [`# ${heading}`, ...values, ""];
  });

const collectedEnv = new Map();

for (const [baseStackName, outputMappings] of Object.entries(
  BASE_STACK_OUTPUT_MAPPINGS,
)) {
  const resolvedStackName = stackName(baseStackName);
  const outputs = describeStackOutputs(resolvedStackName);

  if (outputs === null) {
    continue;
  }

  const stackNameEnvName = BASE_STACK_NAME_ENV_NAMES[baseStackName];
  if (stackNameEnvName) {
    collectedEnv.set(stackNameEnvName, resolvedStackName);
  }

  for (const output of outputs) {
    const envName = outputMappings[output.OutputKey];
    if (!envName || output.OutputValue === undefined) {
      continue;
    }

    const value =
      envName === "VITE_API_GATEWAY_WS_URL"
        ? normalizeWebSocketUrl(output.OutputValue)
        : output.OutputValue;

    collectedEnv.set(envName, value);
  }
}

if (collectedEnv.get("RDS_PROXY_ENABLED")?.toLowerCase() !== "true") {
  collectedEnv.delete("RDS_PROXY_ENDPOINT");
  collectedEnv.delete("RDS_PROXY_PORT");
}

if (collectedEnv.size === 0) {
  throw new Error("No CDK outputs were found. Deploy the stacks first, then rerun this command.");
}

for (const name of ["USER_POOL_ID", "USER_POOL_CLIENT_ID", "COGNITO_DOMAIN_URL", "DEV_LAMBDA_REPLAY_BUCKET_NAME", "DEV_LAMBDA_REPLAY_QUEUE_URL", "DEV_LAMBDA_REPLAY_QUEUE_ARN"]) {
  if (!collectedEnv.get(name)) throw new Error(`Required development control output ${name} is missing. Existing local files were preserved.`);
}
collectedEnv.set("CDK_APP_NAME", deploymentName);
const localValues = localExportValues(authoredEnv, { profile, region: manifest.region, repositoryRoot: process.cwd() });
localValues.set("LOCAL_FRAMEWORK_DEPLOYMENT", manifest.deployment);
localValues.set("LOCAL_FRAMEWORK_ACCOUNT", manifest.account);

const generatedLines = [
  GENERATED_BLOCK_START,
  "# Generated by `npm run export:cdk-outputs`. Author inputs in cdk-app/.env.",
  "# Docker Compose controls only. Resource attributes are in .framework/local/resources.json.",
  "",
  ...renderGeneratedSections(collectedEnv),
  ...(localValues.size ? ["# Compose controls"] : []),
  ...[...localValues].map(([name, value]) => `${name}=${quoteOutputValue(value)}`),
  GENERATED_BLOCK_END,
  "",
];

const block = generatedLines.join("\n");
const names = [...block.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]);
const contents = replaceGeneratedEnvironment(existsSync(envPath) ? readFileSync(envPath, "utf8") : "", block, names);
writeDevelopmentFiles([
  { path: resolve(process.cwd(), RESOURCE_MANIFEST_FILE), contents: JSON.stringify(manifest, null, 2) + "\n" },
  { path: envPath, contents },
]);
console.log(`Wrote development Compose settings and resource identifiers for ${deploymentName}.`);
