import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineResources, resource } from "../src/config/index";
import { assertCognitoVerifierInputs, calledVerifier } from "../scripts/check-auth";
import { defaults } from "../../../framework-config/defaults";

const resources = defineResources({ pool: resource.cdk<IUserPool>(), client: resource.cdk<IUserPoolClient>() });
const userPool = { userPoolId: resources.pool.userPoolId, userPoolClientId: resources.client.userPoolClientId };
const cognito = { USER_POOL_ID: "pool", USER_POOL_CLIENT_ID: "client" };
const configWith = (reports: Record<string, unknown>, options: { readonly pool?: boolean } = {}) =>
  defineFrameworkConfig({ networks: [fixtureVpc],
    resources,
    defaults,
    ...(options.pool ? { userPool } : {}),
    http: [
      {
        "/reports": { directory: "/lambda_functions/http_functions/reports", methods: ["GET"], auth: true, ...reports },
        "/health": { directory: "/lambda_functions/http_functions/health", methods: ["GET"] },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
  } as never);

const auth = 'import { authenticated, verifyCognitoIdToken } from "@repo/framework/runtime/auth";\n';
const verifies = `${auth}export const lambdaHandler = authenticated(async (event, session) => jsonResponse(200, {}));`;
const plain = "export const lambdaHandler = async () => jsonResponse(200, {});";
const read = (sources: Record<string, string>) => (reference: string) => sources[reference];

test("a handler that verifies a Cognito token is handed the pool it verifies against", () => {
  // Handed the config's pool, or naming its own: both are complete.
  assertCognitoVerifierInputs(configWith({ userPool: true }, { pool: true }), read({ "lambda:reports": verifies, "lambda:health": plain }));
  assertCognitoVerifierInputs(configWith({ environment: cognito }), read({ "lambda:reports": verifies, "lambda:health": plain }));

  // An auth: true route that never verifies in its handler relies on the
  // gateway's authorizer alone, and needs nothing.
  assertCognitoVerifierInputs(configWith({}), read({ "lambda:reports": plain, "lambda:health": plain }));

  assert.throws(
    () => assertCognitoVerifierInputs(configWith({}, { pool: true }), read({ "lambda:reports": verifies })),
    /http\["\/reports"\]'s handler verifies a Cognito token with authenticated\(\), .* and is handed neither, so every signed-in request would fail\. Add userPool: true to this declaration\./,
  );
  assert.throws(
    () => assertCognitoVerifierInputs(configWith({}), read({ "lambda:reports": verifies })),
    /is handed neither, .* Name the application's pool once in framework\.config\.ts, as userPool: \{ userPoolId: .*\}, then add userPool: true/,
  );
  assert.throws(
    () =>
      assertCognitoVerifierInputs(
        configWith({ environment: { USER_POOL_ID: "pool" } }),
        read({ "lambda:reports": `${auth}const payload = await verifyCognitoIdToken(token);` }),
      ),
    /with verifyCognitoIdToken\(\), .* names only one of them\. Declare USER_POOL_CLIENT_ID as well, or neither and add userPool: true/,
  );
  // Whatever its route says: the handler reads the variables either way.
  assert.throws(
    () => assertCognitoVerifierInputs(configWith({ userPool: true }, { pool: true }), read({ "lambda:health": verifies })),
    /http\["\/health"\]'s handler verifies/,
  );
  // A method on another object, or a longer name, is not the verifier.
  assertCognitoVerifierInputs(
    configWith({}),
    read({ "lambda:reports": `${auth}session.authenticated(); isAuthenticated(x); unauthenticated(y);` }),
  );
  // A container Lambda's index.ts need not be its entry point, so it is not read.
  assertCognitoVerifierInputs(configWith({ packaging: "container" }), read({ "lambda:reports": verifies }));
});

test("only a verifier imported from the framework and then called counts", () => {
  const from = '"@repo/framework/runtime/auth"';
  for (const [source, expected] of [
    [`import { authenticated } from ${from};\nexport const lambdaHandler = authenticated(handler);`, "authenticated"],
    [`import { authenticated as signedIn } from ${from};\nexport const lambdaHandler = signedIn(handler);`, "authenticated"],
    [`import * as auth from ${from};\nexport const lambdaHandler = auth.getAuthenticatedSession(event);`, "getAuthenticatedSession"],
    // Mentioned, never called; or called, never imported from the framework.
    [`import { authenticated } from ${from};\n// wrap it in authenticated() later\nconst note = "authenticated(";`, undefined],
    ["const authenticated = (h: unknown) => h;\nexport const lambdaHandler = authenticated(handler);", undefined],
    ["import { authenticated } from \"./local-auth\";\nexport const lambdaHandler = authenticated(handler);", undefined],
    [`import type { AuthenticatedHttpHandler } from ${from};\nexport const x = authenticated(handler);`, undefined],
    [`import { jsonResponse } from "@repo/framework/runtime/http";\nexport const lambdaHandler = async () => jsonResponse(200, {});`, undefined],
  ] as const) {
    assert.equal(calledVerifier(source), expected, source);
  }
});
