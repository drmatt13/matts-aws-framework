import {
  API_ROUTE,
  SignInResponseSchema,
  type SignInResponse,
} from "@repo/api-contract";
import { acceptAuthSession } from "./session";

const API_URL = "/api";
const COGNITO_DOMAIN_URL = import.meta.env.VITE_COGNITO_DOMAIN;
const USER_POOL_CLIENT_ID = import.meta.env.VITE_USER_POOL_CLIENT_ID;
const OAUTH_STATE_STORAGE_KEY = "oauth-state";

type OAuthState = {
  codeVerifier: string;
  rememberMe: boolean;
  state: string;
};

const oauthSignInRequests = new Map<string, Promise<SignInResponse>>();

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getOAuthRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

function getCognitoDomainUrl(): string {
  const domainUrl = String(COGNITO_DOMAIN_URL ?? "").replace(/\/+$/, "");
  if (!domainUrl) {
    throw new Error("Missing VITE_COGNITO_DOMAIN");
  }
  return domainUrl;
}

function generateRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const binary = Array.from(new Uint8Array(digest), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function storeOAuthState(state: OAuthState): void {
  window.sessionStorage.setItem(OAUTH_STATE_STORAGE_KEY, JSON.stringify(state));
}

function consumeOAuthState(incomingState: string): OAuthState {
  const stored = window.sessionStorage.getItem(OAUTH_STATE_STORAGE_KEY);
  window.sessionStorage.removeItem(OAUTH_STATE_STORAGE_KEY);

  if (!stored) {
    throw new Error("Missing OAuth state. Please try signing in again.");
  }

  const parsed = JSON.parse(stored) as Partial<OAuthState>;
  if (parsed.state !== incomingState) {
    throw new Error("OAuth state mismatch. Please try signing in again.");
  }
  if (typeof parsed.codeVerifier !== "string" || !parsed.codeVerifier) {
    throw new Error("Missing PKCE verifier. Please try signing in again.");
  }

  return {
    codeVerifier: parsed.codeVerifier,
    rememberMe: parsed.rememberMe === true,
    state: incomingState,
  };
}

export type SsoProviderId = "google" | "apple" | "microsoft";

type SsoProviderAuthConfig = {
  cognitoName: string;
  enabled: boolean;
};

const SSO_PROVIDERS: Record<SsoProviderId, SsoProviderAuthConfig> = {
  google: { cognitoName: "Google", enabled: true },
  apple: { cognitoName: "SignInWithApple", enabled: false },
  microsoft: { cognitoName: "MicrosoftEntraID", enabled: false },
};

export function isSsoProviderEnabled(provider: SsoProviderId): boolean {
  return SSO_PROVIDERS[provider].enabled;
}

async function redirectToHostedUi(
  idp: { identityProvider: string } | { idpIdentifier: string },
  rememberMe: boolean,
): Promise<void> {
  if (!isBrowserRuntime()) return;

  const state = generateRandomBase64Url(16);
  const codeVerifier = generateRandomBase64Url(48);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const authorizeUrl = new URL(`${getCognitoDomainUrl()}/oauth2/authorize`);

  authorizeUrl.searchParams.set("client_id", USER_POOL_CLIENT_ID);
  if ("identityProvider" in idp) {
    authorizeUrl.searchParams.set("identity_provider", idp.identityProvider);
  } else {
    authorizeUrl.searchParams.set("idp_identifier", idp.idpIdentifier);
  }
  authorizeUrl.searchParams.set("redirect_uri", getOAuthRedirectUri());
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("prompt", "select_account");

  storeOAuthState({ codeVerifier, rememberMe, state });
  window.location.assign(authorizeUrl.toString());
}

export async function signInWithProvider(
  provider: SsoProviderId,
  rememberMe = false,
): Promise<void> {
  const config = SSO_PROVIDERS[provider];
  if (!config.enabled) {
    throw new Error(`SSO provider "${provider}" is not enabled`);
  }
  await redirectToHostedUi(
    { identityProvider: config.cognitoName },
    rememberMe,
  );
}

export async function signInWithOrgSso(
  idpIdentifier: string,
  rememberMe = false,
): Promise<void> {
  await redirectToHostedUi({ idpIdentifier }, rememberMe);
}

export type OrgSsoDiscovery = { idpIdentifier: string };

/** Stub until the Enterprise IdP-discovery endpoint ships. */
export async function discoverOrgSso(
  _email: string,
): Promise<OrgSsoDiscovery | null> {
  return null;
}

export async function completeOAuthSignIn(
  code: string,
  state: string,
): Promise<SignInResponse> {
  const requestKey = `${state}:${code}`;
  const existingRequest = oauthSignInRequests.get(requestKey);
  if (existingRequest) return existingRequest;

  const request = (async (): Promise<SignInResponse> => {
    const oauthState = consumeOAuthState(state);
    const oauthCallbackUrl = `${API_URL}${API_ROUTE["/oauth/callback"]}`;
    const response = await fetch(oauthCallbackUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        codeVerifier: oauthState.codeVerifier,
        redirectUri: getOAuthRedirectUri(),
        rememberMe: oauthState.rememberMe,
      }),
    });

    const responseBody = await response.text();
    let data: SignInResponse;
    try {
      data = SignInResponseSchema.parse(JSON.parse(responseBody));
    } catch {
      return {
        success: false,
        error: `OAuth callback API did not return JSON from ${oauthCallbackUrl}. Restart the frontend/API dev servers and verify the Vite /api proxy target. Response started with: ${responseBody.slice(0, 120)}`,
      };
    }

    if (!response.ok) {
      return { success: false, error: data.error ?? "Sign in failed" };
    }
    if (!acceptAuthSession(data, oauthState.rememberMe)) {
      return {
        success: false,
        error: "OAuth sign in returned an invalid session",
      };
    }
    return { success: true };
  })();

  oauthSignInRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (oauthSignInRequests.get(requestKey) === request) {
      oauthSignInRequests.delete(requestKey);
    }
  }
}
