import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
} from "aws-lambda";
import type { HttpResult } from "@repo/framework/runtime/http";

export function getRequestUrl(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): string {
  if ("rawPath" in event) {
    const protocol = event.headers["x-forwarded-proto"] ?? "https";
    const host =
      event.headers.host ??
      event.headers.Host ??
      event.requestContext.domainName ??
      "localhost";
    const queryString = event.rawQueryString ? `?${event.rawQueryString}` : "";

    return `${protocol}://${host}${event.rawPath}${queryString}`;
  }

  const protocol = event.headers["x-forwarded-proto"] ?? "https";
  const host =
    event.headers.host ?? event.headers.Host ?? event.requestContext.domainName;
  const path = event.path || "/graphql";
  const queryString = event.queryStringParameters
    ? `?${new URLSearchParams(
        Object.entries(event.queryStringParameters).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ).toString()}`
    : "";

  return `${protocol}://${host ?? "localhost"}${path}${queryString}`;
}

export function getRequestHeaders(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(event.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

export function getRequestBody(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): BodyInit | undefined {
  if (!event.body) {
    return undefined;
  }

  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
}

export async function toApiGatewayResult(
  response: Response,
): Promise<HttpResult> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}
