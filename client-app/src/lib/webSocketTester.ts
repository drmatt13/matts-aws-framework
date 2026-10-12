/**
 * The query parameters ws-tester reads to prefill its panels: left for
 * local-ws-dev-server, right for the deployed API Gateway stage. Kept in step
 * with LAUNCH_URL_PARAMS in ws-tester/src/lib/tokenHandoff.ts.
 */
const LAUNCH_URL_PARAMS = {
  local: "localWsUrl",
  apiGateway: "apiGatewayWsUrl",
} as const;

export interface WebSocketEndpoints {
  /** VITE_LOCAL_WS_URL. Empty or absent leaves the tester's own default. */
  readonly local?: string;
  /** VITE_API_GATEWAY_WS_URL. Empty or absent leaves the tester's own default. */
  readonly apiGateway?: string;
}

/**
 * The tester link with each configured endpoint in its query. The token, when
 * given, goes in the fragment, which is never sent with the request and which
 * the tester clears on load.
 */
export function webSocketTesterUrl(
  testerUrl: string,
  endpoints: WebSocketEndpoints,
  token?: string,
): string {
  const destination = new URL(testerUrl);
  for (const [key, param] of Object.entries(LAUNCH_URL_PARAMS)) {
    const value = endpoints[key as keyof WebSocketEndpoints]?.trim();
    if (value) destination.searchParams.set(param, value);
  }
  if (token) destination.hash = new URLSearchParams({ token }).toString();
  return destination.toString();
}
