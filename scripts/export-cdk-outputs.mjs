#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";

// tsx loads these TypeScript modules as CommonJS in this workspace. Load their
// actual exports rather than relying on Node's inferred ESM named exports.
const require = createRequire(import.meta.url);
const { CLIENT_ENVIRONMENT_FILES, CLIENT_SECTION_HEADING, renderClientEnvironmentFile, renderGeneratedBlock } = require("./environment-export.ts");
const { resolveClientEnvironmentMappings } = require("./client-environment-export.ts");
const { parseClientMappings } = require("./client-environment-source.ts");
const { CLIENT_ENVIRONMENT_FILE } = require("./client-environment-mapping.ts");
const { collectDeploymentStacks, collectDevelopmentResources, readDeploymentStackPages, writeDevelopmentFiles } = require("./resource-export.ts");
const { collectProductionOutputs } = require("./production-export.ts");
const { RESOURCE_MANIFEST_FILE, listResourceDeclarations } = require("@repo/framework/config");
const { contextFromArgs, deploymentInputsFile, resolveRepositoryTarget, readCdkContext } = require("@repo/framework/deploy/node");
const { parseTargets, TARGETS_CONTEXT_KEY } = require("@repo/framework/deploy");
const { runAwsSync } = require("./aws-cli.ts");

const { ROOT_ENV_STACK_OUTPUTS: BASE_STACK_OUTPUT_MAPPINGS } = require("./root-env-outputs.ts");

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

// Local development's inputs (host ports, origins): the development inputs file
// the deploy wrapper and the CDK app read, or FRAMEWORK_INPUTS_FILE.
const authoredInputPaths = ["dev", "prod"].map((mode) => deploymentInputsFile(process.cwd(), mode));
const authoredEnvPath = process.env.FRAMEWORK_INPUTS_FILE
  ? resolve(process.env.FRAMEWORK_INPUTS_FILE)
  : deploymentInputsFile(process.cwd(), "dev");
const authoredEnv = existsSync(authoredEnvPath)
  ? parseEnv(readFileSync(authoredEnvPath, "utf8"))
  : {};
const envPath = resolve(process.cwd(), getOption("env-file") ?? ".env");
if ([authoredEnvPath, ...authoredInputPaths].some((authored) => envPath.toLowerCase() === authored.toLowerCase())) {
  throw new Error("The output file cannot be an authored inputs file such as cdk-app/.env.dev or cdk-app/.env.prod.");
}
if (envPath.toLowerCase() === resolve(process.cwd(), RESOURCE_MANIFEST_FILE).toLowerCase()) {
  throw new Error("The environment output file cannot overwrite the resource manifest.");
}
const profile = getOption("profile") ?? process.env.AWS_PROFILE ?? authoredEnv.AWS_PROFILE;
const region = getOption("region") ?? process.env.AWS_REGION ?? authoredEnv.AWS_REGION;
// Which deployment: named (--deployment, or the older --cdk-app-name), or the
// target the same CDK context would select (your development deployment by
// default). The mode is read from the deployment itself, below.
const deploymentName =
  getOption("deployment") ??
  getOption("cdkAppName", "cdk-app-name") ??
  process.env.CDK_APP_NAME ??
  resolveRepositoryTarget({
    root: process.cwd(),
    get: (key) => contextFromArgs(process.argv.slice(2))[key],
    env: process.env,
  }).target.name;

if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(deploymentName)) {
  throw new Error(
    `--deployment/--cdk-app-name/CDK_APP_NAME must be 1-63 lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${deploymentName}`,
  );
}

const stackName = (baseName) => `${deploymentName}-${baseName}`;

// The deployment scripts' one AWS CLI runner (it honors FRAMEWORK_AWS_CLI, as the tests use).
const runAws = (args) => runAwsSync(args, { ...(profile ? { profile } : {}), ...(region ? { region } : {}) });

// Discover every deployed stack; no application stack list is maintained.
let listed;
try { listed = readDeploymentStackPages(token => runAws(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])])); }
catch { throw new Error("Unable to read deployment stacks. Check AWS credentials and permissions; existing local files were preserved."); }
const { identity } = collectDeploymentStacks(listed, deploymentName);
if (region && identity.region !== region) throw new Error("The requested region differs from the deployed resources.");
if (getOption("expected-mode") && getOption("expected-mode") !== identity.mode) throw new Error("The requested mode differs from the deployed resources. Existing local files were preserved.");
// The deployed mode is authoritative. A direct production export must never read
// its custom client inputs from the development file just because no CDK flag was passed.
const declaredTarget = parseTargets(readCdkContext(process.cwd())[TARGETS_CONTEXT_KEY]).find(target => target.name === deploymentName);
const clientSelection = declaredTarget ? resolveRepositoryTarget({
  root: process.cwd(),
  get: (key) => key === "deployment" ? deploymentName : key === "prodDeployment" ? identity.mode === "prod" : undefined,
  env: process.env,
}) : { target: {}, inputsFile: process.env.FRAMEWORK_INPUTS_FILE ? resolve(process.env.FRAMEWORK_INPUTS_FILE) : deploymentInputsFile(process.cwd(), identity.mode) };
if ((clientSelection.target.account && clientSelection.target.account !== identity.account) ||
    (clientSelection.target.region && clientSelection.target.region !== identity.region)) {
  throw new Error("The declared target pins differ from the deployed resources. Existing local files were preserved.");
}
const clientInputsPath = clientSelection.inputsFile;
const clientInputs = existsSync(clientInputsPath) ? parseEnv(readFileSync(clientInputsPath, "utf8")) : {};
// Catalog presence and defaults belong to the selected deployment, just like its values.
// Resolve the mode before importing declarations that branch on PROD_DEPLOYMENT.
process.env.FRAMEWORK_MODE = identity.mode;
process.env.FRAMEWORK_INPUTS_FILE = clientInputsPath;
// Deploy can export into a separate directory. Its mappings still belong to
// the prepared source checkout beside this script, never to the output directory.
const mappingRoot = process.env.FRAMEWORK_EXPORT_DIRECTORY ? resolve(import.meta.dirname, "..") : process.cwd();
const { default: framework } = require(resolve(mappingRoot, "framework.config.ts"));
const declarations = listResourceDeclarations(framework.resources);
const clientMappings = parseClientMappings(readFileSync(resolve(mappingRoot, CLIENT_ENVIRONMENT_FILE), "utf8")).mappings;
const client = resolveClientEnvironmentMappings(clientMappings, {
  deployment: deploymentName, stacks: listed, inputs: clientInputs,
  defaults: Object.fromEntries(declarations.filter((reference) => reference.kind === "string" && !reference.secretArn && reference.fromEnv && reference.default !== undefined).map((reference) => [reference.fromEnv, reference.default])),
  sensitiveInputs: new Set(declarations.filter((reference) => reference.kind === "secret" || reference.secretArn).flatMap((reference) => reference.fromEnv ? [reference.fromEnv] : [])),
  declaredInputs: new Set(declarations.filter((reference) => reference.kind === "string" && !reference.secretArn && !reference.absent && reference.fromEnv).map((reference) => reference.fromEnv)),
  inputEnums: Object.fromEntries(declarations.filter((reference) => reference.kind === "string" && !reference.secretArn && reference.fromEnv && reference.values).map((reference) => [reference.fromEnv, reference.values])),
});
// A frontend can refresh its public settings without Docker, replay/control outputs,
// or writes to root .env and the local resource manifest. Release builds use this
// same exporter; alternate frontends choose their project's public env destination.
if (args.has("client-only")) {
  const destination = resolve(process.cwd(), getOption("client-env-file") ?? CLIENT_ENVIRONMENT_FILES[identity.mode]);
  if ([envPath, clientInputsPath, ...authoredInputPaths, resolve(process.cwd(), RESOURCE_MANIFEST_FILE)].some(file => file.toLowerCase() === destination.toLowerCase())) {
    throw new Error("Client output cannot overwrite authored inputs, root environment or the resource manifest.");
  }
  writeDevelopmentFiles([{ path: destination, contents: renderClientEnvironmentFile(client, { deployment: deploymentName, mode: identity.mode }) }]);
  console.log(`Wrote public client settings for ${deploymentName} (${identity.mode}) without starting Docker.`);
  process.exit(0);
}
if (identity.mode === "prod") {
  // Root .env belongs to local development (Compose reads it), so a production
  // export leaves it alone: its outputs and the client build settings live apart.
  const result = collectProductionOutputs(listed, deploymentName);
  writeDevelopmentFiles([
    { path: resolve(process.cwd(), ".framework/prod/outputs.json"), contents: JSON.stringify(result.document, null, 2) + "\n" },
    { path: resolve(process.cwd(), CLIENT_ENVIRONMENT_FILES.prod), contents: renderClientEnvironmentFile(client, { deployment: deploymentName, mode: "prod" }) },
  ]);
  console.log(`Wrote public production outputs to .framework/prod/outputs.json and the client build settings to ${CLIENT_ENVIRONMENT_FILES.prod} for ${deploymentName}.`);
  process.exit(0);
}
const { localExportValues, replaceGeneratedEnvironment } = require("./local-export.ts");
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

const { block, names } = renderGeneratedBlock([
  "Generated by `npm run export:cdk-outputs` from a development deployment. Author inputs in cdk-app/.env.dev.",
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
  { path: resolve(process.cwd(), CLIENT_ENVIRONMENT_FILES.dev), contents: renderClientEnvironmentFile(client, { deployment: deploymentName, mode: "dev" }) },
]);
console.log(`Wrote development Compose settings, resource identifiers and ${CLIENT_ENVIRONMENT_FILES.dev} for ${deploymentName}.`);
