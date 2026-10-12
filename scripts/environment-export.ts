/**
 * The root .env block `npm run export:cdk-outputs` owns, rendered one way for a
 * development and a production deployment: titled sections, each name written
 * once, ending with the client-app settings a developer copies as they stand.
 */

export const CLIENT_SECTION_HEADING = "Client app: copy this block into client-app/.env";

// Output values are literal data. Compose decodes double-quoted escapes and
// treats \$ as a literal dollar sign rather than another environment reference.
export function quoteOutputValue(value: string): string {
  return /^[A-Za-z0-9_./:@?=+-]*$/.test(value)
    ? value
    : JSON.stringify(value).replaceAll("$", "\\$");
}

export interface EnvironmentSection {
  readonly heading: string;
  /** An undefined value is left out; an empty string is written as an empty assignment. */
  readonly values: Readonly<Record<string, string | undefined>>;
}

/** Sections with nothing to write are omitted, and a name in two sections is refused. */
export function renderGeneratedBlock(
  header: readonly string[],
  sections: readonly EnvironmentSection[],
  formatValue: (name: string, value: string) => string = (_name, value) => quoteOutputValue(value),
): { block: string; names: string[] } {
  const names = new Set<string>();
  const rendered: string[] = [];
  for (const { heading, values } of sections) {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (names.has(name)) throw new Error(`${name} is exported twice. Each generated name belongs to exactly one section.`);
      names.add(name);
      lines.push(`${name}=${formatValue(name, value)}`);
    }
    if (lines.length) rendered.push([`# ${heading}`, ...lines].join("\n"));
  }
  const block = [
    "# BEGIN GENERATED CDK OUTPUTS",
    ...header.map((line) => `# ${line}`),
    "",
    rendered.join("\n\n"),
    "# END GENERATED CDK OUTPUTS",
    "",
  ].join("\n");
  return { block, names: [...names] };
}

export interface ClientEnvironmentInput {
  readonly region: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly cognitoDomainUrl: string;
  /** What serves /api and the agent routes on their public paths: Vite's proxy target. */
  readonly apiUrl: string;
  /** local-ws-dev-server on its host port. Empty when Compose runs none, as in production. */
  readonly localWebSocketUrl: string;
  /** The deployed API Gateway WebSocket stage. Empty when this deployment has no WebSocketApiStack. */
  readonly apiGatewayWebSocketUrl: string;
  /** Empty when no WebSocket tester runs, as in production. */
  readonly webSocketTesterUrl: string;
}

/**
 * Every setting client-app reads, in client-app/.env.example's order.
 *
 * Empty values are written rather than dropped, so pasting the block over a
 * client-app/.env from the other mode clears what this mode does not have.
 */
export function clientEnvironment(input: ClientEnvironmentInput) {
  const domain = new URL(input.cognitoDomainUrl);
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.search || domain.hash || domain.pathname !== "/") {
    throw new Error("The deployed Cognito domain must be an HTTPS origin.");
  }
  return {
    VITE_API_GATEWAY_URL: url(input.apiUrl, ["http:", "https:"], "VITE_API_GATEWAY_URL"),
    VITE_LOCAL_WS_URL: input.localWebSocketUrl && url(input.localWebSocketUrl, ["ws:", "wss:"], "VITE_LOCAL_WS_URL"),
    VITE_API_GATEWAY_WS_URL: input.apiGatewayWebSocketUrl && url(input.apiGatewayWebSocketUrl, ["ws:", "wss:"], "VITE_API_GATEWAY_WS_URL"),
    VITE_WS_TESTER_URL: input.webSocketTesterUrl && url(input.webSocketTesterUrl, ["http:", "https:"], "VITE_WS_TESTER_URL"),
    VITE_AWS_REGION: input.region,
    VITE_USER_POOL_ID: input.userPoolId,
    VITE_USER_POOL_CLIENT_ID: input.userPoolClientId,
    VITE_COGNITO_DOMAIN: domain.origin,
  };
}

export type ClientEnvironment = ReturnType<typeof clientEnvironment>;

function url(value: string, protocols: readonly string[], name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} must use ${protocols.join(" or ")}. Received: ${value}`);
  return value;
}
