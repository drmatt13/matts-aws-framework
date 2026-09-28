import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import env from "dotenv";

import { getLocalBrowserOrigins } from "@repo/framework/local/origins";
import { LocalLambdaExecutor } from "@repo/framework/local";
import {
  getWebSocketAuthorizer,
  getWebSocketRoutes,
  validateFrameworkConfig,
} from "@repo/framework/config";
import framework from "../../framework.config";

import {
  createConnectEvent,
  createDisconnectEvent,
  createMessageEvent,
} from "../events/websocketEvents";

// The same file the local API server reads. Under Compose these values arrive
// as container environment instead, and dotenv never overwrites those.
env.config({
  path: "./.env",
});
validateFrameworkConfig(framework);

const PORT = Number(process.env.PORT) || 8081;
// The API Gateway Management API's local stand-in. Its own port, which Compose
// does not publish: only workloads on the Compose network can push to a
// browser, never another machine on the developer's network.
const CONNECTIONS_PORT = Number(process.env.CONNECTIONS_PORT) || 8082;
const executor = new LocalLambdaExecutor({ config: framework });
const webSocketRoutes = getWebSocketRoutes(framework);
// Declared on $connect in framework-config, so it guards the handshake here
// exactly as it does in AWS. There is no switch: the declaration is the switch.
const authorizerTarget = getWebSocketAuthorizer(framework);

interface Connection {
  readonly socket: WebSocket;
  readonly connectedAt: number;
  readonly domainName: string;
  readonly headers: IncomingMessage["headers"];
  readonly authorizer?: Record<string, unknown>;
}
const connections = new Map<string, Connection>();
const socketIds = new WeakMap<WebSocket, string>();

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rejectHandshake(socket: Duplex, status: 401 | 403 | 500, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
}

// =======================================
//  📥 Connection management — POST/GET/DELETE /@connections/{id}
//  The same paths API Gateway's Management API serves, optionally under a
//  stage prefix, so @repo/framework/runtime/websocket pushes here locally.
// =======================================
const CONNECTION_PATH = /^(?:\/[^/@]+)?\/@connections\/([^/?]+)$/;

const managementServer = createServer((req, res) => {
  const match = CONNECTION_PATH.exec((req.url ?? "").split("?")[0] ?? "");
  if (!match) {
    json(res, 404, { message: "Not Found" });
    return;
  }
  const connectionId = decodeURIComponent(match[1]!);
  const connection = connections.get(connectionId);
  if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
    json(res, 410, { message: "Gone" }, { "x-amzn-errortype": "GoneException" });
    return;
  }

  if (req.method === "GET") {
    json(res, 200, {
      ConnectedAt: new Date(connection.connectedAt).toISOString(),
      Identity: { SourceIp: "127.0.0.1", UserAgent: connection.headers["user-agent"] ?? "" },
      LastActiveAt: new Date().toISOString(),
    });
    return;
  }
  if (req.method === "DELETE") {
    connection.socket.close(1000, "Closed by the application");
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { message: "Method Not Allowed" });
    return;
  }

  // The body is delivered to the browser exactly as posted, as API Gateway
  // delivers PostToConnection's Data.
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    connection.socket.send(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200).end();
  });
});

// =======================================
//  🔄 WebSocket Server in "noServer" Mode
//  Connections are accepted only after $connect (and its authorizer) allow it
// =======================================
const server = createServer((_req, res) => json(res, 404, { message: "Not Found" }));
const wss = new WebSocketServer({ noServer: true });
const localBrowserOrigins = new Set(getLocalBrowserOrigins());

/**
 * Whether an authorizer result allows the handshake, the way API Gateway
 * decides: an explicit Allow and no Deny. An empty or missing policy is a
 * refusal, not a pass.
 */
function allowedBy(result: {
  policyDocument?: { Statement?: Array<{ Effect?: string }> };
}): boolean {
  const statements = result.policyDocument?.Statement ?? [];
  return (
    statements.some((statement) => statement.Effect === "Allow") &&
    !statements.some((statement) => statement.Effect === "Deny")
  );
}

server.on("upgrade", async (request, socket, head) => {
  try {
    // `ws` performs no same-origin check of its own, so without this any page
    // in the browser could open a credentialed socket against this server.
    const requestOrigin = request.headers.origin;
    if (requestOrigin && !localBrowserOrigins.has(requestOrigin)) {
      console.warn(`Rejected WebSocket connection from origin: ${requestOrigin}`);
      rejectHandshake(socket, 403, "Forbidden");
      return;
    }

    const connectionId = randomUUID();
    const domainName = request.headers.host ?? "localhost";
    const requestUrl = new URL(request.url || "/", `http://${domainName}`);
    const singleValueQueryParams: Record<string, string> = {};
    const multiValueQueryParams: Record<string, string[]> = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      singleValueQueryParams[key] ??= value;
      (multiValueQueryParams[key] ??= []).push(value);
    }
    const connectedAt = Date.now();

    let authorizer: Record<string, unknown> | undefined;
    if (authorizerTarget) {
      const authorizerEvent = {
        type: "REQUEST",
        methodArn: "arn:aws:execute-api:local:local:local/prod/$connect",
        requestContext: { connectionId, apiId: "local", stage: "prod", routeKey: "$connect", eventType: "CONNECT" },
        queryStringParameters: singleValueQueryParams,
        headers: request.headers as Record<string, string>,
      };
      let result: {
        principalId?: string;
        context?: Record<string, unknown>;
        policyDocument?: { Statement?: Array<{ Effect?: string }> };
      };
      try {
        result = await executor.invoke(authorizerTarget, authorizerEvent);
      } catch (error) {
        // `throw new Error("Unauthorized")` is how an authorizer says 401.
        if (error instanceof Error && error.message === "Unauthorized") {
          rejectHandshake(socket, 401, "Unauthorized");
          return;
        }
        throw error;
      }
      if (!allowedBy(result)) {
        console.log("❌ Connection rejected by the $connect authorizer.");
        rejectHandshake(socket, 403, "Forbidden");
        return;
      }
      // What AWS attaches to $connect and every later event on the connection.
      authorizer = { principalId: result.principalId, ...result.context };
    }

    const connectResponse = await executor.invoke<{ statusCode?: number } | null>(
      webSocketRoutes.$connect,
      createConnectEvent({
        connectionId,
        connectedAt,
        domainName,
        headers: request.headers,
        queryStringParameters: singleValueQueryParams,
        multiValueQueryStringParameters: multiValueQueryParams,
        ...(authorizer ? { authorizer } : {}),
      }),
    );

    // API Gateway refuses the handshake for any status outside 2xx.
    const status = connectResponse?.statusCode;
    if (status !== undefined && (status < 200 || status > 299)) {
      console.log(`❌ Connection rejected by $connect (status ${status}).`);
      rejectHandshake(socket, 403, "Forbidden");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      connections.set(connectionId, {
        socket: ws,
        connectedAt,
        domainName,
        headers: request.headers,
        ...(authorizer ? { authorizer } : {}),
      });
      socketIds.set(ws, connectionId);
      wss.emit("connection", ws, request);
    });
  } catch (error) {
    console.error("🚨 Error during $connect:", error);
    rejectHandshake(socket, 500, "Internal Server Error");
  }
});

wss.on("connection", (ws: WebSocket) => {
  const connectionId = socketIds.get(ws);
  const connection = connectionId ? connections.get(connectionId) : undefined;
  if (!connectionId || !connection) {
    ws.close(1011, "Missing connection id");
    return;
  }
  const eventOptions = {
    connectionId,
    connectedAt: connection.connectedAt,
    domainName: connection.domainName,
    headers: connection.headers,
    ...(connection.authorizer ? { authorizer: connection.authorizer } : {}),
  };

  ws.on("message", async (message) => {
    // Routed as API Gateway routes it: $request.body.action when the message
    // is JSON naming a declared route, $default otherwise — including when it
    // is not JSON at all. The body the handler receives is the message itself.
    const body = message.toString();
    let action: unknown;
    try {
      action = (JSON.parse(body) as { action?: unknown } | null)?.action;
    } catch {
      action = undefined;
    }
    const routeKey =
      typeof action === "string" && Object.prototype.hasOwnProperty.call(webSocketRoutes, action)
        ? (action as keyof typeof webSocketRoutes)
        : "$default";
    const target = webSocketRoutes[routeKey as keyof typeof webSocketRoutes];
    if (!target) {
      ws.send(JSON.stringify({ message: "Forbidden", connectionId, requestId: randomUUID() }));
      return;
    }

    try {
      const response = await executor.invoke<{ body?: string } | null>(
        target,
        createMessageEvent(routeKey, body, eventOptions),
      );
      if (response?.body) ws.send(response.body);
    } catch (error) {
      console.error(`[${target}] WebSocket route invocation failed:`, error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message: "Internal server error", connectionId, requestId: randomUUID() }));
      }
    }
  });

  ws.on("close", async (statusCode, reason) => {
    connections.delete(connectionId);
    try {
      await executor.invoke(
        webSocketRoutes.$disconnect,
        createDisconnectEvent({ ...eventOptions, statusCode, reason: reason.toString() }),
      );
    } catch (error) {
      // A failing $disconnect is the handler's bug to see, not a reason for the
      // dev server to exit.
      console.error(`[${webSocketRoutes.$disconnect}] $disconnect failed:`, error);
    }
  });

  ws.on("error", () => {
    connections.delete(connectionId);
  });
});

// =======================================
//  🚀 Start
// =======================================
server.listen(PORT, () => {
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);
  console.log(`Trusted browser origins: ${[...localBrowserOrigins].join(", ")}`);
  console.log(
    authorizerTarget
      ? `✅ $connect is guarded by ${authorizerTarget}, as declared in framework-config.`
      : "⚠️ $connect declares no authorizer: any client can connect, locally and in AWS.",
  );
});
managementServer.listen(CONNECTIONS_PORT, () => {
  console.log(`Connection management (POST /@connections/{id}) on port ${CONNECTIONS_PORT}, Compose network only.`);
});
