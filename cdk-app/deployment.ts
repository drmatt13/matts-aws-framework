import * as cdk from "aws-cdk-lib";
import { createHash } from "crypto";
import * as fs from "fs";
import type { CloudMode } from "@repo/framework/config";
import { modeFromContext, type DeploymentTarget } from "@repo/framework/deploy";
import { resolveDatabaseSettings } from "./database-settings";

/** Application-owned deployment policy. See docs/FRAMEWORK.md#configuration-and-environment.
 * Importing this module never reads .env, creates an App, or generates code.
 */
export interface DeploymentSources {
  getContext: (key: string) => unknown;
  env: Readonly<Record<string, string | undefined>>;
  /** The deployment target bin/app.ts resolved from context. */
  target?: Pick<DeploymentTarget, "name" | "mode" | "account" | "region">;
}

export function resolveDeploymentInputs({ getContext, env, target }: DeploymentSources) {
  const warnings: string[] = [];
  // New ordinary flags use these readers: context, environment, then fallback.
  const stringFlag = (context: string, envKey: string) =>
    optionalString(getContext(context)) ?? optionalString(env[envKey]);
  const booleanFlag = ({
    context, env: envKey, fallback = false, envLabel,
  }: { context: string; env?: string; fallback?: boolean; envLabel?: string }): boolean =>
    optionalBoolean(getContext(context), `-c ${context}`) ??
    (envKey === undefined ? undefined : optionalBoolean(env[envKey], envLabel ?? `${envKey} in cdk-app/.env`)) ??
    fallback;
  const account = env.CDK_DEFAULT_ACCOUNT;
  const region = env.CDK_DEFAULT_REGION;

  if (!account || !region) {
    throw new Error(
      "CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set: every stack is pinned to one account and region. The CDK CLI sets them from your AWS profile (--profile <PROFILE>).",
    );
  }

  const stackEnv: cdk.Environment = {
    account,
    region,
  };

  // The one derived value the graph is built from. Resolved here so no stack has
  // to re-answer "which deployment is this" from something else it can see -
  // whether an RDS stack happened to be created, say. It comes from CDK context:
  // the target bin/app.ts resolved, or `-c prodDeployment` when a caller (a
  // test) supplies none.
  const stated = modeFromContext(getContext);
  if (!target) warnings.push(...stated.warnings);
  const mode: CloudMode = target?.mode ?? stated.mode ?? "dev";

  // PROD_DEPLOYMENT used to live in cdk-app/.env. A leftover line that agrees is
  // only noise; one that disagrees is someone expecting the file to decide, and
  // building the other graph silently would be the worst answer.
  const legacyMode = optionalBoolean(env.PROD_DEPLOYMENT, "PROD_DEPLOYMENT");
  if (legacyMode !== undefined && legacyMode !== (mode === "prod")) {
    throw new Error(
      `PROD_DEPLOYMENT=${legacyMode} in the inputs file disagrees with this ${mode} synth. The mode is chosen per command now: pass -c prodDeployment=${legacyMode} to build ${legacyMode ? "production" : "development"}, and remove PROD_DEPLOYMENT from the inputs file.`,
    );
  }
  if (legacyMode !== undefined) {
    warnings.push("[cdk-app] PROD_DEPLOYMENT in the inputs file is no longer read; the mode comes from -c prodDeployment. Remove the line.");
  }

  // A production target is named by cdk.json; a CDK_APP_NAME beside it in the
  // inputs file is someone expecting it to name the deployment.
  if (target?.mode === "prod" && env.CDK_APP_NAME?.trim() && env.CDK_APP_NAME.trim() !== target.name) {
    warnings.push(`[cdk-app] CDK_APP_NAME=${env.CDK_APP_NAME.trim()} in the inputs file is ignored: this production deployment is the target ${target.name}. Remove the line.`);
  }

  // A target pinned to an account or region is never synthesized for another:
  // the selected profile is a credential source, not a statement about where
  // production lives.
  if (target?.account && target.account !== account) {
    throw new Error(`${target.name} is pinned to account ${target.account} in framework:targets, but the selected credentials are for ${account}. Choose the profile for ${target.account}.`);
  }
  if (target?.region && target.region !== region) {
    throw new Error(`${target.name} is pinned to ${target.region} in framework:targets, but this synth is for ${region}. Select ${target.region} (--region or the profile's region).`);
  }

  // Development convenience: the pre-signup trigger confirms new users itself
  // instead of mailing them a code. Never derived from anything else, and
  // refused outright in production: an address nobody proved they own must not
  // be marked verified in a pool real users sign in to.
  const requestedSkipEmailVerification = booleanFlag({
    context: "skipEmailVerification",
    env: "SKIP_EMAIL_VERIFICATION",
  });
  if (requestedSkipEmailVerification && mode === "prod") {
    throw new Error(
      "SKIP_EMAIL_VERIFICATION is a development setting and cannot be used by a production deployment. Remove it from cdk-app/.env (or drop -c skipEmailVerification).",
    );
  }

  // Where Cognito sends verification and password-reset mail from. Absent,
  // Cognito's built-in sender is used, which is capped at a small daily quota.
  const cognitoSesFromEmail = stringFlag("cognitoSesFromEmail", "COGNITO_SES_FROM_EMAIL");
  const cognitoSesFromName = stringFlag("cognitoSesFromName", "COGNITO_SES_FROM_NAME");
  const cognitoSesRegion = stringFlag("cognitoSesRegion", "COGNITO_SES_REGION");
  if (!cognitoSesFromEmail && (cognitoSesFromName || cognitoSesRegion)) {
    throw new Error(
      "COGNITO_SES_FROM_NAME and COGNITO_SES_REGION only apply with COGNITO_SES_FROM_EMAIL. Set the sender address, or remove them.",
    );
  }
  if (mode === "prod" && !cognitoSesFromEmail) {
    warnings.push(
      "[cdk-app] Production Cognito mail uses Cognito's built-in sender, which is limited to about 50 messages a day. Set COGNITO_SES_FROM_EMAIL to a verified SES identity before real users sign up.",
    );
  }

  // Days of automated RDS backups. Production only; 0 turns backups off, which
  // is a deliberate choice for a disposable deployment and nothing else.
  const database = resolveDatabaseSettings({ getContext, env });
  const databaseBackupRetentionDays = database.backupRetentionDays;

  // Guards deletion protection and the removal policy on the database and user
  // pool, so a value that does not parse must never fall through to false.
  //
  // The original spelling of this flag was missing an "r". It is still honored,
  // because silently ignoring a stale -c retainStatefulResouces=true on a
  // production deploy would drop protection from the database it was typed to
  // protect.
  const retainStatefulResoucesLegacy = optionalBoolean(
    getContext("retainStatefulResouces"),
    "-c retainStatefulResouces",
  );

  if (retainStatefulResoucesLegacy !== undefined) {
    warnings.push(
      '[cdk-app] -c retainStatefulResouces is misspelled and will be removed. Use -c retainStatefulResources, or set RETAIN_STATEFUL_RESOURCES in cdk-app/.env.',
    );
  }

  const retainStatefulResources =
    optionalBoolean(
      getContext("retainStatefulResources"),
      "-c retainStatefulResources",
    ) ??
    retainStatefulResoucesLegacy ??
    optionalBoolean(
      env.RETAIN_STATEFUL_RESOURCES,
      "RETAIN_STATEFUL_RESOURCES in cdk-app/.env",
    ) ??
    false;

  // WebSocket configuration.
  //
  // deployProdWebSocketApi creates the AWS WebSocket API Gateway
  // (WebSocketApiStack) and the handler Lambdas it routes to
  // (WebSocketLambdaFunctionsStack), in either mode; off, neither is built,
  // because a handler nothing can route to is dead weight. In a dev deployment
  // it is the one exception to "only what AWS invokes": API Gateway becomes the
  // handlers' AWS caller. It says nothing about whether WebSockets work locally:
  // local-ws-dev-server runs the same handlers through docker-compose either
  // way, which is what the old "enableWebSockets" name got wrong.
  //
  // Renamed from DEPLOY_WEBSOCKET_API / -c deployWebSocketApi. The old names are
  // refused rather than ignored: a stale DEPLOY_WEBSOCKET_API=true would
  // otherwise drop the WebSocket API with no sign that the flag stopped meaning
  // anything.
  const renamedWebSocketFlags = [
    ...(getContext("deployWebSocketApi") !== undefined ? ["-c deployWebSocketApi"] : []),
    ...(env.DEPLOY_WEBSOCKET_API !== undefined ? ["DEPLOY_WEBSOCKET_API"] : []),
  ];
  if (renamedWebSocketFlags.length > 0) {
    throw new Error(
      `${renamedWebSocketFlags.join(" and ")} ${renamedWebSocketFlags.length > 1 ? "were" : "was"} renamed. Use DEPLOY_PROD_WEBSOCKET_API in cdk-app/.env, or -c deployProdWebSocketApi.`,
    );
  }
  const deployProdWebSocketApiContext = optionalBoolean(
    getContext("deployProdWebSocketApi"),
    "-c deployProdWebSocketApi",
  );
  const enableWebSocketsLegacyContext = optionalBoolean(
    getContext("enableWebSockets"),
    "-c enableWebSockets",
  );

  // Still honored rather than dropped: silently ignoring a stale
  // -c enableWebSockets=true would skip the WebSocket API with no indication that
  // the flag stopped meaning anything.
  if (enableWebSocketsLegacyContext !== undefined) {
    warnings.push(
      "[cdk-app] -c enableWebSockets is deprecated and will be removed. Use -c deployProdWebSocketApi, or set DEPLOY_PROD_WEBSOCKET_API in cdk-app/.env. The old name implied it controlled WebSocket support; it only ever controlled the AWS WebSocket API Gateway.",
    );
  }

  const deployProdWebSocketApi =
    deployProdWebSocketApiContext ??
    enableWebSocketsLegacyContext ??
    booleanFlag({
      context: "deployProdWebSocketApi",
      env: "DEPLOY_PROD_WEBSOCKET_API",
    });

  // Retired. The $connect authorizer declared in framework-config is the one
  // switch now, in both lanes. A leftover `true` changes nothing; a `false` is
  // refused rather than ignored, because it asked for an unauthenticated API
  // that this deployment would no longer build.
  const retiredWsAuthorizer =
    optionalBoolean(getContext("useCustomWsAuthorizer"), "-c useCustomWsAuthorizer") ??
    optionalBoolean(env.USE_CUSTOM_WS_AUTHORIZER, "USE_CUSTOM_WS_AUTHORIZER in cdk-app/.env");
  if (retiredWsAuthorizer === false) {
    throw new Error(
      "USE_CUSTOM_WS_AUTHORIZER=false is no longer supported. The authorizer declared on $connect in framework-config/websocket/routes.ts is always attached; remove that declaration to deploy a WebSocket API without one.",
    );
  }
  if (retiredWsAuthorizer === true) {
    warnings.push(
      "[cdk-app] USE_CUSTOM_WS_AUTHORIZER is no longer read: the $connect authorizer declared in framework-config is always attached. Remove the line from cdk-app/.env.",
    );
  }

  const deploymentName =
    target?.name ??
    stringFlag("cdkAppName", "CDK_APP_NAME") ??
    "matts-aws-framework";

  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(deploymentName)) {
    throw new Error(
      `cdkAppName/CDK_APP_NAME must be 1-63 lowercase letters, numbers, or hyphens, start with a letter, and not end with a hyphen. Received: ${deploymentName}`,
    );
  }

  const readRenamedString = (
    contextKey: string,
    envKey: string,
    legacyContextKey: string,
    legacyEnvKey: string,
  ) => {
    const legacyValue =
      stringFlag(legacyContextKey, legacyEnvKey);

    if (legacyValue !== undefined) {
      warnings.push(
        `[cdk-app] ${legacyEnvKey} / -c ${legacyContextKey} is deprecated and will be removed. Use ${envKey} / -c ${contextKey}.`,
      );
    }

    return (
      stringFlag(contextKey, envKey) ??
      legacyValue
    );
  };

  const resolvedFrontendUrl = readRenamedString(
    "frontendUrl",
    "FRONTEND_URL",
    "prodUrl",
    "PROD_URL",
  );
  const resolvedFrontendCloudFrontCertificateArn = readRenamedString(
    "frontendCloudFrontCertificateArn",
    "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN",
    "prodCloudFrontCertificateArn",
    "PROD_CLOUDFRONT_CERTIFICATE_ARN",
  );

  // Mirrors USE_COGNITO_CUSTOM_DOMAIN, but unlike that one this is meaningful
  // only in cloud mode: the CloudFront distribution that would carry the
  // alternate domain name is not created at all in local dev stack mode. Set it
  // false to keep the domain and certificate parked in .env while deploying on
  // the generated CloudFront URL.
  const useFrontendCustomDomain = booleanFlag({
    context: "useFrontendCustomDomain",
    env: "USE_FRONTEND_CUSTOM_DOMAIN",
    envLabel: "USE_FRONTEND_CUSTOM_DOMAIN",
    fallback: true,
  });

  // Dropping the values here rather than at each use site keeps them out of
  // frontendUrl, trustedFrontendUrls, and the Cognito callback URLs in one place.
  const applyFrontendCustomDomain = mode === "prod" && useFrontendCustomDomain;
  const configuredFrontendUrl = applyFrontendCustomDomain
    ? resolvedFrontendUrl
    : undefined;
  const configuredFrontendCloudFrontCertificateArn = applyFrontendCustomDomain
    ? resolvedFrontendCloudFrontCertificateArn
    : undefined;

  const localhostDevUrl = "http://localhost:3000";
  const localDevUrl = stringFlag("localDevUrl", "LOCAL_DEV_URL") ?? localhostDevUrl;

  const frontendDomainName = configuredFrontendUrl
    ? getDomainNameFromUrl(configuredFrontendUrl, "frontendUrl/FRONTEND_URL")
    : undefined;

  // No mode guard needed: frontendDomainName derives from configuredFrontendUrl,
  // which is already undefined in local dev stack mode and when
  // useFrontendCustomDomain is false.
  if (frontendDomainName && !configuredFrontendCloudFrontCertificateArn) {
    throw new Error(
      "frontendCloudFrontCertificateArn/FRONTEND_CLOUDFRONT_CERTIFICATE_ARN is required when frontendUrl/FRONTEND_URL is configured so CloudFront can attach the alternate domain name.",
    );
  }

  if (frontendDomainName && configuredFrontendCloudFrontCertificateArn) {
    validateUsEast1AcmCertificateArn(
      configuredFrontendCloudFrontCertificateArn,
      "frontendCloudFrontCertificateArn/FRONTEND_CLOUDFRONT_CERTIFICATE_ARN",
      account,
    );
  }

  const cognitoDomainPrefix = getGeneratedCognitoDomainPrefix(deploymentName, account, region);

  // Deliberately independent of the mode: a dev-stack deploy can
  // legitimately use the custom auth domain, which is why this is not folded into
  // the production DNS gate above. Defaults to using the values when they are
  // present, so existing deployments are unaffected; set it false to park the
  // values in .env and fall back to the generated prefix without deleting them.
  const useCognitoCustomDomain = booleanFlag({
    context: "useCognitoCustomDomain",
    env: "USE_COGNITO_CUSTOM_DOMAIN",
    envLabel: "USE_COGNITO_CUSTOM_DOMAIN",
    fallback: true,
  });

  const cognitoDomainNameContext = getContext("cognitoDomainName");
  const configuredCognitoDomainName = useCognitoCustomDomain
    ? (optionalString(cognitoDomainNameContext) ??
      optionalString(env.COGNITO_DOMAIN_NAME))
    : undefined;
  const cognitoDomainName = configuredCognitoDomainName
    ? normalizeDomainName(
        configuredCognitoDomainName,
        "cognitoDomainName/COGNITO_DOMAIN_NAME",
      )
    : undefined;
  const cognitoDomainCertificateArnContext = getContext(
    "cognitoDomainCertificateArn",
  );
  // Dropped together with the domain name: CognitoStack rejects one without the
  // other, so gating only half of the pair would turn the toggle into an error.
  const cognitoDomainCertificateArn = useCognitoCustomDomain
    ? (optionalString(cognitoDomainCertificateArnContext) ??
      optionalString(env.COGNITO_DOMAIN_CERTIFICATE_ARN))
    : undefined;

  if (cognitoDomainName && cognitoDomainCertificateArn) {
    validateUsEast1AcmCertificateArn(
      cognitoDomainCertificateArn,
      "cognitoDomainCertificateArn/COGNITO_DOMAIN_CERTIFICATE_ARN",
      account,
    );
  }

  const googleClientIdContext = getContext("googleClientId");
  const googleClientId = googleClientIdContext
    ? String(googleClientIdContext)
    : env.GOOGLE_CLIENT_ID;
  // The matching secret is deliberately absent here. It used to be read from
  // GOOGLE_CLIENT_SECRET and wrapped in SecretValue.unsafePlainText, which put
  // it in the template in cleartext for anyone who can read the stack. It is a
  // declared secret now - see resources.googleClientSecret - so the value
  // reaches Secrets Manager through npm run deploy:resources, and the template
  // carries a resolve reference to it instead.

  // Container placement used to be one deployment-wide input. It is each
  // task's own declaration now — cloud.subnet, inherited from
  // defaults.container.subnet — in the framework network, so the old inputs
  // are reported rather than silently ignored.
  const retiredTaskNetwork = [
    ["taskVpcId", "TASK_VPC_ID"],
    ["taskSubnetIds", "TASK_SUBNET_IDS"],
    ["taskSecurityGroupIds", "TASK_SECURITY_GROUP_IDS"],
    ["taskAssignPublicIp", "TASK_ASSIGN_PUBLIC_IP"],
  ].filter(([contextKey, name]) => getContext(contextKey!) !== undefined || optionalString(env[name!]) !== undefined)
    .map(([, name]) => name);
  if (retiredTaskNetwork.length > 0) {
    warnings.push(
      `[cdk-app] ${retiredTaskNetwork.join(", ")} ${retiredTaskNetwork.length === 1 ? "is" : "are"} no longer read: tasks run in the framework network, in the subnet each declares as cloud.subnet (inherited from defaults.container.subnet). Remove ${retiredTaskNetwork.length === 1 ? "the line" : "the lines"} from cdk-app/.env.`,
    );
  }

  // The retired password-based Proxy option is not an alias for end-to-end IAM.
  if (getContext("enableRdsProxy") !== undefined) {
    warnings.push(
      "[cdk-app] enableRdsProxy is no longer read. Remove it from cdk.json or the command line; use DATABASE_PROXY_ENABLED or databaseProxyEnabled for end-to-end IAM Proxy connections.",
    );
  }

  // LANGGRAPH_* is deliberately absent. A workload's own deployment inputs are
  // declared beside the workload, on `resources.langgraph` in
  // framework.config.ts, with the names they are read from; the framework
  // resolves them for the workloads a graph actually builds. This file keeps
  // the flags that decide *which* graph is built.

  return {
    stackEnv,
    deploymentName,
    mode,
    databaseBackupRetentionDays,
    database,
    requestedSkipEmailVerification,
    cognitoSesFromEmail,
    cognitoSesFromName,
    cognitoSesRegion,
    retainStatefulResources,
    deployProdWebSocketApi,
    useFrontendCustomDomain,
    configuredFrontendUrl,
    configuredFrontendCloudFrontCertificateArn,
    frontendDomainName,
    localDevUrl,
    localhostDevUrl,
    cognitoDomainPrefix,
    useCognitoCustomDomain,
    cognitoDomainName,
    cognitoDomainCertificateArn,
    googleClientId,
    warnings,
  };
}

export type DeploymentInputs = ReturnType<typeof resolveDeploymentInputs>;

/** Resolve auth/CORS origins and same-origin routing for either frontend hostname. */
export function resolveFrontendSettings(
  deployment: DeploymentInputs,
  cloudFrontUrl?: string,
) {
  const {
    configuredFrontendUrl, requestedSkipEmailVerification, mode,
    localhostDevUrl, localDevUrl,
  } = deployment;
  // A dev deployment serves its browser traffic from a laptop, so localhost is a
  // real origin there and a plaintext one is allowed.
  const isDevDeployment = mode === "dev";
  const frontendUrl = configuredFrontendUrl ?? cloudFrontUrl;
  // Only ever what was asked for. With no frontend URL the custom-message
  // trigger sends Cognito's own code message, so verification still works.
  const skipEmailVerification = requestedSkipEmailVerification;
  // Both hostname choices serve /api on the frontend origin. The generated
  // hostname uses a routing store to avoid a website -> API -> website cycle.
  const useSameOriginApiProxy = mode === "prod" && Boolean(frontendUrl);

  const trustedFrontendUrls = dedupeFrontendUrls([
    ...(frontendUrl ? [frontendUrl] : []),
    // Local origins are a dev-deployment affordance and nothing else. A
    // production stack never trusts one, so LOCAL_DEV_URL cannot put
    // http://localhost:3000 into the production Cognito client's callback
    // list, the API's CORS origins, or the credentialed-request gate.
    ...(isDevDeployment ? [localhostDevUrl, localDevUrl] : []),
  ]);
  trustedFrontendUrls.forEach((url) => assertValidTrustedFrontendUrl(url, isDevDeployment));

  const cognitoFrontendUrls = trustedFrontendUrls.filter(
    isCognitoRedirectOrigin,
  );

  const authCallbackUrls = cognitoFrontendUrls.map(
    (url) => `${url}/auth/callback`,
  );

  return { frontendUrl, skipEmailVerification, useSameOriginApiProxy, trustedFrontendUrls, cognitoFrontendUrls, authCallbackUrls };
}

export function loadDeploymentEnvironment(
  envPath: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const envFile = fs.readFileSync(envPath, "utf8");

  for (const line of envFile.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1);
    let value = rawValue.trim();

    if (!key || env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      // A quoted value keeps everything inside the quotes verbatim.
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at the first "#" that starts the line or follows
      // whitespace, so the annotations in .env.dev.example / .env.prod.example
      // never become values.
      value = rawValue.replace(/(^|\s)#.*$/, "").trim();
    }

    env[key] = value;
  }
}

/**
 * A comma-separated list input, as its non-empty entries.
 *
 * Order is preserved and duplicates are dropped: a repeated subnet id is a typo
 * rather than a request to place tasks there twice.
 */
const splitCsv = (value: string | undefined): readonly string[] => {
  if (!value) return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(entries)];
};

const optionalString = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const stringValue = String(value);
  return stringValue.trim() ? stringValue : undefined;
};

// These flags decide what real cloud infrastructure is created, so a
// typo must not quietly coerce to a value nobody asked for. Anything other than
// "true"/"false" is an error rather than a truthiness test.
const optionalBoolean = (value: unknown, label: string) => {
  const stringValue = optionalString(value);

  if (stringValue === undefined) {
    return undefined;
  }

  const normalizedValue = stringValue.trim().toLowerCase();

  if (normalizedValue === "true") {
    return true;
  }

  if (normalizedValue === "false") {
    return false;
  }

  throw new Error(
    `${label} must be "true" or "false". Received: ${stringValue}`,
  );
};

const normalizeFrontendUrl = (url: string) =>
  cdk.Token.isUnresolved(url) ? url : url.trim().replace(/\/+$/, "");

// Cognito rejects a hosted-UI prefix containing any of these, with only
// "Invalid request provided: AWS::Cognito::UserPoolDomain" to explain itself.
// The default cdkAppName ("matts-aws-framework") contains "aws", so the
// generated prefix has to strip them rather than pass the name through.
const COGNITO_RESERVED_WORDS = ["aws", "amazon", "cognito"];

const stripCognitoReservedWords = (value: string) =>
  COGNITO_RESERVED_WORDS.reduce(
    (result, word) => result.replaceAll(word, ""),
    value,
  )
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

const getGeneratedCognitoDomainPrefix = (deploymentName: string, account: string, region: string) => {
  // Only the app name can carry a reserved word; the account id and region
  // cannot, so they stay verbatim and keep the prefix globally unique.
  const safeDeploymentName =
    stripCognitoReservedWords(deploymentName) || "app";
  const rawPrefix = `${safeDeploymentName}-${account}-${region}`;

  if (rawPrefix.length <= 63) {
    return rawPrefix;
  }

  const hash = createHash("sha256").update(rawPrefix).digest("hex").slice(0, 8);
  const suffix = `-${account}-${region}-${hash}`;
  const maxDeploymentNameLength = 63 - suffix.length;
  const shortenedDeploymentName = safeDeploymentName
    .slice(0, maxDeploymentNameLength)
    .replace(/-+$/, "");

  return `${shortenedDeploymentName}${suffix}`;
};

const normalizeDomainName = (value: string, label: string) => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${label} must not be empty.`);
  }

  try {
    return new URL(trimmedValue).hostname;
  } catch {
    try {
      return new URL(`https://${trimmedValue}`).hostname;
    } catch {
      throw new Error(
        `${label} must be a bare domain name or an absolute URL. Received: ${value}`,
      );
    }
  }
};

const validateUsEast1AcmCertificateArn = (
  certificateArn: string,
  label: string,
  account: string,
) => {
  if (cdk.Token.isUnresolved(certificateArn)) {
    return;
  }

  const arnParts = certificateArn.split(":");
  const [arnPrefix, partition, service, certificateRegion, certificateAccount] =
    arnParts;
  const resource = arnParts.slice(5).join(":");

  if (
    arnPrefix !== "arn" ||
    !partition ||
    service !== "acm" ||
    !/^certificate\/[0-9a-f-]+$/i.test(resource)
  ) {
    throw new Error(
      `${label} must be an ACM certificate ARN. Received: ${certificateArn}`,
    );
  }

  if (certificateRegion !== "us-east-1") {
    throw new Error(
      `${label} must reference an ACM certificate in us-east-1. Received region: ${certificateRegion}`,
    );
  }

  if (certificateAccount !== account) {
    throw new Error(
      `${label} must reference an ACM certificate in the same AWS account as this deployment (${account}). Received account: ${certificateAccount}`,
    );
  }
};

const getDomainNameFromUrl = (url: string, label: string) => {
  const normalizedUrl = normalizeFrontendUrl(url);

  if (cdk.Token.isUnresolved(normalizedUrl)) {
    return undefined;
  }

  try {
    return new URL(normalizedUrl).hostname;
  } catch {
    throw new Error(`${label} must be an absolute URL. Received: ${url}`);
  }
};

const isLoopbackHttpUrl = (url: string) => {
  if (cdk.Token.isUnresolved(url) || !url.startsWith("http://")) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "[::1]" ||
      parsedUrl.hostname === "::1"
    );
  } catch {
    return false;
  }
};

// A LAN HTTP origin can be trusted for CORS and native auth, but Cognito
// refuses it as a hosted-UI redirect: HTTP callbacks are loopback-only.
const isCognitoRedirectOrigin = (url: string) =>
  cdk.Token.isUnresolved(url) ||
  url.startsWith("https://") ||
  isLoopbackHttpUrl(url);

const assertValidTrustedFrontendUrl = (url: string, isDevDeployment: boolean) => {
  if (
    isDevDeployment ||
    cdk.Token.isUnresolved(url) ||
    url.startsWith("https://") ||
    isLoopbackHttpUrl(url)
  ) {
    return;
  }

  throw new Error(
    `Production trusted frontend URLs must use HTTPS except for localhost testing URLs. Received: ${url}`,
  );
};

const dedupeFrontendUrls = (urls: string[]) => {
  const seenUrls = new Set<string>();
  const uniqueUrls: string[] = [];

  for (const url of urls) {
    const normalizedUrl = normalizeFrontendUrl(url);

    if (!normalizedUrl) {
      continue;
    }

    // Repeated references to the same CDK token resolve to the same origin too.
    // Keep token strings intact, but deduplicate them just like literal URLs.
    if (seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    uniqueUrls.push(normalizedUrl);
  }

  return uniqueUrls;
};
