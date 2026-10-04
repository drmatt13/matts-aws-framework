import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * A user pool for tests: real RS256 keys, a JWKS answered at the URL the
 * verifier derives from USER_POOL_ID, and ID tokens signed like Cognito's.
 *
 * The verifier in runtime/auth caches its configuration for the life of the
 * process, so every test file uses this one pool's identity.
 */
export const TEST_POOL = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client",
} as const;

const issuer = `https://cognito-idp.${TEST_POOL.region}.amazonaws.com/${TEST_POOL.userPoolId}`;

export interface TestCognito {
  /** An ID token for `sub`, valid for an hour unless overridden. */
  idToken(sub: string, claims?: Record<string, unknown>): Promise<string>;
  /** A pool-signed token that expired a minute ago. */
  expiredIdToken(sub: string): Promise<string>;
  /** A pool-signed token for another app client. */
  otherClientIdToken(sub: string): Promise<string>;
  /** A token with the right claims signed by a key the pool never published. */
  forgedIdToken(sub: string): Promise<string>;
  restore(): void;
}

async function sign(
  key: CryptoKey,
  sub: string,
  claims: Record<string, unknown> = {},
  options: { readonly expires?: string | number; readonly audience?: string } = {},
): Promise<string> {
  return new SignJWT({ token_use: "id", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(options.audience ?? TEST_POOL.clientId)
    .setSubject(sub)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(key);
}

export async function startTestCognito(): Promise<TestCognito> {
  process.env.AWS_REGION = TEST_POOL.region;
  process.env.USER_POOL_ID = TEST_POOL.userPoolId;
  process.env.USER_POOL_CLIENT_ID = TEST_POOL.clientId;

  const pool = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(pool.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${issuer}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return original(input, init);
  }) as typeof fetch;

  return {
    idToken: (sub, claims) => sign(pool.privateKey, sub, claims),
    expiredIdToken: (sub) => sign(pool.privateKey, sub, {}, { expires: Math.floor(Date.now() / 1000) - 60 }),
    otherClientIdToken: (sub) => sign(pool.privateKey, sub, {}, { audience: "another-client" }),
    forgedIdToken: (sub) => sign(stranger.privateKey, sub),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
