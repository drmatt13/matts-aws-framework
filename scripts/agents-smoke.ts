/**
 * Exercises the echo sample in a disposable AWS deployment: Runtime, Gateway and
 * tool Lambda, the user's identity across all three, and every refusal.
 *
 * Needs a prod-mode deployment whose CDK_APP_NAME contains "smoke", with the
 * echo sample set to `deploy: "both"` (docs/AGENTCORE.md, "Smoke test in AWS").
 * Creates two throwaway users in that deployment's own user pool and deletes
 * them before it exits. It refuses any other deployment, so it cannot touch a
 * shared pool.
 *
 * Prints verdicts and HTTP statuses only. Tokens, passwords and bodies stay in
 * memory; anything shaped like a JWT is redacted before it is printed.
 *
 *   npm run agents:smoke -- --app <name> [--region us-east-1] [--profile p]
 *     [--frontend https://agents-smoke.example.com] [--include-expiry]
 */
import { execFileSync } from "node:child_process";
import framework from "../framework.config";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetGatewayCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { AGENTCORE_TOOLS, gatewayInputSchema } from "@repo/framework/config";
import { agentSessionId } from "@repo/framework/runtime/agentcore";

const AGENT = "echo-agent";
const TOOL = "echo";
// The wire as AWS sees it, written out rather than imported: this script checks
// the deployed system against the protocol, not the framework against itself.
const WIRE_NAME = `${TOOL}___${TOOL}`;
const IDENTITY_ARGUMENT = "__framework_identity";
const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const app = option("app");
const region = option("region") ?? process.env.AWS_REGION ?? "us-east-1";
const profile = option("profile") ?? process.env.AWS_PROFILE;
const frontend = option("frontend")?.replace(/\/+$/, "");
const includeExpiry = process.argv.includes("--include-expiry");
if (profile) process.env.AWS_PROFILE = profile;
process.env.AWS_REGION = region;

const JWT_SHAPE = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;
function redact(text: string, limit = 240): string {
  const clean = text.replace(JWT_SHAPE, "[jwt]").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

const results: { readonly name: string; readonly ok: boolean; readonly detail: string }[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail: redact(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${redact(detail)}` : ""}`);
}
function observe(name: string, detail: string): void {
  console.log(`NOTE  ${name} — ${redact(detail)}`);
}

// ---------------------------------------------------------------------------
// Discovery: the deployment's own resources, nothing else
// ---------------------------------------------------------------------------

function aws(args: readonly string[]): unknown {
  return JSON.parse(
    execFileSync("aws", [...args, "--output", "json", "--region", region, ...(profile ? ["--profile", profile] : [])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

interface StackResource {
  readonly LogicalResourceId: string;
  readonly PhysicalResourceId: string;
  readonly ResourceType: string;
}

function stackResources(stack: string): readonly StackResource[] {
  const reply = aws(["cloudformation", "describe-stack-resources", "--stack-name", `${app}-${stack}`]) as {
    StackResources: StackResource[];
  };
  return reply.StackResources;
}

function only(resources: readonly StackResource[], type: string): string {
  const found = resources.filter((resource) => resource.ResourceType === type);
  if (found.length !== 1) throw new Error(`Expected one ${type}, found ${found.length}. Deploy only the echo sample.`);
  // Ref is an id for some types and an ARN for others; the id ends either.
  return found[0].PhysicalResourceId.split("/").pop()!;
}

// ---------------------------------------------------------------------------
// Users: two throwaway accounts in the smoke deployment's pool
// ---------------------------------------------------------------------------

interface SmokeUser {
  readonly username: string;
  readonly sub: string;
  readonly idToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

function claims(token: string): { sub: string; exp: number } {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; exp: number };
}

/** The same token with a different subject: a valid shape whose signature no longer matches. */
function tampered(token: string): string {
  const [header, payload, signature] = token.split(".");
  const body = { ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), sub: randomUUID() };
  return [header, Buffer.from(JSON.stringify(body)).toString("base64url"), signature].join(".");
}

async function createUser(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
  label: string,
): Promise<SmokeUser> {
  const username = `agents-smoke-${label}-${randomBytes(4).toString("hex")}@example.invalid`;
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }),
  );
  const signedIn = await cognito.send(
    new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const idToken = signedIn.AuthenticationResult?.IdToken;
  const accessToken = signedIn.AuthenticationResult?.AccessToken;
  if (!idToken || !accessToken) throw new Error(`Sign-in for user ${label} returned a challenge, not tokens.`);
  const { sub, exp } = claims(idToken);
  return { username, sub, idToken, accessToken, expiresAt: exp * 1000 };
}

// ---------------------------------------------------------------------------
// Gateway, called directly with the operator's IAM identity
// ---------------------------------------------------------------------------

interface McpReply {
  readonly status: number;
  readonly message?: {
    readonly result?: {
      readonly tools?: readonly { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }[];
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
      readonly content?: readonly { type: string; text?: string }[];
    };
    readonly error?: { readonly code?: number; readonly message?: string };
  };
  readonly raw: string;
}

async function mcp(gatewayUrl: string, method: string, params: unknown): Promise<McpReply> {
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const url = new URL(gatewayUrl);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: "bedrock-agentcore",
    sha256: Hash.bind(null, "sha256"),
  });
  const signed = await signer.sign({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      host: url.host,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body,
  });
  const response = await fetch(url, { method: "POST", headers: signed.headers, body });
  const raw = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? [...raw.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]))
    : raw
      ? [JSON.parse(raw)]
      : [];
  return { status: response.status, message: messages.find((message) => message.id === id), raw };
}

function toolText(reply: McpReply): string {
  return reply.message?.result?.content?.find((item) => item.type === "text")?.text ?? reply.message?.error?.message ?? "";
}

// ---------------------------------------------------------------------------
// Runtime, called as the browser does: the user's ID token as a bearer
// ---------------------------------------------------------------------------

interface AgentReply {
  readonly status: number;
  readonly contentType: string;
  readonly events: readonly { event: string; data: unknown }[];
  readonly raw: string;
  readonly headers: Headers;
}

function readEvents(raw: string): { event: string; data: unknown }[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = [...block.matchAll(/^data: (.*)$/gm)].map((match) => match[1]).join("\n");
      return data ? { event, data: JSON.parse(data) as unknown } : undefined;
    })
    .filter((item): item is { event: string; data: unknown } => item !== undefined);
}

async function invoke(
  url: string,
  init: { token?: string; sessionId?: string; body?: string; method?: string; cookie?: string },
): Promise<AgentReply> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.sessionId) headers[SESSION_HEADER] = init.sessionId;
  if (init.cookie) headers.cookie = init.cookie;
  const response = await fetch(url, { method: init.method ?? "POST", headers, body: init.method === "GET" ? undefined : init.body });
  const raw = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    contentType,
    events: contentType.includes("text/event-stream") ? readEvents(raw) : [],
    raw,
    headers: response.headers,
  };
}

function turn(conversationId: string, message: string): string {
  return JSON.stringify({ conversationId, input: { message } });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!app || !/smoke/.test(app)) {
    throw new Error("Pass --app <CDK_APP_NAME> of a disposable deployment; its name must contain \"smoke\".");
  }
  const startedAt = Date.now();
  const identity = aws(["sts", "get-caller-identity"]) as { Account: string };
  console.log(`Smoke-testing ${app} in ${identity.Account}/${region}.`);

  // Agents live in the orchestration stack, which keeps the deployed name WorkflowsStack.
  const agentStack = stackResources("WorkflowsStack");
  const cognitoStack = stackResources("CognitoStack");
  const runtimeId = only(agentStack, "AWS::BedrockAgentCore::Runtime");
  const gatewayId = only(agentStack, "AWS::BedrockAgentCore::Gateway");
  const userPoolId = only(cognitoStack, "AWS::Cognito::UserPool");
  const clientId = only(cognitoStack, "AWS::Cognito::UserPoolClient");
  const toolFunction = agentStack.find(
    (resource) => resource.ResourceType === "AWS::Lambda::Function" && resource.LogicalResourceId.startsWith("AgentCoreTools"),
  )?.PhysicalResourceId;

  const control = new BedrockAgentCoreControlClient({ region });
  const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
  const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
  control.destroy();
  record("Runtime is READY", runtime.status === "READY", `status ${runtime.status}${runtime.failureReason ? `: ${runtime.failureReason}` : ""}`);
  record(
    "Runtime requires MMDSv2",
    runtime.metadataConfiguration?.requireMMDSV2 === true,
    `version ${runtime.agentRuntimeVersion}`,
  );
  record("Gateway is READY, IAM inbound", gateway.status === "READY" && gateway.authorizerType === "AWS_IAM", `${gateway.status}, ${gateway.authorizerType}`);
  const runtimeUrl = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtime.agentRuntimeArn!)}/invocations?qualifier=DEFAULT`;

  const cognito = new CognitoIdentityProviderClient({ region });
  const users: SmokeUser[] = [];
  try {
    users.push(await createUser(cognito, userPoolId, clientId, "a"));
    users.push(await createUser(cognito, userPoolId, clientId, "b"));
    const [a, b] = users;
    record("Two users signed in", a.sub !== b.sub);

    // -- Gateway: discovery, the identity argument, and how errors come back --
    const listed = await mcp(gateway.gatewayUrl!, "tools/list", {});
    const tool = listed.message?.result?.tools?.find((candidate) => candidate.name === WIRE_NAME);
    const expected = gatewayInputSchema(AGENTCORE_TOOLS[TOOL]);
    record("Gateway lists the tool under its wire name", Boolean(tool), `HTTP ${listed.status}, ${listed.message?.result?.tools?.length ?? 0} tools`);
    record(
      "Gateway lists the committed description and schema",
      tool?.description === AGENTCORE_TOOLS[TOOL].description && isDeepStrictEqual(tool?.inputSchema, expected),
      tool ? "" : "tool missing",
    );

    const asA = await mcp(gateway.gatewayUrl!, "tools/call", {
      name: WIRE_NAME,
      arguments: { message: "smoke", [IDENTITY_ARGUMENT]: a.idToken },
    });
    const structured = (asA.message?.result?.structuredContent ?? JSON.parse(toolText(asA) || "null")) as { sub?: string; length?: number } | null;
    record("Tool acts as the user whose token it was given", structured?.sub === a.sub && structured?.length === 5, `HTTP ${asA.status}`);
    observe("Tool success shape", `isError=${asA.message?.result?.isError}, structuredContent=${asA.message?.result?.structuredContent !== undefined}`);

    const refusals: [string, Record<string, unknown>][] = [
      ["no identity", { message: "smoke" }],
      ["a tampered ID token", { message: "smoke", [IDENTITY_ARGUMENT]: tampered(a.idToken) }],
      ["an access token", { message: "smoke", [IDENTITY_ARGUMENT]: a.accessToken }],
      ["not a JWT", { message: "smoke", [IDENTITY_ARGUMENT]: "not-a-jwt" }],
      ["arguments its contract refuses", { message: "", [IDENTITY_ARGUMENT]: a.idToken }],
    ];
    for (const [label, args] of refusals) {
      const reply = await mcp(gateway.gatewayUrl!, "tools/call", { name: WIRE_NAME, arguments: args });
      const refused = reply.message?.result?.isError === true || reply.message?.error !== undefined || reply.status >= 400;
      const leaked = /eyJ[\w-]+\.[\w-]+\./.test(reply.raw) || reply.raw.includes(a.sub);
      record(`Tool refuses ${label}`, refused && !leaked, `HTTP ${reply.status}: ${toolText(reply)}`);
    }

    // -- Runtime: the browser's path, minus CloudFront --
    const conversation = `smoke-${randomUUID()}`;
    const streamA = await invoke(runtimeUrl, { token: a.idToken, sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "hello") });
    const kinds = streamA.events.map((item) => (item.data as { type?: string }).type ?? item.event);
    const echoA = streamA.events.find((item) => (item.data as { type?: string }).type === "echo")?.data as { sub?: string } | undefined;
    record("Runtime streams events to user A", streamA.status === 200 && streamA.contentType.includes("text/event-stream") && streamA.events.length >= 2, `HTTP ${streamA.status}, ${streamA.contentType}, events [${kinds.join(", ")}]`);
    record("The tool saw user A through Runtime and Gateway", echoA?.sub === a.sub);

    const streamB = await invoke(runtimeUrl, { token: b.idToken, sessionId: agentSessionId(b.sub, conversation), body: turn(conversation, "hello") });
    const echoB = streamB.events.find((item) => (item.data as { type?: string }).type === "echo")?.data as { sub?: string } | undefined;
    record("Same conversation id, user B gets B's own session", streamB.status === 200 && echoB?.sub === b.sub, `HTTP ${streamB.status}`);

    const intruder = await invoke(runtimeUrl, { token: b.idToken, sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "hello") });
    record("User B cannot enter user A's session", intruder.status >= 400 && !intruder.raw.includes(a.sub), `HTTP ${intruder.status}: ${intruder.raw}`);

    const noSession = await invoke(runtimeUrl, { token: a.idToken, body: turn(conversation, "hello") });
    record("A request without a session id is refused", noSession.status >= 400, `HTTP ${noSession.status}: ${noSession.raw}`);

    const credentials: [string, string | undefined][] = [
      ["no token", undefined],
      ["a tampered ID token", tampered(a.idToken)],
      ["an access token", a.accessToken],
      ["not a JWT", "not-a-jwt"],
    ];
    for (const [label, token] of credentials) {
      const reply = await invoke(runtimeUrl, { token, sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "hello") });
      record(`Runtime refuses ${label}`, reply.status === 401 || reply.status === 403, `HTTP ${reply.status}, www-authenticate ${reply.headers.has("www-authenticate")}`);
    }

    const malformed: [string, string][] = [
      ["a body that is not JSON", "{"],
      ["a missing conversation id", JSON.stringify({ input: { message: "hello" } })],
      ["input its contract refuses", turn(conversation, "")],
    ];
    for (const [label, body] of malformed) {
      const reply = await invoke(runtimeUrl, { token: a.idToken, sessionId: agentSessionId(a.sub, conversation), body });
      record(`Runtime refuses ${label}`, reply.status >= 400 && reply.status < 500, `HTTP ${reply.status}: ${reply.raw}`);
    }

    // -- CloudFront: the same call as the browser makes it --
    if (frontend) {
      const agentRoute = framework.agents?.[AGENT]?.route;
      if (!agentRoute) throw new Error(`agent:${AGENT} needs an explicit route for the frontend smoke check.`);
      const route = `${frontend}${agentRoute}`;
      const viaCdn = await invoke(route, {
        token: a.idToken,
        sessionId: agentSessionId(a.sub, conversation),
        body: turn(conversation, "through cloudfront"),
        cookie: "smoke=not-forwarded",
      });
      const echoCdn = viaCdn.events.find((item) => (item.data as { type?: string }).type === "echo")?.data as { sub?: string } | undefined;
      record("CloudFront streams the agent to user A", viaCdn.status === 200 && echoCdn?.sub === a.sub, `HTTP ${viaCdn.status}, x-cache ${viaCdn.headers.get("x-cache")}`);
      const again = await invoke(route, { token: a.idToken, sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "through cloudfront") });
      record("CloudFront does not cache agent replies", !/hit/i.test(again.headers.get("x-cache") ?? ""), `x-cache ${again.headers.get("x-cache")}`);
      const viaCdnNoToken = await invoke(route, { sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "x") });
      record("CloudFront passes the Runtime's 401 through", viaCdnNoToken.status === 401, `HTTP ${viaCdnNoToken.status}`);
      const get = await invoke(route, { token: a.idToken, method: "GET" });
      record("CloudFront answers GET with 405", get.status === 405, `HTTP ${get.status}`);
    } else {
      observe("CloudFront", "skipped: pass --frontend with the deployment's FRONTEND_URL to test the declared agent route");
    }

    if (includeExpiry) {
      const wait = Math.max(0, a.expiresAt - Date.now()) + 60_000;
      console.log(`Waiting ${Math.round(wait / 60_000)} minutes for user A's ID token to expire.`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      const expiredAtRuntime = await invoke(runtimeUrl, { token: a.idToken, sessionId: agentSessionId(a.sub, conversation), body: turn(conversation, "late") });
      record("Runtime refuses an expired ID token", expiredAtRuntime.status === 401 || expiredAtRuntime.status === 403, `HTTP ${expiredAtRuntime.status}`);
      const expiredAtTool = await mcp(gateway.gatewayUrl!, "tools/call", { name: WIRE_NAME, arguments: { message: "late", [IDENTITY_ARGUMENT]: a.idToken } });
      record("Tool refuses an expired ID token", expiredAtTool.message?.result?.isError === true || expiredAtTool.status >= 400, toolText(expiredAtTool));
    }

    // -- Logs: no token this run minted appears in any log it produced --
    const signatures = users.flatMap((user) => [user.idToken, user.accessToken].map((token) => token.split(".")[2]));
    const groups = [`/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`, ...(toolFunction ? [`/aws/lambda/${toolFunction}`] : [])];
    for (const group of groups) {
      let messages: string[] = [];
      try {
        const events = aws(["logs", "filter-log-events", "--log-group-name", group, "--start-time", String(startedAt - 60_000)]) as {
          events?: { message: string }[];
        };
        messages = (events.events ?? []).map((event) => event.message);
      } catch {
        observe(`Logs ${group}`, "not readable (absent, or not yet delivered)");
        continue;
      }
      const exposed = messages.filter((message) => signatures.some((signature) => message.includes(signature))).length;
      record(`No token in ${group}`, exposed === 0, `${messages.length} lines read, ${exposed} carry a token`);
    }
  } finally {
    for (const user of users) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: user.username })).catch(() => {
        console.error(`Could not delete smoke user ${user.username}; delete it from the pool by hand.`);
      });
    }
    cognito.destroy();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), 1000));
  process.exitCode = 1;
});
