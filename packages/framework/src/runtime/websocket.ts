import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

/**
 * The connection is closed: the browser went away, or the id is stale. The
 * same error in both lanes, so a handler cleans up after one the same way.
 */
export class ConnectionGoneError extends Error {
  constructor(readonly connectionId: string) {
    super(`WebSocket connection ${connectionId} is gone.`);
    this.name = "ConnectionGoneError";
  }
}

/** Pushing to, and closing, the WebSocket connections of this API. */
export interface WebSocketConnections {
  /** Delivers `data` to the browser: a string as written, anything else as JSON. */
  send(connectionId: string, data: unknown): Promise<void>;
  /** Closes the connection from the server side. */
  disconnect(connectionId: string): Promise<void>;
}

/** The part of a WebSocket route event that says which API sent it. */
export interface WebSocketEventSource {
  readonly requestContext: {
    readonly domainName: string;
    readonly stage: string;
  };
}

function encode(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

const awsClients = new Map<string, ApiGatewayManagementApiClient>();

function awsConnections(endpoint: string): WebSocketConnections {
  let client = awsClients.get(endpoint);
  if (!client) {
    // The endpoint is the API's own, so the SDK must not swap in a dual-stack
    // one: a Lambda inside the VPC runs with AWS_USE_DUALSTACK_ENDPOINT=true,
    // and the SDK refuses that setting together with a custom endpoint. The
    // WebSocket API is created dualstack, so this endpoint answers over IPv6.
    client = new ApiGatewayManagementApiClient({ endpoint, useDualstackEndpoint: false });
    awsClients.set(endpoint, client);
  }
  const gone = (connectionId: string) => (error: unknown) => {
    if ((error as { name?: string }).name === "GoneException") {
      throw new ConnectionGoneError(connectionId);
    }
    throw error;
  };
  return {
    send: (connectionId, data) =>
      client
        .send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: encode(data) }))
        .then(() => undefined, gone(connectionId)),
    disconnect: (connectionId) =>
      client
        .send(new DeleteConnectionCommand({ ConnectionId: connectionId }))
        .then(() => undefined, gone(connectionId)),
  };
}

function localConnections(baseUrl: string): WebSocketConnections {
  const request = async (connectionId: string, init: RequestInit): Promise<void> => {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/@connections/${encodeURIComponent(connectionId)}`,
      init,
    );
    if (response.status === 410) throw new ConnectionGoneError(connectionId);
    if (!response.ok) {
      throw new Error(`The local WebSocket server refused the request (HTTP ${response.status}).`);
    }
  };
  return {
    send: (connectionId, data) => request(connectionId, { method: "POST", body: encode(data) }),
    disconnect: (connectionId) => request(connectionId, { method: "DELETE" }),
  };
}

/**
 * The connections of the WebSocket API that delivered `event`.
 *
 *   export const lambdaHandler = async (event: APIGatewayProxyWebsocketEventV2) => {
 *     await webSocketConnections(event).send(event.requestContext.connectionId, { ok: true });
 *     return { statusCode: 200 };
 *   };
 *
 * The route must declare `cloud: { manageConnections: true }`, which is what
 * grants the push in AWS. Locally the framework points this at the local
 * WebSocket dev server instead (LOCAL_WEBSOCKET_CONNECTIONS_URL, set by
 * Compose), so the same handler pushes to the same browser in both lanes and
 * never branches on where it runs.
 */
export function webSocketConnections(event: WebSocketEventSource): WebSocketConnections {
  const local = process.env.LOCAL_WEBSOCKET_CONNECTIONS_URL;
  if (local) return localConnections(local);
  const { domainName, stage } = event.requestContext;
  return awsConnections(`https://${domainName}/${stage}`);
}
