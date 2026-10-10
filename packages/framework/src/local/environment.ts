import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readAuthoredInputs } from "@repo/framework/config/source";
import {
  getConnectsToBindings, normalizeFrameworkConfig, resolveLambdaTarget, isResourceAbsent, isResourceReference, resourceAttributeKey,
  formatResourceReference, resolveResourceFromEnv, parseResourceManifest, RESOURCE_MANIFEST_FILE,
  type FrameworkConfig, type ResourceManifest, type ResourceReference, type TargetReference,
} from "@repo/framework/config";
import { localInvocationDescriptors } from "./invocation";
import { LOCAL_PRIMARY_DATABASE_URL } from "./resources";

/** The one authored-input reader, under the name the local lane already calls it. */
export const readAuthoredLocalInputs = readAuthoredInputs;

export function readLocalResourceManifest(repositoryRoot: string, environment: NodeJS.ProcessEnv = process.env): ResourceManifest | undefined {
  const file = environment.FRAMEWORK_RESOURCES_FILE ?? path.join(repositoryRoot, RESOURCE_MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  return parseResourceManifest(readFileSync(file, "utf8"), {
    deployment: environment.LOCAL_FRAMEWORK_DEPLOYMENT,
    account: environment.LOCAL_FRAMEWORK_ACCOUNT,
    region: environment.AWS_REGION ?? environment.LOCAL_AWS_REGION,
  });
}

/** Deliberate platform inputs only. Other workloads' variables never cross this boundary. */
export function localPlatformEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_SDK_LOAD_CONFIG", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "LOCAL_INVOCATION_RUNNER_URL", "LOCAL_WEBSOCKET_CONNECTIONS_URL", "LOCAL_BROWSER_ORIGINS"];
  return Object.fromEntries(names.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]]));
}

export interface LocalEnvironmentOptions {
  readonly repositoryRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authored?: Readonly<Record<string, string>>;
  readonly manifest?: ResourceManifest;
  readonly readSecret?: (arn: string) => Promise<string>;
  readonly runnerUrl?: string;
}

/** Resolve once per process launch, before application modules read process.env. */
export async function resolveLocalWorkloadEnvironment(config: FrameworkConfig, targetId: TargetReference, options: LocalEnvironmentOptions): Promise<Record<string, string>> {
  const target = normalizeFrameworkConfig(config).targets.get(targetId);
  if (!target) throw new Error(`Unknown local workload ${targetId}.`);
  const platform = options.environment ?? process.env;
  const authored = options.authored ?? readAuthoredLocalInputs(options.repositoryRoot, platform);
  const manifest = options.manifest ?? readLocalResourceManifest(options.repositoryRoot, platform);
  const environment: Record<string, string> = localPlatformEnvironment(platform);
  const input = (reference: ResourceReference): string | undefined => {
    if (isResourceAbsent(reference)) return undefined;
    if (reference.fromEnv && !reference.secretArn && reference.kind !== "secret") {
      return resolveResourceFromEnv(reference, { env: authored }, targetId) as string | undefined;
    }
    const value = manifest?.attributes[resourceAttributeKey(reference)];
    if (value === undefined && !reference.optional) throw new Error(`${targetId}: ${formatResourceReference(reference)} is missing from the development resource manifest. Deploy and export the development graph.`);
    return value;
  };
  for (const [name, value] of Object.entries(target.environment)) {
    const resolved = typeof value === "string" ? value : input(value);
    if (resolved !== undefined) environment[name] = resolved;
  }
  const fetched = new Map<string, Promise<string>>();
  const client = new SecretsManagerClient({ region: manifest?.region ?? platform.AWS_REGION });
  const readSecret = options.readSecret ?? (async (arn: string) => {
    try {
      const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      if (result.SecretString === undefined) throw new Error("Binary secrets cannot be injected as environment variables.");
      return result.SecretString;
    } catch { throw new Error(`${targetId}: unable to read a declared development secret. Check the selected AWS profile and secret access.`); }
  });
  try {
    for (const [name, reference] of Object.entries(target.secrets)) {
      if (isResourceAbsent(reference)) continue;
      let value = reference.fromEnv ? authored[reference.fromEnv] : undefined;
      if (!reference.fromEnv) {
        const arn = input(reference);
        if (arn !== undefined) {
          if (!fetched.has(arn)) fetched.set(arn, readSecret(arn));
          value = await fetched.get(arn)!;
        }
      }
      if (value === undefined || value === "") continue;
      if (reference.secretField) {
        let document: unknown;
        try { document = JSON.parse(value); } catch { throw new Error(`${targetId}: ${formatResourceReference(reference)} is not a JSON secret.`); }
        value = document && typeof document === "object" ? (document as Record<string, string>)[reference.secretField] : undefined;
        if (typeof value !== "string") throw new Error(`${targetId}: the declared secret field is missing or is not a string.`);
      }
      environment[name] = value;
    }
  } finally { client.destroy(); }
  for (const requirement of target.cloud.requirements) {
    if (requirement.when && input(requirement.when.resource) !== requirement.when.equals) continue;
    for (const reference of requirement.require) {
      if (isResourceAbsent(reference)) continue;
      const present = reference.kind === "secret"
        ? Object.entries(target.secrets).some(([name, declared]) => JSON.stringify(declared.path) === JSON.stringify(reference.path) && environment[name] !== undefined) || Object.entries(target.environment).some(([name, declared]) => isResourceReference(declared) && declared.secretArn && JSON.stringify(declared.path) === JSON.stringify(reference.path) && environment[name] !== undefined)
        : input(reference) !== undefined;
      if (!present) throw new Error(`${targetId}: ${formatResourceReference(reference)} is required. ${requirement.message ?? ""}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(target.environment, "TRUSTED_FRONTEND_ORIGINS") && platform.LOCAL_BROWSER_ORIGINS) environment.TRUSTED_FRONTEND_ORIGINS = platform.LOCAL_BROWSER_ORIGINS;
  // The network's rules hold here as they do in AWS, so a workload that works
  // locally works there. The Compose database stands in for the application's
  // database, and only for a workload that declares database: true: one that
  // does not gets nothing here, as it would get no route there. A Lambda in
  // the VPC calls AWS's dual-stack endpoints, as it has to from the private
  // subnets.
  if (getConnectsToBindings(target.cloud.bindings).length > 0) {
    environment.PRIMARY_DATABASE_URL = platform.PRIMARY_DATABASE_URL ?? LOCAL_PRIMARY_DATABASE_URL;
  }
  if (target.kind === "lambda" && resolveLambdaTarget(config, target.id).vpc) environment.AWS_USE_DUALSTACK_ENDPOINT = "true";
  if (target.kind !== "workflow") Object.assign(environment, localInvocationDescriptors(config, targetId, options.runnerUrl ?? platform.LOCAL_INVOCATION_RUNNER_URL ?? "http://local-invocation-runner:8090"));
  return environment;
}
