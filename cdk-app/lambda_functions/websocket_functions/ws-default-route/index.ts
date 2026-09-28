import {
  APIGatewayProxyResultV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";

export const lambdaHandler = async (
  event: APIGatewayProxyEventV2WithRequestContext<any>,
): Promise<APIGatewayProxyResultV2> => {
  const parsedEvent = {
    routeKey: event.requestContext.routeKey,
    ...(event.body && {
      body: JSON.parse(event.body) as { message: string },
    }),
    connectionId: event.requestContext.connectionId,
  };

  const Data = JSON.stringify({
    route: "$default",
    recievedMessage: parsedEvent.body?.message || "No message received",
    connectionId: parsedEvent.connectionId,
  });

  return {
    statusCode: 200,
    body: Data,
  };
};
