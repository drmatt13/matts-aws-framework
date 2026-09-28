import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

export type LocalWebSocketEvent = Omit<
  APIGatewayProxyWebsocketEventV2,
  "requestContext"
> & {
  headers?: Record<string, string | undefined>;
  multiValueHeaders?: Record<string, string[]>;
  multiValueQueryStringParameters?: Record<string, string[]>;
  queryStringParameters?: Record<string, string>;
  requestContext: APIGatewayProxyWebsocketEventV2["requestContext"] & {
    connectionId: string;
    disconnectReason?: string;
    disconnectStatusCode?: number;
  };
};

type EventOptions = {
  connectionId: string;
  domainName: string;
  connectedAt: number;
  headers?: IncomingHttpHeaders;
  /**
   * The authorizer's principalId and context, which API Gateway attaches to
   * $connect and to every later event on the same connection.
   */
  authorizer?: Record<string, unknown>;
};

function normalizeHeaders(
  headers: IncomingHttpHeaders = {},
): {
  headers: Record<string, string | undefined>;
  multiValueHeaders: Record<string, string[]>;
} {
  const single: Record<string, string | undefined> = {};
  const multiple: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [String(value)];
    single[name] = values.join(",");
    multiple[name] = values;
  }
  return { headers: single, multiValueHeaders: multiple };
}

function requestContext(
  routeKey: string,
  eventType: "CONNECT" | "MESSAGE" | "DISCONNECT",
  options: EventOptions,
) {
  const now = Date.now();
  const requestId = randomUUID();
  return {
    routeKey,
    eventType,
    extendedRequestId: requestId,
    requestTime: new Date(now).toISOString(),
    messageId: eventType === "MESSAGE" ? requestId : routeKey,
    messageDirection: "IN" as const,
    stage: "prod",
    connectedAt: options.connectedAt,
    requestTimeEpoch: now,
    identity: {
      userAgent: options.headers?.["user-agent"] ?? "local-websocket-client",
      sourceIp: "127.0.0.1",
    },
    requestId,
    domainName: options.domainName,
    connectionId: options.connectionId,
    apiId: "local",
    ...(options.authorizer ? { authorizer: options.authorizer } : {}),
  };
}

export function createConnectEvent(
  options: EventOptions & {
    queryStringParameters?: Record<string, string>;
    multiValueQueryStringParameters?: Record<string, string[]>;
  },
): LocalWebSocketEvent {
  return {
    ...normalizeHeaders(options.headers),
    queryStringParameters: options.queryStringParameters,
    multiValueQueryStringParameters: options.multiValueQueryStringParameters,
    requestContext: requestContext("$connect", "CONNECT", options),
    isBase64Encoded: false,
  } as LocalWebSocketEvent;
}

export function createMessageEvent(
  routeKey: string,
  body: string,
  options: EventOptions,
): LocalWebSocketEvent {
  return {
    ...normalizeHeaders(options.headers),
    requestContext: requestContext(routeKey, "MESSAGE", options),
    body,
    isBase64Encoded: false,
  } as LocalWebSocketEvent;
}

export function createDisconnectEvent(
  options: EventOptions & { statusCode?: number; reason?: string },
): LocalWebSocketEvent {
  return {
    ...normalizeHeaders(options.headers),
    requestContext: {
      ...requestContext("$disconnect", "DISCONNECT", options),
      disconnectStatusCode: options.statusCode ?? 1000,
      disconnectReason: options.reason ?? "",
    },
    isBase64Encoded: false,
  } as LocalWebSocketEvent;
}
