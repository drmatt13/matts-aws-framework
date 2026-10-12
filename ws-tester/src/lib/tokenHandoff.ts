export function consumeLaunchToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (token) {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return token;
}

/**
 * The query parameters client-app opens this tester with, one per panel. They
 * are not secret, so they stay in the query, where a reload still finds them;
 * only the token travels in the fragment.
 */
export const LAUNCH_URL_PARAMS = {
  local: "localWsUrl",
  apiGateway: "apiGatewayWsUrl",
} as const;

/**
 * The connection URL a launch link names in `param`, or `fallback` (this
 * tester's own Compose setting) when it names none. A value that is not a
 * ws: or wss: URL is ignored rather than prefilled.
 */
export function launchConnectionUrl(param: string, fallback: string | undefined): string {
  const value = new URLSearchParams(window.location.search).get(param)?.trim();
  if (value) {
    try {
      if (["ws:", "wss:"].includes(new URL(value).protocol)) return value;
    } catch {
      // Not a URL: use the fallback.
    }
  }
  return fallback?.trim() ?? "";
}

export function connectionUrlWithToken(value: string, token: string | null): string {
  if (!value || !token) return value;
  const url = new URL(value);
  url.searchParams.set("token", token);
  return url.toString();
}
