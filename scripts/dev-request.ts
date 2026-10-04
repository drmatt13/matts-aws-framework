/**
 * Makes one authenticated request to the local API as the local test user.
 *
 * Development only. It signs in through the app's own /sign-in route, which
 * returns an ID token and checks the request's origin, then calls the route
 * with that token. Neither the password nor the token is printed: the output
 * is the status and the response body.
 *
 *   npm run dev:request -- POST /graphql '{"query":"{ currentUser { id email } }"}'
 */
import { PROD_DEPLOYMENT, readAuthoredInputs } from "@repo/framework/config/source";

async function main(): Promise<void> {
  if (PROD_DEPLOYMENT) {
    throw new Error("dev:request refuses to run while cdk-app/.env says PROD_DEPLOYMENT=true.");
  }
  const inputs = readAuthoredInputs();
  const email = inputs.LOCAL_TEST_USER_EMAIL;
  const password = inputs.LOCAL_TEST_USER_PASSWORD;
  const port = inputs.LOCAL_API_DEV_SERVER_HOST_PORT;
  const origin = inputs.LOCAL_DEV_URL;
  if (!email || !password || !port || !origin) {
    throw new Error("Set LOCAL_TEST_USER_EMAIL, LOCAL_TEST_USER_PASSWORD, LOCAL_API_DEV_SERVER_HOST_PORT and LOCAL_DEV_URL in cdk-app/.env.");
  }
  const [method, path, body] = process.argv.slice(2);
  if (!method || !path?.startsWith("/")) {
    throw new Error("Usage: npm run dev:request -- <METHOD> </route> [json-body]");
  }

  const api = `http://127.0.0.1:${port}`;
  const signIn = await fetch(`${api}/api/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ type: "password", email, password }),
  });
  const session = (await signIn.json().catch(() => ({}))) as {
    idToken?: string;
    challenge?: unknown;
    error?: string;
  };
  if (!signIn.ok || !session.idToken) {
    throw new Error(
      session.challenge
        ? "The test user has two-step verification on; use a user without it."
        : `Sign-in failed with HTTP ${signIn.status}${session.error ? `: ${session.error}` : ""}.`,
    );
  }

  const response = await fetch(`${api}/api${path}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: `Bearer ${session.idToken}`,
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
