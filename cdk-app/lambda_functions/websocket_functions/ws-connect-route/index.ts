import {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from "aws-lambda";

type ConnectRouteEvent = APIGatewayProxyWebsocketEventV2 & {
  requestContext: APIGatewayProxyWebsocketEventV2["requestContext"] & {
    /** What the $connect authorizer returned: principalId plus its context. */
    authorizer?: { principalId?: string };
  };
};

export const lambdaHandler = async (
  event: ConnectRouteEvent,
): Promise<APIGatewayProxyResultV2> => {
  // Who connected, as the authorizer established it — the same field in AWS and
  // under the local WebSocket dev server. Log the subject, never the token.
  console.log("Connected", {
    connectionId: event.requestContext.connectionId,
    principalId: event.requestContext.authorizer?.principalId,
  });

  // Return a response to indicate that the connection was accepted
  // You cannot send a message back to the client from the connect route
  return {
    statusCode: 200,
  };
};
