import * as cdk from "aws-cdk-lib";
import { createHash } from "crypto";
import * as fs from "fs";
import type { CloudMode } from "@repo/framework/config";

/** Application-owned deployment policy. See docs/FRAMEWORK.md#configuration-and-environment.
 * Importing this module never reads .env, creates an App, or generates code.
 */
export interface DeploymentSources {
  getContext: (key: string) => unknown;
  env: Readonly<Record<string, string | undefined>>;
}

export function resolveDeploymentInputs({ getContext, env }: DeploymentSources) {
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
      "CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set for VPC lookup.",
    );
  }

  const stackEnv: cdk.Environment = {
    account,
    region,
  };

  const useLocalDevStackContext = optionalBoolean(
    getContext("useLocalDevStack"),
    "-c useLocalDevStack",
  );
  const prodDeploymentContext = optionalBoolean(
    getContext("prodDeployment"),
    "-c prodDeployment",
  );
  const prodDeploymentEnv = optionalBoolean(
    env.PROD_DEPLOYMENT,
    "PROD_DEPLOYMENT",
  );

  const useLocalDevStack =
    useLocalDevStackContext ??
    (prodDeploymentContext !== undefined
      ? !prodDeploymentContext
      : prodDeploymentEnv !== undefined
        ? !prodDeploymentEnv
        : true);

  // The one derived value the graph is built from. Resolved here so no stack has
  // to re-answer "which deployment is this" from something else it can see -
  // whether an RDS stack happened to be created, say.
  const mode: CloudMode = useLocalDevStack ? "dev" : "prod";

  // Name the ignored input rather than mutating it: reporting "PROD_DEPLOYMENT is
  // now false" would contradict the value still sitting in .env.
  //
  // prodDeployment=P asks for useLocalDevStack=!P, so P === L is the
  // disagreement, not P === !L.
  const warnOverriddenBy = (ignoredInput: string) => {
    warnings.push(
      `[cdk-app] ${ignoredInput} is overridden by -c useLocalDevStack=${useLocalDevStackContext}. Deploying in ${mode} mode.`,
    );
  };

  if (useLocalDevStackContext !== undefined) {
    if (prodDeploymentContext === useLocalDevStackContext) {
      warnOverriddenBy(`-c prodDeployment=${prodDeploymentContext}`);
    } else if (prodDeploymentEnv === useLocalDevStackContext) {
      warnOverriddenBy(
        `PROD_DEPLOYMENT=${prodDeploymentEnv} in cdk-app/.env`,
      );
    }
  }

  // Optional prod-mode flag. Defaults to false and is force-disabled in a dev
  // deployment. Creates the RDS Proxy layer for cloud deployments.
  const enableRdsProxy =
    mode === "prod" && booleanFlag({ context: "enableRdsProxy" });

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
  const databaseBackupRetentionDays = optionalInteger(
    stringFlag("databaseBackupRetentionDays", "DATABASE_BACKUP_RETENTION_DAYS"),
    "DATABASE_BACKUP_RETENTION_DAYS",
    { min: 0, max: 35 },
  ) ?? 7;

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
  // deployWebSocketApi creates the AWS WebSocket API Gateway (WebSocketApiStack)
  // and the handler Lambdas it routes to (WebSocketLambdaFunctionsStack); off,
  // neither is built, because a handler nothing can route to is dead weight. It
  // says nothing about whether WebSockets work locally: local-ws-dev-server runs
  // the same handlers through docker-compose either way, which is what the old
  // "enableWebSockets" name got wrong.
  const deployWebSocketApiContext = optionalBoolean(
    getContext("deployWebSocketApi"),
    "-c deployWebSocketApi",
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
      "[cdk-app] -c enableWebSockets is deprecated and will be removed. Use -c deployWebSocketApi, or set DEPLOY_WEBSOCKET_API in cdk-app/.env. The old name implied it controlled WebSocket support; it only ever controlled the AWS WebSocket API Gateway.",
    );
  }

  const deployWebSocketApi =
    deployWebSocketApiContext ??
    enableWebSocketsLegacyContext ??
    booleanFlag({
      context: "deployWebSocketApi",
      env: "DEPLOY_WEBSOCKET_API",
    });

  // Reported rather than silently dropped: a WebSocket route is opened by a
  // browser, so a dev deployment builds no handlers for the API to reach and
  // the flag has nothing to act on. `npm run dev` serves the same routes
  // through local-ws-dev-server.
  if (deployWebSocketApi && mode === "dev") {
    warnings.push(
      "[cdk-app] DEPLOY_WEBSOCKET_API is set, but a dev deployment builds no WebSocket handlers for it to route to. Serve them locally with npm run dev, or deploy with PROD_DEPLOYMENT=true.",
    );
  }

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

  // Deliberately independent of PROD_DEPLOYMENT: a dev-stack deploy can
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
  // reaches Secrets Manager through npm run secrets:sync, and the template
  // carries a resolve reference to it instead.

  // Where framework container tasks are placed, as one deployment input.
  //
  // Infrastructure placement is deliberately *not* in the resource catalog: the
  // catalog describes application inputs, and workload code never consumes a
  // subnet id. A runtime caller receives a resolved launch configuration and
  // chooses no network.
  //
  // Absent, tasks use the default VPC's public subnets with a public IP, which
  // is what makes an image pull work with no VPC endpoints. Task-scoped on
  // purpose: it reconfigures neither RDS nor existing services.
  const taskSubnetIds = splitCsv(stringFlag("taskSubnetIds", "TASK_SUBNET_IDS"));
  const taskSecurityGroupIds = splitCsv(
    stringFlag("taskSecurityGroupIds", "TASK_SECURITY_GROUP_IDS"),
  );
  const taskVpcId = stringFlag("taskVpcId", "TASK_VPC_ID");
  const taskAssignPublicIp = optionalBoolean(
    getContext("taskAssignPublicIp"),
    "-c taskAssignPublicIp",
  ) ?? optionalBoolean(env.TASK_ASSIGN_PUBLIC_IP, "TASK_ASSIGN_PUBLIC_IP in cdk-app/.env");

  if (taskSubnetIds.length > 0 && !taskVpcId) {
    throw new Error(
      "TASK_SUBNET_IDS is set without TASK_VPC_ID. v1 places every task in one VPC, so the VPC has to be named explicitly when its subnets are.",
    );
  }
  if (taskSecurityGroupIds.length > 0 && !taskVpcId) {
    throw new Error(
      "TASK_SECURITY_GROUP_IDS is set without TASK_VPC_ID. Name the VPC the groups belong to.",
    );
  }

  const taskNetwork = {
    ...(taskVpcId ? { vpcId: taskVpcId } : {}),
    ...(taskSubnetIds.length > 0 ? { subnetIds: taskSubnetIds } : {}),
    ...(taskSecurityGroupIds.length > 0
      ? { securityGroupIds: taskSecurityGroupIds }
      : {}),
    ...(taskAssignPublicIp === undefined
      ? {}
      : { assignPublicIp: taskAssignPublicIp }),
  };

  // LANGGRAPH_* is deliberately absent. A workload's own deployment inputs are
  // declared beside the workload, on `resources.langgraph` in
  // framework.config.ts, with the names they are read from; the framework
  // resolves them for the workloads a graph actually builds. This file keeps
  // the flags that decide *which* graph is built.

  return {
    stackEnv,
    deploymentName,
    mode,
    taskNetwork,
    enableRdsProxy,
    databaseBackupRetentionDays,
    requestedSkipEmailVerification,
    cognitoSesFromEmail,
    cognitoSesFromName,
    cognitoSesRegion,
    retainStatefulResources,
    deployWebSocketApi,
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

/** Resolve the values that depend on the optional, newly constructed website.
 * A configured origin excludes the CloudFront token: the website depends on
 * HTTP API, whose CORS configuration must not depend back on the website.
 */
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
  // When the SPA reaches the API through CloudFront's /api/* behavior, all
  // browser traffic arrives on the prod domain, so the CloudFront URL is not a
  // frontend origin. It must also be dropped from this list to avoid a cycle:
  // HttpApiGatewayStack consumes trustedFrontendUrls for CORS, while
  // FrontendWebsiteS3Stack now depends on HttpApiGatewayStack.
  const useSameOriginApiProxy = Boolean(configuredFrontendUrl);

  const trustedFrontendUrls = dedupeFrontendUrls([
    ...(!useSameOriginApiProxy && cloudFrontUrl ? [cloudFrontUrl] : []),
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

// PROD_DEPLOYMENT decides whether real cloud infrastructure is created, so a
// typo must not quietly coerce to a mode nobody asked for. Anything other than
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

const optionalInteger = (
  value: string | undefined,
  label: string,
  range: { readonly min: number; readonly max: number },
) => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || parsed < range.min || parsed > range.max) {
    throw new Error(
      `${label} must be a whole number from ${range.min} to ${range.max}. Received: ${value}`,
    );
  }
  return parsed;
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

    if (!cdk.Token.isUnresolved(normalizedUrl)) {
      if (seenUrls.has(normalizedUrl)) {
        continue;
      }

      seenUrls.add(normalizedUrl);
    }

    uniqueUrls.push(normalizedUrl);
  }

  return uniqueUrls;
};
