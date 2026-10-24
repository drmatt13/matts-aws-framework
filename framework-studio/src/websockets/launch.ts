/**
 * How a launch link hands the WebSockets page its connection URLs and a Cognito
 * token. Ported unchanged from ws-tester/src/lib/tokenHandoff.ts, so client-app's
 * launch link (client-app/src/lib/webSocketTester.ts) works against either page.
 */

/**
 * The token from the URL fragment, removed from the address bar and history at
 * once. A fragment is never sent with the HTTP request.
 */
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
 * The query parameters client-app opens the tester with, one per panel. They
 * are not secret, so they stay in the query, where a reload still finds them;
 * only the token travels in the fragment.
 */
export const LAUNCH_URL_PARAMS = {
  local: "localWsUrl",
  apiGateway: "apiGatewayWsUrl",
} as const;

/**
 * The connection URL a launch link names in `param`, or `fallback` (the
 * Compose setting) when it names none. A value that is not a ws: or wss: URL
 * is ignored rather than prefilled.
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
