import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
} from "aws-lambda";
import cookie from "cookie";
import type { HttpResult } from "./response";

export { jsonResponse, type HttpEvent, type HttpResult, type JsonResponseOptions } from "./response";

export const AUTH_COOKIE_NAMES = [
  "idToken",
  "accessToken",
  "refreshToken",
  "sessionMode",
  "hasSession",
] as const;

const PERSISTENT_SESSION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Where the browser sends the credential-bearing cookies. Every auth call goes
 * through the same-origin /api prefix — the Vite proxy locally, CloudFront's
 * /api/* behavior deployed — so the refresh token never rides along with a
 * page, asset or anything else the site serves.
 */
const AUTH_COOKIE_PATH = "/api";

export function parseJsonBody<T = unknown>(
  body: string | null | undefined,
): T {
  return JSON.parse(body ?? "{}") as T;
}

export function getHttpMethod(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): string | undefined {
  return "httpMethod" in event
    ? event.httpMethod
    : event.requestContext?.http?.method;
}

export function optionsResponse(): HttpResult {
  return { statusCode: 204, body: "" };
}

export function getUserPoolClientId(): string | null {
  const value = process.env.USER_POOL_CLIENT_ID;
  return value && value.trim().length > 0 ? value : null;
}

export function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  return cookieHeader ? cookie.parse(cookieHeader) : {};
}

export function getCookieHeader(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): string {
  if ("cookies" in event && Array.isArray(event.cookies)) {
    return event.cookies.join("; ");
  }

  return event.headers?.cookie ?? event.headers?.Cookie ?? "";
}

export function makeAuthCookie(
  name: string,
  value: string,
  maxAge?: number,
): string {
  const maxAgeAttribute =
    typeof maxAge === "number" ? `; Max-Age=${maxAge}` : "";

  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${AUTH_COOKIE_PATH}${maxAgeAttribute}`;
}

/**
 * Readable companion to the HttpOnly session cookies. Carries no credential --
 * it only lets the browser see that a refresh cookie should exist, so the
 * client can skip a guaranteed-401 refresh request on unauthenticated pages.
 */
export function makeSessionHintCookie(
  rememberMe: boolean,
  maxAge?: number,
): string {
  const maxAgeAttribute =
    typeof maxAge === "number" ? `; Max-Age=${maxAge}` : "";

  return `hasSession=${rememberMe ? "persistent" : "session"}; Secure; SameSite=Lax; Path=/${maxAgeAttribute}`;
}

export function clearAuthCookie(name: string, path = AUTH_COOKIE_PATH): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function makeRefreshSessionCookies(
  refreshToken: string,
  rememberMe: boolean,
): string[] {
  const maxAge = rememberMe ? PERSISTENT_SESSION_SECONDS : undefined;

  return [
    makeAuthCookie("refreshToken", refreshToken, maxAge),
    makeAuthCookie("sessionMode", rememberMe ? "persistent" : "session", maxAge),
    makeSessionHintCookie(rememberMe, maxAge),
  ];
}

/**
 * Every auth cookie, cleared at both paths it can live at: /api for the
 * credentials, and / for the session hint and for anything a build from
 * before the path moved left behind.
 */
export function clearAuthCookies(): string[] {
  return AUTH_COOKIE_NAMES.flatMap((name) => [
    clearAuthCookie(name, AUTH_COOKIE_PATH),
    clearAuthCookie(name, "/"),
  ]);
}

export function hasPersistentSessionCookie(
  cookies: Record<string, string>,
): boolean {
  return cookies.sessionMode === "persistent";
}

function getHeader(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();

  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === lowerName && typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

export function isTrustedBrowserRequest(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): boolean {
  const origin = getHeader(event, "origin")?.replace(/\/+$/, "");
  const fetchSite = getHeader(event, "sec-fetch-site")?.toLowerCase();
  const trustedOrigins = new Set(
    (process.env.TRUSTED_FRONTEND_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );

  if (origin) {
    return trustedOrigins.has(origin);
  }

  // Non-browser callers don't send Fetch Metadata. A browser-declared
  // cross-site request without an Origin is never a valid credentialed flow.
  return fetchSite !== "cross-site";
}
