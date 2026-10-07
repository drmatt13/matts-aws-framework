import { fromIni } from "@aws-sdk/credential-providers";

export const awsRegion = () =>
  process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "us-east-1";

/**
 * AWS_PROFILE is a local-development concept: it names an entry in the
 * developer's ~/.aws config, which docker-compose bind-mounts into the
 * invocation runner that hosts local agent sessions. AgentCore Runtime has no
 * such file -- it receives credentials from the agent's execution role via the
 * SDK's default provider chain.
 *
 * So the presence of AWS_PROFILE is the switch between the two worlds, and the
 * framework never sets it on a deployed Runtime.
 */
export const awsProfile = () => process.env.AWS_PROFILE?.trim() || undefined;

/**
 * Memoize a per-(profile, region) value.
 *
 * Credential and token providers do their own caching and refreshing
 * internally, so a fresh one per call would re-read the credentials file and
 * re-mint tokens on every model construction. Reading the environment on each
 * call rather than at import time keeps the provider aligned with the current
 * process environment; the cache key makes that cheap.
 */
function memoizePerIdentity<T>(create: (profile: string | undefined, region: string) => T) {
  let cached: { key: string; value: T } | undefined;

  return (profile: string | undefined, region: string): T => {
    const key = `${profile ?? ""}|${region}`;

    if (cached?.key !== key) {
      cached = { key, value: create(profile, region) };
    }

    return cached.value;
  };
}

const iniCredentials = memoizePerIdentity((profile, region) =>
  fromIni({ ...(profile ? { profile } : {}), clientConfig: { region } }),
);

/**
 * Credentials for the AWS SDK, or `undefined` to let the SDK resolve them
 * itself. Returning `undefined` is the Runtime path: the default provider chain
 * picks up the execution role. Passing an explicit `fromIni` provider there
 * would fail, because there is no shared credentials file to read.
 *
 * `fromIni` supports plain credentials, assumed roles, and IAM Identity
 * Center/SSO profiles.
 */
export const awsCredentials = () => {
  const profile = awsProfile();

  if (!profile) {
    return undefined;
  }

  return iniCredentials(profile, awsRegion());
};

export { memoizePerIdentity };
