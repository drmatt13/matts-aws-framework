#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";

// tsx loads these TypeScript modules as CommonJS in this workspace. Load their
// actual exports rather than relying on Node's inferred ESM named exports.
const require = createRequire(import.meta.url);
const { localClientEndpoints, localExportValues, replaceGeneratedEnvironment } = require("./local-export.ts");
const { CLIENT_SECTION_HEADING, clientEnvironment, renderGeneratedBlock } = require("./environment-export.ts");
const { collectDeploymentStacks, collectDevelopmentResources, readDeploymentStackPages, writeDevelopmentFiles } = require("./resource-export.ts");
const { collectProductionOutputs, renderProductionEnvironment } = require("./production-export.ts");
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
  WebSocketApiStack: {
    WebSocketAPIEndpoint: "WEBSOCKET_API_URL",
  },
  RdsStack: {
    RdsDatabaseEndpoint: "RDS_DATABASE_ENDPOINT",
  },
};

const BASE_STACK_NAME_ENV_NAMES = {
  CognitoStack: "COGNITO_STACK_NAME",
  DevLambdaReplayStack: "DEV_LAMBDA_REPLAY_STACK_NAME",
  FrontendWebsiteS3Stack: "FRONTEND_WEBSITE_S3_STACK_NAME",
  HttpApiGatewayStack: "HTTP_API_GATEWAY_STACK_NAME",
  WebSocketApiStack: "WEBSOCKET_API_STACK_NAME",
  RdsStack: "RDS_STACK_NAME",
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
      "WEBSOCKET_API_STACK_NAME",
      "RDS_STACK_NAME",
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
    envNames: ["HTTP_API_URL", "WEBSOCKET_API_URL"],
  },
  {
    heading: "Database",
    envNames: ["RDS_DATABASE_ENDPOINT"],
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
  throw new Error("The environment output file cannot overwrite the resource manifest.");
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
const { identity } = collectDeploymentStacks(listed, deploymentName);
if (region && identity.region !== region) throw new Error("The requested region differs from the deployed resources.");
if (identity.mode === "prod") {
  const result = collectProductionOutputs(listed, deploymentName);
  const contents = renderProductionEnvironment(result, existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
  writeDevelopmentFiles([
    { path: envPath, contents },
    { path: resolve(process.cwd(), ".framework/prod/outputs.json"), contents: JSON.stringify(result.document, null, 2) + "\n" },
  ]);
  console.log(`Wrote public production settings to ${envPath} and .framework/prod/outputs.json for ${deploymentName}. Copy its client-app block to client-app/.env before building.`);
  process.exit(0);
}
const { manifest, stacks: deploymentStacks } = collectDevelopmentResources(listed, deploymentName, framework);
if (region && manifest.region !== region) throw new Error("The requested region differs from the deployed resources.");
const describeStackOutputs = (name) => deploymentStacks.find((stack) => stack.StackName === name)?.Outputs ?? null;

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

    collectedEnv.set(envName, output.OutputValue);
  }
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

const client = clientEnvironment({
  // Cognito lives in the deployment's region, which LOCAL_AWS_REGION need not name.
  region: manifest.region,
  userPoolId: collectedEnv.get("USER_POOL_ID"),
  userPoolClientId: collectedEnv.get("USER_POOL_CLIENT_ID"),
  cognitoDomainUrl: collectedEnv.get("COGNITO_DOMAIN_URL"),
  ...localClientEndpoints(authoredEnv, localValues),
  // Whatever this deployment holds: empty unless it built a WebSocketApiStack.
  apiGatewayWebSocketUrl: collectedEnv.get("WEBSOCKET_API_URL") ?? "",
});

const { block, names } = renderGeneratedBlock([
  "Generated by `npm run export:cdk-outputs` from a development deployment. Author inputs in cdk-app/.env.",
  "Resource attributes are in .framework/local/resources.json.",
], [
  ...GENERATED_ENV_SECTIONS.map(({ heading, envNames }) => ({
    heading,
    values: Object.fromEntries(envNames.map((envName) => [envName, collectedEnv.get(envName)])),
  })),
  { heading: "Compose controls", values: Object.fromEntries(localValues) },
  // Read from here too: client-app/vite.config.ts takes its proxy target from
  // VITE_API_GATEWAY_URL, and Compose gives ws-tester VITE_API_GATEWAY_WS_URL.
  // VITE_LOCAL_WS_URL and VITE_API_GATEWAY_WS_URL are written independently, so
  // either, both or neither can be set; client-app hands both to the tester.
  { heading: CLIENT_SECTION_HEADING, values: client },
]);
const contents = replaceGeneratedEnvironment(existsSync(envPath) ? readFileSync(envPath, "utf8") : "", block, names);
writeDevelopmentFiles([
  { path: resolve(process.cwd(), RESOURCE_MANIFEST_FILE), contents: JSON.stringify(manifest, null, 2) + "\n" },
  { path: envPath, contents },
]);
console.log(`Wrote development Compose settings and resource identifiers for ${deploymentName}. Copy the client-app block in ${envPath} to client-app/.env.`);
