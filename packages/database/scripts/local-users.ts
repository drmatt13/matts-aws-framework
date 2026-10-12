/**
 * Guards shared by the Compose steps that change local users to match the dev
 * Cognito pool: prune-cognito-orphans and seed-test-user.
 */

const LOCAL_DATABASE_HOSTS = new Set([
  "postgres",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Accepts only the Compose database or one on this machine. These steps delete
 * and create rows, so a stray URL must never point them at a shared database.
 */
export function localDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("DATABASE_URL is required.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!LOCAL_DATABASE_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to change users in a database on ${url.hostname}: only the local Compose database may be changed.`,
    );
  }

  return value;
}

/** The region a pool id names, e.g. eu-west-2 for eu-west-2_Abc. */
export function userPoolRegion(userPoolId: string): string | undefined {
  return /^([a-z]{2}(?:-[a-z]+)+-\d+)_/.exec(userPoolId)?.[1];
}
