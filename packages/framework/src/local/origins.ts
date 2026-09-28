const DEFAULT_LOCAL_BROWSER_ORIGIN = "http://localhost:3000";

/**
 * Browser origins the local dev servers trust, from LOCAL_BROWSER_ORIGINS.
 *
 * Shared by the API server (CORS, and the TRUSTED_FRONTEND_ORIGINS default it
 * hands the auth lambdas) and the WebSocket server (upgrade allowlist), so the
 * two cannot disagree about what is trusted.
 *
 * Values are validated rather than passed through: a stray path or a bare
 * hostname in an allowlist tends to fail open somewhere downstream.
 */
export function getLocalBrowserOrigins(): string[] {
  const configuredOrigins =
    process.env.LOCAL_BROWSER_ORIGINS ?? DEFAULT_LOCAL_BROWSER_ORIGIN;
  const origins = new Set<string>();

  for (const value of configuredOrigins.split(",")) {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(trimmedValue);
    } catch {
      throw new Error(
        `LOCAL_BROWSER_ORIGINS contains an invalid URL: ${trimmedValue}`,
      );
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin === "null" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `LOCAL_BROWSER_ORIGINS values must be HTTP(S) origins without paths, queries, or fragments: ${trimmedValue}`,
      );
    }

    origins.add(url.origin);
  }

  if (origins.size === 0) {
    throw new Error("LOCAL_BROWSER_ORIGINS must contain at least one origin");
  }

  return [...origins];
}
