import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AgentCoreAgents, AgentCoreTools } from "../generated/agentcore";
import {
  CALLER_HEADER,
  CONVERSATION_ID_PATTERN,
  IDENTITY_ARGUMENT,
  MCP_PROTOCOL_VERSION,
  SERVICE_SESSION_OWNER,
  SESSION_HEADER,
  type AgentInvocationBody,
} from "../protocol/agentcore";
import type { GatewaySchema } from "../protocol/tool-schema";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
  type AuthenticatedCognitoSession,
} from "./cognito";
import { readInvocationVariable } from "./context";
import { descriptorEnvironmentName, parseAgentDescriptor } from "./descriptor";
import type { ContractSchema } from "./tools";

/**
 * Writing, serving and calling an AgentCore agent.
 *
 *   export const handler = agent("support-agent", contract).stream(async function* (input, { tools, user }) {
 *     const found = await tools.call("lookup-case", { caseNumber: input.caseNumber });
 *     yield { type: "text", text: `Case ${found.title} is ${found.status}.` };
 *   });
 *
 * The framework owns the boundary and nothing inside it: bring any agent
 * library, hand it `tools.specs`, and dispatch what the model chooses through
 * `tools.call`. The same adapter serves the agent in AgentCore Runtime and in a
 * local session process, so the HTTP contract, the session rule and the tool
 * transport are one implementation in both lanes.
 */

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** An agent that answers once, with JSON. */
export interface JsonAgentContract<Request = unknown, Response = unknown> {
  readonly request: ContractSchema<Request>;
  readonly response: ContractSchema<Response>;
}

/** An agent that streams events as it works. */
export interface StreamingAgentContract<Request = unknown, Event = unknown> {
  readonly request: ContractSchema<Request>;
  readonly event: ContractSchema<Event>;
}

export type AgentContract = JsonAgentContract | StreamingAgentContract;

// ---------------------------------------------------------------------------
// Tools, as an agent sees them
// ---------------------------------------------------------------------------

/** One tool as a model SDK wants it: the spec Gateway lists, under the tool's id. */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: GatewaySchema;
}

/** One tool on this agent's Gateway, as the adapter is told about it. */
export interface AgentToolSpec {
  readonly id: string;
  readonly auth: boolean;
  readonly wireName: string;
  readonly description: string;
  readonly inputSchema: GatewaySchema;
}

/** Where this agent's Gateway answers: the local emulator, or AgentCore signed with IAM. */
export interface GatewayDescriptor {
  readonly transport: "local" | "iam";
  readonly url: string;
  readonly region?: string;
}

type DeclaredToolIds<Id> = Id extends keyof AgentCoreAgents ? AgentCoreAgents[Id]["tools"] : string;
type ToolRequest<Tool> = Tool extends keyof AgentCoreTools ? AgentCoreTools[Tool]["request"] : unknown;
type ToolResponse<Tool> = Tool extends keyof AgentCoreTools ? AgentCoreTools[Tool]["response"] : unknown;

export interface AgentTools<ToolId extends string = string> {
  /** Every tool this agent may call, in the shape model SDKs take. */
  readonly specs: readonly ModelToolSpec[];
  /** Calls a tool by id. A literal id is typed by the tool's contract. */
  call<Tool extends ToolId>(name: Tool, input: ToolRequest<Tool>): Promise<ToolResponse<Tool>>;
  /** Calls the tool a model chose. Its arguments are validated by the tool. */
  call(name: string, input: unknown): Promise<unknown>;
}

/** A tool call the model can learn from: refused arguments, a failed tool, no such tool. */
export class ToolCallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

// ---------------------------------------------------------------------------
// Defining an agent
// ---------------------------------------------------------------------------

export interface AgentContext<ToolId extends string = string> {
  /** The application's conversation id, as the caller sent it. */
  readonly conversationId: string;
  /** The Runtime session this conversation is routed to. An opaque key, never an identity. */
  readonly sessionId: string;
  /** The verified signed-in user, for an agent declared `auth: true`. */
  readonly user?: AuthenticatedCognitoSession;
  /** Aborted when the caller goes away. Cancellation does not undo a committed write. */
  readonly signal: AbortSignal;
  readonly tools: AgentTools<ToolId>;
}

export interface DefinedAgent<Contract extends AgentContract = AgentContract> {
  readonly kind: "framework-agent";
  readonly id: string;
  readonly contract: Contract;
  readonly handler: (input: unknown, context: AgentContext) => Promise<unknown> | AsyncIterable<unknown>;
}

/**
 * What `agent(id, contract)` offers: `.stream` for a contract with `event`,
 * `.respond` for one with `response`. Two steps rather than one call so the
 * contract is settled before the handler is read — which is what lets
 * TypeScript type `yield { type: "status" }` and a returned literal by the
 * contract instead of widening them.
 */
export type AgentBuilder<Id extends string, Contract> = Contract extends StreamingAgentContract<infer Request, infer Event>
  ? {
      /** The agent streams each yielded event to its caller as it works. */
      stream(
        handler: (input: Request, context: AgentContext<DeclaredToolIds<Id>>) => AsyncIterable<Event>,
      ): DefinedAgent<Contract>;
    }
  : Contract extends JsonAgentContract<infer Request, infer Response>
    ? {
        /** The agent answers once, with its response. */
        respond(
          handler: (input: Request, context: AgentContext<DeclaredToolIds<Id>>) => Promise<Response>,
        ): DefinedAgent<Contract>;
      }
    : never;

/**
 * An agent's entry point:
 * `export const handler = agent(id, contract).stream(fn)` or `.respond(fn)`.
 *
 * The id is the declaration's key, so the agent's tools are typed by what it
 * declared — calling a tool it did not list fails to compile — and the adapter
 * refuses to serve a module under another agent's name.
 */
export function agent<Id extends string, Contract extends AgentContract>(
  id: Id,
  contract: Contract,
): AgentBuilder<Id, Contract> {
  const define = (handler: unknown): DefinedAgent => ({
    kind: "framework-agent",
    id,
    contract,
    handler: handler as DefinedAgent["handler"],
  });
  return ("event" in contract ? { stream: define } : { respond: define }) as unknown as AgentBuilder<Id, Contract>;
}

/**
 * The Runtime session a conversation is routed to.
 *
 * Derived from the owner and the conversation, so a session can only ever be
 * reached by the user who owns it: the adapter recomputes it from the verified
 * token and refuses a request that names any other. 64 hex characters, inside
 * AgentCore's 33..128.
 */
export function agentSessionId(owner: string, conversationId: string): string {
  return createHash("sha256").update(JSON.stringify([owner, conversationId])).digest("hex");
}

// ---------------------------------------------------------------------------
// The Gateway transport
// ---------------------------------------------------------------------------

interface JsonRpcReply {
  readonly id?: unknown;
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
  };
  readonly error?: { readonly message?: string };
}

/** A streamed MCP reply carries JSON-RPC messages as SSE data lines; take the one answering us. */
function readStreamedReply(text: string, id: string): JsonRpcReply {
  for (const match of text.matchAll(/^data: (.*)$/gm)) {
    const message = JSON.parse(match[1]) as JsonRpcReply;
    if (message.id === id) return message;
  }
  throw new ToolCallError("The Gateway's stream ended without answering the call.");
}

async function callGateway(
  gateway: GatewayDescriptor,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const url = new URL(gateway.url);
  let headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (gateway.transport === "iam") {
    if (!gateway.region) throw new Error("An IAM Gateway descriptor needs its region.");
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: gateway.region,
      service: "bedrock-agentcore",
      sha256: Hash.bind(null, "sha256"),
    });
    const signed = await signer.sign({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: { ...headers, host: url.host },
      body,
    });
    headers = signed.headers;
  }

  const response = await fetch(url, { method: "POST", headers, body, signal });
  if (!response.ok) throw new ToolCallError(`The Gateway answered HTTP ${response.status}.`);
  const text = await response.text();
  const reply = response.headers.get("content-type")?.includes("text/event-stream")
    ? readStreamedReply(text, id)
    : (JSON.parse(text) as JsonRpcReply);
  if (reply.error) throw new ToolCallError(reply.error.message ?? "The Gateway refused the call.");
  const result = reply.result ?? {};
  const textContent = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new ToolCallError(textContent ?? "Tool execution failed.");
  return result.structuredContent ?? (textContent === undefined ? null : JSON.parse(textContent));
}

function createAgentTools(
  tools: readonly AgentToolSpec[],
  gateway: GatewayDescriptor | undefined,
  user: AuthenticatedCognitoSession | undefined,
  signal: AbortSignal,
): AgentTools {
  return {
    specs: tools.map((tool) => ({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema })),
    async call(name: string, input: unknown): Promise<unknown> {
      const tool = tools.find((candidate) => candidate.id === name);
      if (!tool) {
        throw new ToolCallError(
          `"${name}" is not one of this agent's tools: ${tools.map((candidate) => candidate.id).join(", ") || "none"}.`,
        );
      }
      if (!gateway) throw new Error("This agent has no Gateway. Declare its tools on the agent.");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new ToolCallError(`${name} takes an object of arguments.`);
      }
      // Whatever the model wrote under the reserved name is dropped, and the
      // verified token goes in its place — only for a tool that acts as the user.
      const { [IDENTITY_ARGUMENT]: _dropped, ...args } = input as Record<string, unknown>;
      if (tool.auth) {
        if (!user) throw new ToolCallError(`${name} acts as the signed-in user, and this call has none.`);
        args[IDENTITY_ARGUMENT] = user.idToken;
      }
      return callGateway(gateway, tool.wireName, args, signal);
    },
  };
}

// ---------------------------------------------------------------------------
// The Runtime adapter
// ---------------------------------------------------------------------------

export interface AgentServerOptions {
  /** Whether the agent is declared `auth: true`. */
  readonly auth: boolean;
  readonly tools: readonly AgentToolSpec[];
  readonly gateway?: GatewayDescriptor;
  /** How often a streaming reply sends a keepalive comment. CloudFront's read timeout is 30s. */
  readonly keepaliveMs?: number;
}

/** AgentCore's own limit is far larger; a conversation turn is not a file upload. */
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_KEEPALIVE_MS = 15_000;

class HttpFailure extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

async function readBody(request: IncomingMessage): Promise<AgentInvocationBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw new HttpFailure(413, { error: "AGENT_REQUEST_TOO_LARGE" });
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpFailure(400, { error: "AGENT_REQUEST_INVALID" });
  }
  const conversationId = (body as { conversationId?: unknown } | null)?.conversationId;
  if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new HttpFailure(400, { error: "AGENT_REQUEST_INVALID", message: "conversationId is required." });
  }
  return body as AgentInvocationBody;
}

async function authenticate(request: IncomingMessage): Promise<AuthenticatedCognitoSession> {
  let session: AuthenticatedCognitoSession | null;
  try {
    session = await getAuthenticatedHttpSession({ authorizationHeader: request.headers.authorization });
  } catch (error) {
    if (error instanceof AuthUnavailableError) {
      console.error(error.message, error.reason);
      throw new HttpFailure(503, { message: "Service Unavailable" });
    }
    throw error;
  }
  if (!session) throw new HttpFailure(401, { message: "Unauthorized" });
  return session;
}

function issuesOf(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function stream(
  response: ServerResponse,
  events: AsyncIterable<unknown>,
  schema: ContractSchema<unknown>,
  signal: AbortSignal,
  keepaliveMs: number,
): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const write = async (chunk: string) => {
    if (!response.write(chunk)) await once(response, "drain", { signal });
  };
  const keepalive = setInterval(() => response.write(": keepalive\n\n"), keepaliveMs);
  try {
    for await (const event of events) {
      if (signal.aborted) break;
      const checked = schema.safeParse(event);
      if (!checked.success) {
        console.error(`Agent produced an event its contract refuses: ${JSON.stringify(issuesOf(checked.error))}`);
        await write(`event: error\ndata: ${JSON.stringify({ error: "AGENT_EVENT_INVALID" })}\n\n`);
        return;
      }
      await write(`data: ${JSON.stringify(checked.data)}\n\n`);
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error("Agent failed:", error);
      response.write(`event: error\ndata: ${JSON.stringify({ error: "AGENT_EXECUTION_FAILED" })}\n\n`);
    }
  } finally {
    clearInterval(keepalive);
    response.end();
  }
}

/**
 * The AgentCore Runtime HTTP contract around one agent: `GET /ping` and
 * `POST /invocations` on whatever port it is given (8080 in AgentCore).
 *
 * Order matters and is the same in both lanes: the body, then the user (for an
 * agent with users), then the session — which must be the one derived from that
 * user and the conversation — then the contract, then the agent.
 */
export function createAgentServer(definition: DefinedAgent, options: AgentServerOptions): Server {
  let active = 0;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/ping") {
      // No time_of_last_update: stamping every ping would keep idle sessions
      // alive until their maximum lifetime.
      send(response, 200, { status: active > 0 ? "HealthyBusy" : "Healthy" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/invocations") {
      send(response, 404, { message: "Not Found" });
      return;
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    active++;
    try {
      const body = await readBody(request);
      const user = options.auth ? await authenticate(request) : undefined;
      const sessionId = agentSessionId(user?.payload.sub ?? SERVICE_SESSION_OWNER, body.conversationId);
      if (request.headers[SESSION_HEADER] !== sessionId) {
        throw new HttpFailure(403, { message: "Forbidden" });
      }
      const input = definition.contract.request.safeParse(body.input);
      if (!input.success) {
        throw new HttpFailure(400, { error: "AGENT_INPUT_INVALID", issues: issuesOf(input.error) });
      }

      const context: AgentContext = {
        conversationId: body.conversationId,
        sessionId,
        ...(user ? { user } : {}),
        signal: controller.signal,
        tools: createAgentTools(options.tools, options.gateway, user, controller.signal),
      };
      const result = definition.handler(input.data, context);

      if ("event" in definition.contract) {
        await stream(response, result as AsyncIterable<unknown>, definition.contract.event, controller.signal, keepaliveMs);
        return;
      }
      const checked = definition.contract.response.safeParse(await result);
      if (!checked.success) {
        console.error(`Agent returned a result its contract refuses: ${JSON.stringify(issuesOf(checked.error))}`);
        throw new HttpFailure(500, { error: "AGENT_EXECUTION_FAILED" });
      }
      send(response, 200, { result: checked.data });
    } catch (error) {
      if (response.headersSent) {
        response.end();
      } else if (error instanceof HttpFailure) {
        send(response, error.status, error.body);
      } else {
        console.error("Agent failed:", error);
        send(response, 500, { error: "AGENT_EXECUTION_FAILED" });
      }
    } finally {
      active--;
    }
  });
}

// ---------------------------------------------------------------------------
// Calling an agent from a backend workload
// ---------------------------------------------------------------------------

type AgentId = keyof AgentCoreAgents extends never ? string : keyof AgentCoreAgents & string;
type AgentResponse<Id> = Id extends keyof AgentCoreAgents
  ? AgentCoreAgents[Id] extends { readonly response: infer Response }
    ? Response
    : never
  : unknown;
type AgentRequest<Id> = Id extends keyof AgentCoreAgents ? AgentCoreAgents[Id]["request"] : unknown;

export interface InvokeAgentOptions {
  readonly conversationId: string;
  /**
   * The caller's verified session — required for an agent declared
   * `auth: true`, which accepts only a user's token. Pass the session your
   * `authenticated` handler was given.
   */
  readonly session?: AuthenticatedCognitoSession;
  readonly signal?: AbortSignal;
  /** Defaults to 25 seconds, under the HTTP API's 30-second integration limit. */
  readonly timeoutMs?: number;
}

export class AgentInvocationError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AgentInvocationError";
  }
}

async function readAgentReply(id: string, response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new AgentInvocationError(
      `${id} streams events. Call it from the browser with streamAgent, or give it a response contract.`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string; message?: string };
  if (!response.ok) {
    throw new AgentInvocationError(
      `${id} answered HTTP ${response.status}${body.error ?? body.message ? ` (${body.error ?? body.message})` : ""}.`,
      response.status,
    );
  }
  return body.result;
}

/**
 * Invokes a declared agent and returns its JSON result.
 *
 * The transport comes from the `invokesAgent` descriptor this caller was given:
 * the local runner during development, AgentCore Runtime in AWS. An agent with
 * users is called with the caller's session, never with IAM, because its
 * Runtime accepts only the user's token.
 */
export async function invokeAgent<Id extends AgentId>(
  id: Id,
  input: AgentRequest<Id>,
  options: InvokeAgentOptions,
): Promise<AgentResponse<Id>> {
  const descriptor = parseAgentDescriptor(
    readInvocationVariable(descriptorEnvironmentName("agent", id)),
    id,
  );
  if (!CONVERSATION_ID_PATTERN.test(options.conversationId)) {
    throw new AgentInvocationError("conversationId must be 1 to 128 letters, digits, or . _ : -.");
  }
  if (descriptor.auth && !options.session) {
    throw new AgentInvocationError(
      `${id} has auth: true, so invokeAgent needs the caller's session. Pass the session your authenticated handler received.`,
    );
  }
  const owner = descriptor.auth ? options.session!.payload.sub : SERVICE_SESSION_OWNER;
  const sessionId = agentSessionId(owner, options.conversationId);
  const body = JSON.stringify({ conversationId: options.conversationId, input });
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 25_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    [SESSION_HEADER]: sessionId,
    ...(descriptor.auth ? { authorization: `Bearer ${options.session!.idToken}` } : {}),
  };

  if (descriptor.transport === "local") {
    const response = await fetch(`${descriptor.runnerUrl}/agents/${id}/invocations`, {
      method: "POST",
      headers: { ...headers, ...(descriptor.caller ? { [CALLER_HEADER]: descriptor.caller } : {}) },
      body,
      signal,
    });
    return (await readAgentReply(id, response)) as AgentResponse<Id>;
  }

  if (descriptor.auth) {
    const url = `https://bedrock-agentcore.${descriptor.region}.amazonaws.com/runtimes/${encodeURIComponent(descriptor.arn)}/invocations?qualifier=DEFAULT`;
    const response = await fetch(url, { method: "POST", headers, body, signal });
    return (await readAgentReply(id, response)) as AgentResponse<Id>;
  }

  const client = new BedrockAgentCoreClient({ region: descriptor.region, maxAttempts: 1 });
  try {
    const result = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: descriptor.arn,
        qualifier: "DEFAULT",
        runtimeSessionId: sessionId,
        payload: Buffer.from(body),
        contentType: "application/json",
        accept: "application/json",
      }),
      { abortSignal: signal },
    );
    const text = Buffer.from(await result.response!.transformToByteArray()).toString("utf8");
    return (await readAgentReply(
      id,
      new Response(text, { status: result.statusCode ?? 200, headers: { "content-type": result.contentType ?? "application/json" } }),
    )) as AgentResponse<Id>;
  } finally {
    client.destroy();
  }
}
