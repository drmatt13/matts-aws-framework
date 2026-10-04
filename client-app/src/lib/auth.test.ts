// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientId = "test-client-id";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/test-pool";

class TestBroadcastChannel {
  static channels = new Map<string, Set<TestBroadcastChannel>>();

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(private readonly name: string) {
    const channels = TestBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    TestBroadcastChannel.channels.set(name, channels);
  }

  postMessage(data: unknown) {
    for (const channel of TestBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel !== this) {
        channel.onmessage?.(new MessageEvent("message", { data }));
      }
    }
  }

  static reset() {
    TestBroadcastChannel.channels.clear();
  }
}

function makeIdToken(expiresInSeconds = 3600, sub = "test-user"): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = window.btoa(
    JSON.stringify({
      aud: clientId,
      exp: now + expiresInSeconds,
      iat: now,
      iss: issuer,
      sub,
      token_use: "id",
    }),
  );
  return `header.${payload.replace(/=/g, "")}.signature`;
}

async function loadAuth(options: { broadcast?: boolean } = {}) {
  vi.stubEnv("VITE_AWS_REGION", "us-east-1");
  vi.stubEnv("VITE_USER_POOL_ID", "test-pool");
  vi.stubEnv("VITE_USER_POOL_CLIENT_ID", clientId);
  vi.stubGlobal(
    "BroadcastChannel",
    options.broadcast ? TestBroadcastChannel : undefined,
  );
  return import("./auth");
}

function clearSessionHintCookie(): void {
  document.cookie = "hasSession=; Max-Age=0; Path=/";
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearSessionHintCookie();
  window.sessionStorage.setItem("has-session", "1");
});

afterEach(() => {
  TestBroadcastChannel.reset();
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cross-tab auth coordination", () => {
  it("uses one refresh request and shares the renewed token", async () => {
    let lockQueue = Promise.resolve();
    const lockRequest = vi.fn(
      <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
        const result = lockQueue.then(callback);
        lockQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: lockRequest },
    });

    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstTab = await loadAuth({ broadcast: true });
    firstTab.initializeAuthLifecycle();
    vi.resetModules();
    const secondTab = await loadAuth({ broadcast: true });
    secondTab.initializeAuthLifecycle();

    await expect(
      Promise.all([firstTab.refreshSession(), secondTab.refreshSession()]),
    ).resolves.toEqual(["refreshed", "refreshed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstTab.getCognitoIdToken()).toBe(idToken);
    expect(secondTab.getCognitoIdToken()).toBe(idToken);
  });

  it("propagates sign-out without persisting a bearer token", async () => {
    const idToken = makeIdToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const firstTab = await loadAuth({ broadcast: true });
    firstTab.initializeAuthLifecycle();
    vi.resetModules();
    const secondTab = await loadAuth({ broadcast: true });
    secondTab.initializeAuthLifecycle();

    await firstTab.signInUser("user@example.com", "password");
    expect(secondTab.getCognitoIdToken()).toBe(idToken);

    firstTab.invalidateAuthCache({ broadcast: true });
    expect(secondTab.getAuthSnapshot().status).toBe("signed-out");
    expect(window.localStorage.getItem("auth-id-token")).toBeNull();
    expect(window.sessionStorage.getItem("auth-id-token")).toBeNull();
  });
});

describe("refreshSession", () => {
  it("restores a cookie-backed session without a JavaScript session hint", async () => {
    window.sessionStorage.removeItem("has-session");
    document.cookie = "hasSession=session; Path=/";
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { checkSession, getAuthSnapshot } = await loadAuth();

    await expect(checkSession()).resolves.toEqual({ authenticated: true });
    expect(getAuthSnapshot().status).toBe("authenticated");
    expect(window.sessionStorage.getItem("has-session")).toBe("1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("finds the session hint cookie when another cookie precedes it", async () => {
    window.sessionStorage.removeItem("has-session");
    // Exactly what a browser reports when another readable cookie was set
    // first: "; " between entries, the hint not at the start.
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "theme=dark; hasSession=session",
    );
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { checkSession } = await loadAuth();

    await expect(checkSession()).resolves.toEqual({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("signs out without a request when no session hint exists", async () => {
    window.sessionStorage.removeItem("has-session");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getAuthSnapshot, refreshSession } = await loadAuth();

    await expect(refreshSession()).resolves.toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAuthSnapshot().status).toBe("signed-out");
  });

  it("deduplicates concurrent refresh requests", async () => {
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { refreshSession } = await loadAuth();

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => refreshSession()),
    );

    expect(outcomes).toEqual(Array(10).fill("refreshed"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 429])(
    "preserves the session hint for transient HTTP %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ success: false }), { status }),
          ),
      );
      const { getAuthSnapshot, refreshSession } = await loadAuth();

      await expect(refreshSession()).resolves.toBe("unavailable");
      expect(window.sessionStorage.getItem("has-session")).toBe("1");
      expect(getAuthSnapshot().status).toBe("reconnect-required");
    },
  );

  it("preserves the session after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { refreshSession } = await loadAuth();

    await expect(refreshSession()).resolves.toBe("unavailable");
    expect(window.sessionStorage.getItem("has-session")).toBe("1");
  });

  it("times out a stalled refresh without expiring the session", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const { refreshSession } = await loadAuth();

    const refresh = refreshSession();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(refresh).resolves.toBe("unavailable");
    expect(window.sessionStorage.getItem("has-session")).toBe("1");
  });

  it("does not authenticate a malformed successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>not json</html>", { status: 200 }),
        ),
    );
    const { getAuthSnapshot, refreshSession } = await loadAuth();

    await expect(refreshSession()).resolves.toBe("unavailable");
    expect(getAuthSnapshot().status).toBe("reconnect-required");
  });

  it("clears local auth state only for terminal refresh rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: false }), { status: 401 }),
        ),
    );
    const { getAuthSnapshot, refreshSession } = await loadAuth();

    await expect(refreshSession()).resolves.toBe("expired");
    expect(window.sessionStorage.getItem("has-session")).toBeNull();
    expect(getAuthSnapshot().status).toBe("expired");
  });
});

describe("auth lifecycle", () => {
  it("deletes legacy browser-stored bearer tokens without restoring them", async () => {
    window.sessionStorage.removeItem("has-session");
    window.localStorage.setItem("auth-id-token", makeIdToken());
    window.sessionStorage.setItem("auth-access-token", "legacy-access-token");
    const { getAuthSnapshot, getCognitoIdToken } = await loadAuth();

    expect(getCognitoIdToken()).toBeNull();
    expect(getAuthSnapshot().status).toBe("signed-out");
    expect(window.localStorage.getItem("auth-id-token")).toBeNull();
    expect(window.sessionStorage.getItem("auth-access-token")).toBeNull();
  });

  it("redirects a no-hint refresh rejection to login", async () => {
    window.sessionStorage.removeItem("has-session");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: false }), { status: 401 }),
        ),
    );
    const { getAuthSnapshot, requireAuth } = await loadAuth();

    await expect(requireAuth()).rejects.toMatchObject({
      options: expect.objectContaining({ to: "/login", replace: true }),
    });
    expect(getAuthSnapshot().status).toBe("signed-out");
  });

  it("restores a known session during a protected-route reload", async () => {
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAuthSnapshot, requireAuth } = await loadAuth();

    await expect(requireAuth()).resolves.toBeUndefined();
    expect(getAuthSnapshot().status).toBe("authenticated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a known session when an idle tab regains focus", async () => {
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const { getAuthSnapshot, initializeAuthLifecycle } = await loadAuth();

    initializeAuthLifecycle();
    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(getAuthSnapshot().status).toBe("authenticated");
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("renews at 75 percent of the ID-token lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const originalToken = makeIdToken(3600);
    const refreshedToken = makeIdToken(7200);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, idToken: originalToken }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, idToken: refreshedToken }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { signInUser } = await loadAuth();

    await signInUser("user@example.com", "password");
    await vi.advanceTimersByTimeAsync(2_699_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a still-valid session usable when background renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const idToken = makeIdToken(3600);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false }), { status: 503 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { getAuthSnapshot, signInUser } = await loadAuth();

    await signInUser("user@example.com", "password");
    await vi.advanceTimersByTimeAsync(2_700_000);

    expect(getAuthSnapshot().status).toBe("authenticated");
  });

  it("keeps an expired protected route mounted for explicit reauthentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: false }), { status: 401 }),
        ),
    );
    const { getAuthSnapshot, requireAuth } = await loadAuth();

    await expect(requireAuth()).resolves.toBeUndefined();
    expect(getAuthSnapshot().status).toBe("expired");
  });
});

describe("OAuth callback", () => {
  it("rejects a malformed successful session response", async () => {
    window.sessionStorage.removeItem("has-session");
    window.sessionStorage.setItem(
      "oauth-state",
      JSON.stringify({
        codeVerifier: "test-verifier",
        rememberMe: false,
        state: "test-state",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        ),
    );
    const { completeOAuthSignIn, getAuthSnapshot } = await loadAuth();

    await expect(
      completeOAuthSignIn("test-code", "test-state"),
    ).resolves.toEqual({
      success: false,
      error: "OAuth sign in returned an invalid session",
    });
    expect(getAuthSnapshot().status).not.toBe("authenticated");
  });
});

describe("same-origin API routing", () => {
  it("signs in through the browser-visible /api path", async () => {
    const idToken = makeIdToken();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { signInUser } = await loadAuth();

    await expect(signInUser("user@example.com", "password")).resolves.toEqual({
      success: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sign-in",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      type: "password",
      email: "user@example.com",
      password: "password",
      rememberMe: false,
    });
  });

  it("completes an MFA challenge before caching the ID token", async () => {
    const idToken = makeIdToken();
    const challenge = {
      name: "SOFTWARE_TOKEN_MFA" as const,
      session: "challenge-session",
      username: "cognito-username",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, challenge }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { getCognitoIdToken, respondToMfaChallenge, signInUser } =
      await loadAuth();

    await expect(
      signInUser("user@example.com", "password", true),
    ).resolves.toEqual({ success: false, challenge });
    expect(getCognitoIdToken()).toBeNull();

    await expect(
      respondToMfaChallenge(challenge, "123456", true),
    ).resolves.toEqual({ success: true });
    expect(getCognitoIdToken()).toBe(idToken);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      type: "mfa",
      challengeName: "SOFTWARE_TOKEN_MFA",
      session: "challenge-session",
      username: "cognito-username",
      code: "123456",
      rememberMe: true,
    });
  });
});

describe("FrameworkHttpApiFetch", () => {
  it("uses an exact same-origin agent URL and retries that same path after refreshing", async () => {
    const originalToken = makeIdToken(600);
    const refreshedToken = makeIdToken(3600);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, idToken: originalToken }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const auth = await loadAuth();
    await auth.signInUser("user@example.com", "password");

    let agentCalls = 0;
    const paths: string[] = [];
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const requestPath = new URL(url, window.location.origin).pathname;
      paths.push(requestPath);
      if (requestPath === "/api/refresh") {
        return new Response(JSON.stringify({ success: true, idToken: refreshedToken }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      authorizations.push(new Headers(init?.headers).get("Authorization")!);
      agentCalls += 1;
      return new Response("", { status: agentCalls === 1 ? 401 : 200 });
    }));
    const response = await auth.FrameworkHttpApiFetch(new URL("/chat/echo", window.location.origin), {
      method: "POST", body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(paths).toEqual(["/chat/echo", "/api/refresh", "/chat/echo"]);
    expect(authorizations).toEqual([`Bearer ${originalToken}`, `Bearer ${refreshedToken}`]);
  });

  it("replays a Request body once after refresh", async () => {
    const originalToken = makeIdToken(600);
    const refreshedToken = makeIdToken(3600);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, idToken: originalToken }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const auth = await loadAuth();
    await auth.signInUser("user@example.com", "password");

    const protectedBodies: string[] = [];
    let protectedCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (requestUrl.endsWith("/refresh")) {
        return new Response(
          JSON.stringify({ success: true, idToken: refreshedToken }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const request = input instanceof Request ? input : new Request(input);
      protectedCalls += 1;
      protectedBodies.push(await request.text());
      return new Response("", { status: protectedCalls === 1 ? 401 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(`${window.location.origin}/protected`, {
      method: "POST",
      body: JSON.stringify({ value: 42 }),
      headers: { "content-type": "application/json" },
    });

    const response = await auth.FrameworkHttpApiFetch(request);

    expect(response.status).toBe(200);
    expect(protectedBodies).toEqual([
      JSON.stringify({ value: 42 }),
      JSON.stringify({ value: 42 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses to send a bearer token to another origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { FrameworkHttpApiFetch } = await loadAuth();

    await expect(
      FrameworkHttpApiFetch("https://third-party.example/protected"),
    ).rejects.toThrow("Authenticated requests must use the application origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("identity changes", () => {
  function respondWith(idToken: string) {
    return vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("notifies on sign-out but not on a refresh of the same user", async () => {
    vi.stubGlobal("fetch", respondWith(makeIdToken()));
    const auth = await loadAuth();
    const changed = vi.fn();
    auth.subscribeIdentityChange(changed);

    await auth.signInUser("user@example.com", "password");
    await auth.refreshSession();
    expect(changed).not.toHaveBeenCalled();

    auth.invalidateAuthCache({ broadcast: true });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("notifies when another tab signs a different user in", async () => {
    vi.stubGlobal("fetch", respondWith(makeIdToken(3600, "first-user")));
    const firstTab = await loadAuth({ broadcast: true });
    firstTab.initializeAuthLifecycle();
    await firstTab.signInUser("first@example.com", "password");

    vi.resetModules();
    vi.stubGlobal("fetch", respondWith(makeIdToken(3600, "second-user")));
    const secondTab = await loadAuth({ broadcast: true });
    secondTab.initializeAuthLifecycle();
    const changed = vi.fn();
    firstTab.subscribeIdentityChange(changed);

    await secondTab.signInUser("second@example.com", "password");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
