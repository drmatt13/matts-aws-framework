import { randomUUID } from "node:crypto";
import {
  APIGatewayProxyEventV2,
} from "aws-lambda";
import { Request, Response } from "express";

/**
 * Lambda's limit on a synchronous invocation's payload: the whole event, not
 * just the body. A request that would exceed it is refused here as it would be
 * in AWS, instead of working locally and failing once deployed.
 */
export const LAMBDA_PAYLOAD_LIMIT_BYTES = 6 * 1024 * 1024;

type LambdaResult = {
  statusCode: number;
  body?: string;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  cookies?: string[];
  isBase64Encoded?: boolean;
};

type LambdaHandler = (event: APIGatewayProxyEventV2) => Promise<LambdaResult>;

type InvokeLambdaOptions = {
  authorizerJwtClaims?: Record<string, unknown>;
  routeKey?: string;
};

/**
 * Claims as API Gateway's JWT authorizer delivers them: every value a string.
 * A number arrives as its digits and an array as "[a b]", so a handler that
 * reads `cognito:groups` from the event sees here what it will see in AWS.
 */
export function toApiGatewayJwtClaims(
  claims: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(claims).map(([name, value]) => [
      name,
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? `[${value.map(String).join(" ")}]`
          : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value),
    ]),
  );
}

function getSingleHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(",");
  }

  return value ?? "";
}

function getRequestBody(req: Request): {
  body: string | undefined;
  isBase64Encoded: boolean;
} {
  const buffer = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (buffer && buffer.length > 0) {
    const contentType = req.header("content-type")?.toLowerCase() ?? "";
    const isText =
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("x-www-form-urlencoded");
    return {
      body: buffer.toString(isText ? "utf8" : "base64"),
      isBase64Encoded: !isText,
    };
  }

  if (typeof req.body === "string") {
    return { body: req.body, isBase64Encoded: false };
  }

  if (req.body && Object.keys(req.body).length) {
    return { body: JSON.stringify(req.body), isBase64Encoded: false };
  }

  return { body: undefined, isBase64Encoded: false };
}

function toQueryStringParameters(
  query: Request["query"],
): Record<string, string> | undefined {
  if (Object.keys(query).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String).join(",") : String(value),
    ]),
  );
}

function toDevCookie(cookieValue: string): string {
  // Lambdas set Secure;SameSite=None for production HTTPS. On the local HTTP
  // dev server those attributes prevent browsers from storing cookies across
  // ports, so downgrade them for localhost development.
  return cookieValue
    .replace(/;\s*Secure/gi, "")
    .replace(/SameSite=None/gi, "SameSite=Lax");
}

export default async function invokeLambdaFunction(
  req: Request,
  res: Response,
  handler: LambdaHandler,
  options: InvokeLambdaOptions = {},
): Promise<void> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const headerValue = getSingleHeaderValue(value);
    if (headerValue) {
      headers[key.toLowerCase()] = headerValue;
    }
  }

  const routeKey = options.routeKey ?? `${req.method} ${req.path}`;
  const requestId = randomUUID();
  const rawQueryString = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1)
    : "";
  const cookieHeader = headers.cookie;
  const requestBody = getRequestBody(req);

  const event: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey,
    rawPath: req.path,
    rawQueryString,
    // One entry per cookie, as API Gateway splits them.
    cookies: cookieHeader
      ? cookieHeader.split(";").map((cookie) => cookie.trim()).filter(Boolean)
      : undefined,
    headers,
    queryStringParameters: toQueryStringParameters(req.query),
    pathParameters: Object.keys(req.params).length
      ? Object.fromEntries(
          Object.entries(req.params).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : undefined,
    body: requestBody.body,
    isBase64Encoded: requestBody.isBase64Encoded,
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: headers.host ?? "localhost",
      domainPrefix: "local",
      http: {
        method: req.method,
        path: req.path,
        protocol: "HTTP/1.1",
        sourceIp: req.ip ?? "127.0.0.1",
        userAgent: headers["user-agent"] ?? "",
      },
      requestId,
      routeKey,
      stage: "local",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      ...(options.authorizerJwtClaims
        ? {
            authorizer: {
              jwt: {
                claims: toApiGatewayJwtClaims(options.authorizerJwtClaims),
                scopes: [],
              },
            },
          }
        : {}),
    },
  };

  if (Buffer.byteLength(JSON.stringify(event)) > LAMBDA_PAYLOAD_LIMIT_BYTES) {
    res.status(413).json({ message: "Request Entity Too Large" });
    return;
  }

  const result = await handler(event);
  const setCookieValues = new Set<string>();

  if (result.cookies) {
    result.cookies.forEach((cookie) => setCookieValues.add(cookie));
  }

  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      if (key.toLowerCase() === "set-cookie") {
        setCookieValues.add(String(value));
      } else {
        res.setHeader(key, String(value));
      }
    }
  }

  if (result.multiValueHeaders) {
    for (const [key, values] of Object.entries(result.multiValueHeaders)) {
      if (key.toLowerCase() === "set-cookie") {
        values.forEach((value) => setCookieValues.add(String(value)));
      } else {
        res.setHeader(key, values.map(String));
      }
    }
  }

  if (setCookieValues.size > 0) {
    res.setHeader(
      "Set-Cookie",
      [...setCookieValues].map((value) => toDevCookie(value)),
    );
  }

  const responseBody =
    result.isBase64Encoded && result.body
      ? Buffer.from(result.body, "base64")
      : result.body;
  res.status(result.statusCode).send(responseBody);
}
