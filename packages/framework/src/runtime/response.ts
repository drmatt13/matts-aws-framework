import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

// Shared by the http and auth entry points, and an entry point of neither: a
// handler importing one of them must not load the other.

/**
 * What an HTTP route handler receives: every framework route is integrated
 * with API Gateway's payload format 2.0, locally and in AWS.
 */
export type HttpEvent = APIGatewayProxyEventV2;

/** What an HTTP route handler returns, in payload format 2.0. */
export type HttpResult = APIGatewayProxyStructuredResultV2;

export type JsonResponseOptions = {
  cookies?: string[];
  headers?: Record<string, string>;
};

/**
 * A JSON response. Cookies travel in payload 2.0's `cookies` field, which API
 * Gateway turns into one Set-Cookie header each.
 */
export function jsonResponse(
  statusCode: number,
  body: unknown,
  options: JsonResponseOptions = {},
): HttpResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    ...(options.cookies?.length ? { cookies: options.cookies } : {}),
    body: JSON.stringify(body),
  };
}
