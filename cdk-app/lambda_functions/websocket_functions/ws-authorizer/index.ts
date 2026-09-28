import { APIGatewayAuthorizerResult } from "aws-lambda";
import { verifyCognitoIdToken } from "@repo/framework/runtime/auth";

interface WebSocketAuthorizerEvent {
  type: string;
  methodArn: string;
  requestContext: {
    connectionId: string;
    apiId: string;
    stage: string;
  };
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string> | null;
}

export const lambdaHandler = async (
  event: WebSocketAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  // Extract the token from query parameters
  const token = event.queryStringParameters?.token ?? null;

  // If no token is provided, deny access
  if (!token) {
    console.log("No token found in query parameters - denying connection");
    return {
      principalId: "anonymous",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
            Resource: event.methodArn,
          },
        ],
      },
    };
  }

  try {
    const payload = await verifyCognitoIdToken(token);

    if (!payload) {
      return {
        principalId: "anonymous",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Resource: event.methodArn,
            },
          ],
        },
      };
    }

    // If the token is valid and contains the expected claims, allow access
    return {
      principalId: payload.sub,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: event.methodArn,
          },
        ],
      },
    };

    // If any errors occur during token verification, deny access
  } catch (error) {
    console.error("Error verifying WebSocket authorizer token:", error);
    return {
      principalId: "anonymous",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
            Resource: event.methodArn,
          },
        ],
      },
    };
  }
};
