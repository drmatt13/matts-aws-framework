import { redirect } from "@tanstack/react-router";

import { API_ROUTE, API_ROUTES, type ApiRoute } from "@repo/api-contract";
import {
  SignInResponseSchema,
  type SignInChallenge,
  type SignInResponse,
} from "@repo/api-contract";

export { API_ROUTE, API_ROUTES };
export type { ApiRoute };
export type { SignInChallenge } from "@repo/api-contract";

const API_URL = "/api";
const AWS_REGION = import.meta.env.VITE_AWS_REGION;
const USER_POOL_ID = import.meta.env.VITE_USER_POOL_ID;
const USER_POOL_CLIENT_ID = import.meta.env.VITE_USER_POOL_CLIENT_ID;
const ID_TOKEN_EXPIRY_SKEW_SECONDS = 30;
const REFRESH_TIMEOUT_MS = 10_000;
// Namespaced so the BroadcastChannel and Web Lock names cannot drift apart.
const AUTH_NAMESPACE = "matts-aws-framework-auth";
const REFRESH_LOCK_NAME = `${AUTH_NAMESPACE}-refresh`;
const POST_AUTH_RETURN_TO_KEY = "post-auth-return-to";
const AUTH_NOTICE_KEY = "auth-notice";

type ApiRouteInput = ApiRoute | `${ApiRoute}?${string}`;
type AbsoluteUrl = `${"http" | "https"}://${string}`;
type FrameworkHttpApiFetchInput = ApiRouteInput | AbsoluteUrl | URL | Request;

type AuthState = { authenticated: boolean; unavailable?: boolean };
type WebStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
export type RefreshOutcome = "refreshed" | "expired" | "unavailable";
export type AuthStatus =
  | "authenticated"
  | "refreshing"
  | "reconnect-required"
  | "expired"
  | "signed-out";

export type AuthSnapshot = { status: AuthStatus };

export class SessionExpiredError extends Error {
  constructor(message = "Your session has expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class AuthServiceUnavailableError extends Error {
  constructor(message = "We couldn't reconnect to your session") {
    super(message);
    this.name = "AuthServiceUnavailableError";
  }
}

export const isSessionExpiredError = (
  error: unknown,
): error is SessionExpiredError => error instanceof SessionExpiredError;

export const isAuthServiceUnavailableError = (
  error: unknown,
): error is AuthServiceUnavailableError =>
  error instanceof AuthServiceUnavailableError;

const AUTH_SYNC_STORAGE_KEY = "auth-sync";
const AUTH_SYNC_CHANNEL_NAME = `${AUTH_NAMESPACE}-sync`;
const SESSION_HINT_KEY = "has-session";
// Non-HttpOnly companion to the refresh cookie. It holds no credential; it only
// tells the browser a refresh cookie should exist.
const SESSION_HINT_COOKIE = "hasSession";
const ID_TOKEN_STORAGE_KEY = "auth-id-token";
const ACCESS_TOKEN_STORAGE_KEY = "auth-access-token";

let memoryIdToken: string | null = null;
let authSnapshot: AuthSnapshot = { status: "signed-out" };
const authListeners = new Set<() => void>();
// The subject whose token this tab last held, and who to tell when that stops
// being true. Kept apart from authListeners: a status change is not always an
// identity change, and a refresh must not clear anybody's cache.
let identitySub: string | null = null;
const identityListeners = new Set<() => void>();
let refreshRequest: Promise<RefreshOutcome> | null = null;
let authSyncInitialized = false;
let authLifecycleInitialized = false;
let authStateInitialized = false;
let authBroadcastChannel: BroadcastChannel | null = null;
let refreshTimer: number | null = null;
let retryTimer: number | null = null;
let refreshRetryIndex = 0;
let tokenGeneration = 0;
const REFRESH_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
type AuthCacheOptions = {
  broadcast?: boolean;
};

type CognitoIdTokenClaims = {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  sub?: unknown;
  token_use?: unknown;
};

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function clearRefreshTimers(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function clearPersistedAuthData(): void {
  if (!isBrowserRuntime()) {
    return;
  }

  try {
    window.localStorage.removeItem(SESSION_HINT_KEY);
    window.localStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {}

  try {
    window.sessionStorage.removeItem(SESSION_HINT_KEY);
    window.sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {}
}

function clearLegacyBearerStorage(): void {
  if (!isBrowserRuntime()) return;

  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.removeItem(ID_TOKEN_STORAGE_KEY);
      storage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    } catch {}
  }
}

function decodeJwtPayload(idToken: string): CognitoIdTokenClaims | null {
  if (!isBrowserRuntime()) {
    return null;
  }

  const [, payloadSegment] = idToken.split(".");
  if (!payloadSegment) {
    return null;
  }

  try {
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as CognitoIdTokenClaims;
  } catch {
    return null;
  }
}

function getExpectedIssuer(): string | null {
  if (!AWS_REGION || !USER_POOL_ID) {
    return null;
  }

  return `https://cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}`;
}

function hasExpectedAudience(audience: unknown): boolean {
  if (!USER_POOL_CLIENT_ID) {
    return false;
  }

  if (typeof audience === "string") {
    return audience === USER_POOL_CLIENT_ID;
  }

  return (
    Array.isArray(audience) &&
    audience.some((value) => value === USER_POOL_CLIENT_ID)
  );
}

function validateStoredIdToken(idToken: string | null): boolean {
  if (!idToken) {
    return false;
  }

  const payload = decodeJwtPayload(idToken);
  if (!payload) {
    return false;
  }

  const expectedIssuer = getExpectedIssuer();
  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    payload.token_use === "id" &&
    typeof payload.sub === "string" &&
    payload.sub.length > 0 &&
    typeof payload.exp === "number" &&
    payload.exp > nowSeconds + ID_TOKEN_EXPIRY_SKEW_SECONDS &&
    hasExpectedAudience(payload.aud) &&
    (!expectedIssuer || payload.iss === expectedIssuer)
  );
}

/**
 * The one way the in-memory token changes, so identity tracking cannot miss a
 * path. Listeners hear when a signed-in subject stops being the subject — a
 * sign-out, an expiry, or a different user's token arriving from another tab —
 * and never on a refresh of the same user's token.
 */
function setMemoryIdToken(idToken: string | null): void {
  memoryIdToken = idToken;
  const sub = idToken ? decodeJwtPayload(idToken)?.sub : null;
  const next = typeof sub === "string" ? sub : null;
  if (idToken !== null && next === null) return;
  const previous = identitySub;
  identitySub = next;
  if (previous !== null && previous !== next) {
    identityListeners.forEach((listener) => listener());
  }
}

/**
 * Runs whenever this tab stops holding the previous user's identity. Anything
 * cached for that user — React Query's cache, above all — must be dropped
 * here, because the next render may belong to someone else.
 */
export function subscribeIdentityChange(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

function getValidStoredIdToken(): string | null {
  initializeAuthState();
  return validateStoredIdToken(memoryIdToken) ? memoryIdToken : null;
}

export function getCognitoIdToken(): string | null {
  return getValidStoredIdToken();
}

function storeAuthTokens(
  data: { idToken?: string },
  rememberSession: boolean,
  options: { broadcast?: boolean } = {},
): void {
  if (
    !isBrowserRuntime() ||
    !data.idToken ||
    !validateStoredIdToken(data.idToken)
  ) {
    return;
  }

  clearPersistedAuthData();
  setMemoryIdToken(data.idToken);
  tokenGeneration += 1;

  const storage = rememberSession ? window.localStorage : window.sessionStorage;
  setSessionHint(storage);
  setAuthStatus("authenticated");
  scheduleTokenRefresh();

  if (options.broadcast) {
    broadcastAuthStateChange("sign-in", data.idToken);
  }
}

/** @internal Used by the OAuth module after validating its API response. */
export function acceptAuthSession(
  data: SignInResponse,
  rememberSession: boolean,
): boolean {
  if (!data.idToken || !validateStoredIdToken(data.idToken)) {
    return false;
  }
  storeAuthTokens(data, rememberSession, { broadcast: true });
  return true;
}

function parseSignInResponse(data: unknown): SignInResponse {
  return SignInResponseSchema.parse(data);
}

function withAuthorizationHeader(
  init: RequestInit = {},
  options: { idToken?: string | null; replace?: boolean } = {},
): RequestInit {
  const headers = new Headers(init.headers);
  const idToken =
    options.idToken === undefined ? getValidStoredIdToken() : options.idToken;

  if (options.replace) {
    headers.delete("Authorization");
  }

  if (idToken) {
    headers.set("Authorization", `Bearer ${idToken}`);
  }

  return {
    ...init,
    headers,
  };
}

function initializeAuthState(): void {
  if (!isBrowserRuntime() || authStateInitialized) return;
  authStateInitialized = true;

  // Bearer tokens are memory-only. Remove any values written by older builds,
  // but never restore them into the active session.
  clearLegacyBearerStorage();

  if (getSessionHint()) {
    authSnapshot = { status: "authenticated" };
  }
}

function readSessionHintCookie(): "persistent" | "session" | null {
  if (!isBrowserRuntime()) {
    return null;
  }

  // String.raw: in an ordinary template literal "\s" is just "s", and the
  // pattern would then only match when the hint is the first cookie.
  const match = document.cookie.match(
    new RegExp(String.raw`(?:^|;\s*)${SESSION_HINT_COOKIE}=([^;]*)`),
  );
  if (!match) {
    return null;
  }

  return match[1] === "persistent" ? "persistent" : "session";
}

function getSessionHint(): boolean {
  if (!isBrowserRuntime()) {
    return false;
  }

  try {
    if (window.localStorage.getItem(SESSION_HINT_KEY) === "1") {
      return true;
    }
  } catch {}

  try {
    if (window.sessionStorage.getItem(SESSION_HINT_KEY) === "1") {
      return true;
    }
  } catch {}

  return readSessionHintCookie() !== null;
}

function hasPersistentSessionHint(): boolean {
  if (!isBrowserRuntime()) {
    return false;
  }

  try {
    if (window.localStorage.getItem(SESSION_HINT_KEY) === "1") {
      return true;
    }
  } catch {}

  return readSessionHintCookie() === "persistent";
}

function setSessionHint(storage: WebStorage): void {
  storage.setItem(SESSION_HINT_KEY, "1");
}

function setAuthStatus(status: AuthStatus): void {
  if (authSnapshot.status === status) return;
  authSnapshot = { status };
  authListeners.forEach((listener) => listener());
}

export function subscribeAuthState(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function getAuthSnapshot(): AuthSnapshot {
  initializeAuthState();
  return authSnapshot;
}

function getApiUrl(): string {
  return API_URL;
}

function getApiRequestInput(
  input: FrameworkHttpApiFetchInput,
): string | URL | Request {
  const requestInput =
    typeof input === "string" &&
    !input.startsWith("http://") &&
    !input.startsWith("https://")
      ? `${getApiUrl()}${input}`
      : input;
  const requestUrl =
    requestInput instanceof Request
      ? requestInput.url
      : requestInput instanceof URL
        ? requestInput.href
        : requestInput;
  const resolvedUrl = new URL(requestUrl, window.location.origin);

  if (resolvedUrl.origin !== window.location.origin) {
    throw new Error("Authenticated requests must use the application origin");
  }

  return requestInput;
}

function handleExternalAuthStateChange(
  reason?: "sign-in" | "sign-out" | "session-expired" | "token-refreshed",
  idToken?: string,
): void {
  if (reason === "sign-in" && !hasPersistentSessionHint()) {
    try {
      setSessionHint(window.sessionStorage);
    } catch {}
  }

  if (reason === "sign-out" || reason === "session-expired") {
    setMemoryIdToken(null);
    clearPersistedAuthData();
    clearRefreshTimers();
    setAuthStatus(reason === "session-expired" ? "expired" : "signed-out");
    return;
  }

  if (idToken && validateStoredIdToken(idToken)) {
    setMemoryIdToken(idToken);
    tokenGeneration += 1;
    setAuthStatus("authenticated");
    scheduleTokenRefresh();
  } else if (reason === "sign-in") {
    setAuthStatus("authenticated");
  }
}

function broadcastAuthStateChange(
  reason: "sign-in" | "sign-out" | "session-expired" | "token-refreshed",
  idToken?: string,
): void {
  if (!isBrowserRuntime()) {
    return;
  }

  const payload = JSON.stringify({ reason, at: Date.now() });

  try {
    window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, payload);
    window.localStorage.removeItem(AUTH_SYNC_STORAGE_KEY);
  } catch {
    // Ignore storage errors and rely on in-tab cache updates.
  }

  try {
    authBroadcastChannel?.postMessage({
      type: "auth-state-changed",
      reason,
      idToken,
    });
  } catch {
    // Ignore broadcast errors and rely on storage events.
  }
}

function initializeAuthSync(): void {
  if (!isBrowserRuntime() || authSyncInitialized) {
    return;
  }

  authSyncInitialized = true;

  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_SYNC_STORAGE_KEY && event.newValue) {
      try {
        const data = JSON.parse(event.newValue) as {
          reason?:
            "sign-in" | "sign-out" | "session-expired" | "token-refreshed";
        };
        handleExternalAuthStateChange(data.reason);
      } catch {
        handleExternalAuthStateChange();
      }
    }
  });

  if (typeof BroadcastChannel !== "undefined") {
    authBroadcastChannel = new BroadcastChannel(AUTH_SYNC_CHANNEL_NAME);
    authBroadcastChannel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as
        | {
            idToken?: string;
            reason?:
              "sign-in" | "sign-out" | "session-expired" | "token-refreshed";
            type?: string;
          }
        | undefined;
      if (data?.type === "auth-state-changed") {
        handleExternalAuthStateChange(data.reason, data.idToken);
      }
    };
  }
}

export function invalidateAuthCache(options: AuthCacheOptions = {}): void {
  setMemoryIdToken(null);
  clearRefreshTimers();
  if (options.broadcast) {
    clearPersistedAuthData();
    setAuthStatus("signed-out");
    broadcastAuthStateChange("sign-out");
  } else {
    setAuthStatus("signed-out");
  }
}

async function checkSessionOnClient(): Promise<AuthState> {
  initializeAuthLifecycle();
  if (getValidStoredIdToken()) return { authenticated: true };

  const outcome = await refreshSession();
  if (outcome === "refreshed") return { authenticated: true };
  if (outcome === "unavailable") {
    return { authenticated: true, unavailable: true };
  }
  return { authenticated: false };
}

function markSessionExpired(): void {
  setMemoryIdToken(null);
  clearPersistedAuthData();
  clearRefreshTimers();
  setAuthStatus("expired");
  broadcastAuthStateChange("session-expired");
}

function markSessionSignedOut(): void {
  setMemoryIdToken(null);
  clearPersistedAuthData();
  clearRefreshTimers();
  setAuthStatus("signed-out");
}

function markAuthUnavailable(): void {
  setAuthStatus("reconnect-required");
}

async function performRefresh(
  hadSessionHint: boolean,
  background: boolean,
): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REFRESH_TIMEOUT_MS,
  );
  setAuthStatus("refreshing");

  try {
    const response = await fetch(`${getApiUrl()}${API_ROUTE["/refresh"]}`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    });

    if (response.status === 401) {
      if (hadSessionHint) {
        markSessionExpired();
      } else {
        markSessionSignedOut();
      }
      return "expired";
    }
    if (!response.ok) {
      if (background && getValidStoredIdToken()) {
        setAuthStatus("authenticated");
      } else {
        markAuthUnavailable();
      }
      return "unavailable";
    }

    let data: SignInResponse;
    try {
      data = parseSignInResponse(await response.json());
    } catch {
      if (background && getValidStoredIdToken()) {
        setAuthStatus("authenticated");
      } else {
        markAuthUnavailable();
      }
      return "unavailable";
    }

    if (
      !data.success ||
      !data.idToken ||
      !validateStoredIdToken(data.idToken)
    ) {
      if (background && getValidStoredIdToken()) {
        setAuthStatus("authenticated");
      } else {
        markAuthUnavailable();
      }
      return "unavailable";
    }

    storeAuthTokens(data, hasPersistentSessionHint());
    refreshRetryIndex = 0;
    broadcastAuthStateChange("token-refreshed", data.idToken);
    return "refreshed";
  } catch {
    if (background && getValidStoredIdToken()) {
      setAuthStatus("authenticated");
    } else {
      markAuthUnavailable();
    }
    return "unavailable";
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function refreshSession(
  options: { background?: boolean } = {},
): Promise<RefreshOutcome> {
  if (!isBrowserRuntime()) return "expired";
  initializeAuthState();
  if (refreshRequest) return refreshRequest;

  const hadSessionHint = getSessionHint();
  // Nothing to refresh from: no bearer token in memory and no sign that a
  // refresh cookie exists. Skip the request that would answer 401.
  if (!hadSessionHint && !getValidStoredIdToken()) {
    markSessionSignedOut();
    return "expired";
  }

  const generationBeforeLock = tokenGeneration;
  const runRefresh = async (): Promise<RefreshOutcome> => {
    if (generationBeforeLock !== tokenGeneration && getValidStoredIdToken()) {
      return "refreshed";
    }
    return performRefresh(hadSessionHint, options.background === true);
  };

  refreshRequest = (async () => {
    const lockManager = navigator.locks;
    return lockManager
      ? lockManager.request(REFRESH_LOCK_NAME, runRefresh)
      : runRefresh();
  })();

  try {
    return await refreshRequest;
  } finally {
    refreshRequest = null;
  }
}

export async function FrameworkHttpApiFetch(
  input: FrameworkHttpApiFetchInput,
  init: RequestInit = {},
): Promise<Response> {
  initializeAuthLifecycle();
  const requestInput = getApiRequestInput(input);
  const requestTemplate =
    typeof Request !== "undefined" && requestInput instanceof Request
      ? requestInput.clone()
      : requestInput;
  const executeRequest = (requestInit: RequestInit) =>
    fetch(
      typeof Request !== "undefined" && requestTemplate instanceof Request
        ? requestTemplate.clone()
        : requestTemplate,
      requestInit,
    );
  let idToken = getValidStoredIdToken();

  if (!idToken) {
    const outcome = await refreshSession();
    if (outcome === "expired") throw new SessionExpiredError();
    if (outcome === "unavailable") throw new AuthServiceUnavailableError();
    idToken = getValidStoredIdToken();
  }

  if (!idToken) throw new AuthServiceUnavailableError();

  let requestInit: RequestInit = withAuthorizationHeader(
    {
      ...init,
      credentials: init.credentials ?? "include",
    },
    {
      idToken,
      replace: true,
    },
  );

  let response: Response;
  try {
    response = await executeRequest(requestInit);
  } catch {
    markAuthUnavailable();
    throw new AuthServiceUnavailableError();
  }
  if (response.status !== 401) {
    if (response.ok) setAuthStatus("authenticated");
    return response;
  }

  const outcome = await refreshSession();
  if (outcome === "expired") throw new SessionExpiredError();
  if (outcome === "unavailable") throw new AuthServiceUnavailableError();

  requestInit = withAuthorizationHeader(requestInit, {
    idToken: getValidStoredIdToken(),
    replace: true,
  });
  try {
    response = await executeRequest(requestInit);
  } catch {
    markAuthUnavailable();
    throw new AuthServiceUnavailableError();
  }

  if (response.status === 401) {
    markSessionExpired();
    throw new SessionExpiredError();
  }
  if (response.ok) setAuthStatus("authenticated");
  return response;
}

function scheduleTransientRefreshRetry(): void {
  if (!isBrowserRuntime() || retryTimer !== null) return;
  const delay =
    REFRESH_RETRY_DELAYS_MS[
      Math.min(refreshRetryIndex, REFRESH_RETRY_DELAYS_MS.length - 1)
    ];
  refreshRetryIndex += 1;
  const jitteredDelay = Math.round(delay * (0.85 + Math.random() * 0.3));
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (document.visibilityState === "visible" && navigator.onLine) {
      void runScheduledRefresh();
    }
  }, jitteredDelay);
}

async function runScheduledRefresh(): Promise<void> {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  const outcome = await refreshSession({ background: true });
  if (outcome === "unavailable") scheduleTransientRefreshRetry();
}

function scheduleTokenRefresh(): void {
  if (!isBrowserRuntime() || !memoryIdToken) return;
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);

  const claims = decodeJwtPayload(memoryIdToken);
  if (typeof claims?.iat !== "number" || typeof claims.exp !== "number") return;
  const refreshAtSeconds = claims.iat + (claims.exp - claims.iat) * 0.75;
  const delay = Math.max(0, refreshAtSeconds * 1000 - Date.now());
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    if (document.visibilityState === "visible" && navigator.onLine) {
      void runScheduledRefresh();
    }
  }, delay);
}

export function initializeAuthLifecycle(): void {
  if (!isBrowserRuntime() || authLifecycleInitialized) return;
  authLifecycleInitialized = true;
  initializeAuthState();
  initializeAuthSync();

  const resume = () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    if (!getSessionHint()) return;
    if (!getValidStoredIdToken()) void runScheduledRefresh();
    else scheduleTokenRefresh();
  };

  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  if (memoryIdToken) scheduleTokenRefresh();
}

export async function retryAuthSession(): Promise<RefreshOutcome> {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  return refreshSession();
}

function isSafeReturnTo(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/login") &&
    !value.startsWith("/auth/")
  );
}

export function prepareForReauthentication(): void {
  if (!isBrowserRuntime()) return;
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (isSafeReturnTo(returnTo)) {
    window.sessionStorage.setItem(POST_AUTH_RETURN_TO_KEY, returnTo);
  }
  window.sessionStorage.setItem(AUTH_NOTICE_KEY, "session-expired");
}

export function consumePostAuthReturnTo(): string {
  if (!isBrowserRuntime()) return "/";
  const value = window.sessionStorage.getItem(POST_AUTH_RETURN_TO_KEY) ?? "/";
  window.sessionStorage.removeItem(POST_AUTH_RETURN_TO_KEY);
  return isSafeReturnTo(value) ? value : "/";
}

export function consumeAuthNotice(): "session-expired" | null {
  if (!isBrowserRuntime()) return null;
  const value = window.sessionStorage.getItem(AUTH_NOTICE_KEY);
  window.sessionStorage.removeItem(AUTH_NOTICE_KEY);
  return value === "session-expired" ? value : null;
}

export async function checkSession(): Promise<AuthState> {
  if (!isBrowserRuntime()) {
    return { authenticated: false };
  }

  return checkSessionOnClient();
}

export async function requireAuth(): Promise<void> {
  const { authenticated } = await checkSession();
  if (!authenticated) {
    // Let the authenticated layout render the explicit session-expired state.
    // A user who deliberately signed out (or never had a session) still goes
    // directly to login.
    if (getAuthSnapshot().status === "expired") return;

    throw redirect({
      to: "/login",
      replace: true,
      search: { email: undefined, "account-verified": undefined },
    });
  }
}

export async function redirectIfAuthenticated(): Promise<void> {
  const { authenticated, unavailable } = await checkSession();
  if (authenticated && !unavailable) {
    throw redirect({ to: "/" });
  }
}

export async function signInUser(
  email: string,
  password: string,
  rememberMe = false,
): Promise<SignInResponse> {
  const response = await fetch(`${getApiUrl()}${API_ROUTE["/sign-in"]}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "password",
      email: email.trim().toLowerCase(),
      password,
      rememberMe,
    }),
  });

  const data = parseSignInResponse(await response.json());

  if (!response.ok) {
    if (
      response.status === 403 &&
      data.error?.toLowerCase().includes("verify your email")
    ) {
      return {
        success: false,
        error: "USER_NOT_CONFIRMED",
      };
    }
    return { success: false, error: data.error ?? "Sign in failed" };
  }

  if (data.challenge) {
    return { success: false, challenge: data.challenge };
  }

  if (!acceptAuthSession(data, rememberMe)) {
    return { success: false, error: "Sign in returned an invalid session" };
  }

  return { success: true };
}

export async function respondToMfaChallenge(
  challenge: SignInChallenge,
  code: string,
  rememberMe = false,
): Promise<SignInResponse> {
  const response = await fetch(`${getApiUrl()}${API_ROUTE["/sign-in"]}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "mfa",
      challengeName: challenge.name,
      session: challenge.session,
      username: challenge.username,
      code: code.trim(),
      rememberMe,
    }),
  });

  const data = parseSignInResponse(await response.json());
  if (!response.ok) {
    return {
      success: false,
      error: data.error ?? "Verification failed",
      challenge,
    };
  }

  if (data.challenge) {
    return { success: false, challenge: data.challenge };
  }

  if (!acceptAuthSession(data, rememberMe)) {
    return { success: false, error: "Sign in returned an invalid session" };
  }

  return { success: true };
}
