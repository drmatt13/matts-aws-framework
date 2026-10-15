import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig } from "../src/config/index";
import { assertCognitoVerifierInputs } from "../scripts/check-auth";
import { defaults } from "../../../framework-config/defaults";

const cognito = { USER_POOL_ID: "pool", USER_POOL_CLIENT_ID: "client" };
const configWith = (environment: Record<string, string>) =>
  defineFrameworkConfig({
    defaults,
    http: [
      {
        "/reports": { directory: "/lambda_functions/http_functions/reports", methods: ["GET"], auth: true, environment },
        "/health": { directory: "/lambda_functions/http_functions/health", methods: ["GET"] },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
  });

const verifies = "export const lambdaHandler = authenticated(async (event, session) => jsonResponse(200, {}));";
const plain = "export const lambdaHandler = async () => jsonResponse(200, {});";
const read = (sources: Record<string, string>) => (reference: string) => sources[reference];

test("a handler that verifies a Cognito token declares the pool it verifies against", () => {
  assertCognitoVerifierInputs(configWith(cognito), read({ "lambda:reports": verifies, "lambda:health": plain }));

  // An auth: true route that never verifies in its handler relies on the
  // gateway's authorizer alone, and needs nothing.
  assertCognitoVerifierInputs(configWith({}), read({ "lambda:reports": plain, "lambda:health": plain }));

  assert.throws(
    () => assertCognitoVerifierInputs(configWith({}), read({ "lambda:reports": verifies })),
    (error: Error) =>
      /^http\["\/reports"\]'s handler verifies a Cognito token with authenticated\(\)/.test(error.message) &&
      error.message.includes("USER_POOL_ID: resources.cognito.userPool.userPoolId,") &&
      error.message.includes("USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,"),
  );
  assert.throws(
    () =>
      assertCognitoVerifierInputs(
        configWith({ USER_POOL_ID: "pool" }),
        read({ "lambda:reports": "const payload = await verifyCognitoIdToken(token);" }),
      ),
    /with verifyCognitoIdToken\(\), .* does not set USER_POOL_CLIENT_ID, so/,
  );
  // Whatever its route says: the handler reads the variables either way.
  assert.throws(
    () => assertCognitoVerifierInputs(configWith(cognito), read({ "lambda:health": verifies })),
    /http\["\/health"\]'s handler verifies/,
  );
  // A method on another object, or a longer name, is not the verifier.
  assertCognitoVerifierInputs(
    configWith({}),
    read({ "lambda:reports": "session.authenticated(); isAuthenticated(x); unauthenticated(y);" }),
  );
});
