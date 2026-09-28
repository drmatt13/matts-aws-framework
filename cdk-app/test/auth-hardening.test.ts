import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { resolveDeploymentInputs, resolveFrontendSettings } from "../deployment";
import { lambdaHandler } from "../lambda_functions/event_functions/cognito-pre-signup-trigger/index";

// ---------------------------------------------------------------------------
// Federated linking: a Google identity may join an existing account only when
// that account proved the same address.
// ---------------------------------------------------------------------------

type NativeUser = {
  Username: string;
  UserStatus: string;
  Attributes: { Name: string; Value: string }[];
};

const originalSend = CognitoIdentityProviderClient.prototype.send;
afterEach(() => {
  CognitoIdentityProviderClient.prototype.send = originalSend;
  delete process.env.SKIP_EMAIL_VERIFICATION;
});

async function signInWithGoogle(existing: NativeUser[]): Promise<string[]> {
  const linked: string[] = [];
  CognitoIdentityProviderClient.prototype.send = (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    switch (command.constructor.name) {
      case "ListIdentityProvidersCommand":
        return { Providers: [{ ProviderName: "Google" }] };
      case "ListUsersCommand":
        return { Users: existing };
      case "AdminLinkProviderForUserCommand":
        linked.push((command.input.DestinationUser as { ProviderAttributeValue: string }).ProviderAttributeValue);
        return {};
      default:
        throw new Error(`Unexpected ${command.constructor.name}`);
    }
  }) as never;
  const event = {
    triggerSource: "PreSignUp_ExternalProvider",
    userName: "google_1234567890",
    userPoolId: "us-east-1_pool",
    request: { userAttributes: { email: "victim@example.com", email_verified: "true" } },
    response: {},
  } as unknown as PreSignUpTriggerEvent;
  await lambdaHandler(event);
  return linked;
}

const native = (overrides: Partial<NativeUser> & { verified?: string }): NativeUser => ({
  Username: overrides.Username ?? "native-user",
  UserStatus: overrides.UserStatus ?? "CONFIRMED",
  Attributes: [
    { Name: "email", Value: "victim@example.com" },
    { Name: "email_verified", Value: overrides.verified ?? "true" },
  ],
});

test("links to a confirmed account whose own email is verified", async () => {
  assert.deepEqual(await signInWithGoogle([native({})]), ["native-user"]);
});

test("never links to an account that has not proved the address", async () => {
  // Someone signed up with the address, or changed their email to it, and never
  // read a message sent there.
  assert.deepEqual(await signInWithGoogle([native({ verified: "false" })]), []);
  assert.deepEqual(await signInWithGoogle([native({ UserStatus: "UNCONFIRMED" })]), []);
});

test("never links while email verification is skipped", async () => {
  process.env.SKIP_EMAIL_VERIFICATION = "true";
  assert.deepEqual(await signInWithGoogle([native({})]), []);
});

// ---------------------------------------------------------------------------
// Deployment inputs
// ---------------------------------------------------------------------------

function inputs(env: Record<string, string>, context: Record<string, unknown> = {}) {
  return resolveDeploymentInputs({
    getContext: (key) => context[key],
    env: { CDK_DEFAULT_ACCOUNT: "111122223333", CDK_DEFAULT_REGION: "us-east-1", ...env },
  });
}

test("skipping email verification is explicit and development-only", () => {
  const dev = inputs({ PROD_DEPLOYMENT: "false" });
  // No frontend URL no longer implies skipping verification.
  assert.equal(resolveFrontendSettings(dev).skipEmailVerification, false);
  assert.equal(
    resolveFrontendSettings(inputs({ PROD_DEPLOYMENT: "false", SKIP_EMAIL_VERIFICATION: "true" }))
      .skipEmailVerification,
    true,
  );
  assert.throws(
    () => inputs({ PROD_DEPLOYMENT: "true", SKIP_EMAIL_VERIFICATION: "true" }),
    /development setting/,
  );
});

test("the retired WebSocket authorizer flag refuses false and warns on true", () => {
  assert.throws(
    () => inputs({ PROD_DEPLOYMENT: "true", USE_CUSTOM_WS_AUTHORIZER: "false" }),
    /no longer supported/,
  );
  assert.ok(
    inputs({ PROD_DEPLOYMENT: "true", USE_CUSTOM_WS_AUTHORIZER: "true" }).warnings.some((warning) =>
      warning.includes("USE_CUSTOM_WS_AUTHORIZER is no longer read"),
    ),
  );
});

test("production warns without an SES sender, and backups default to a week", () => {
  const prod = inputs({ PROD_DEPLOYMENT: "true" });
  assert.equal(prod.databaseBackupRetentionDays, 7);
  assert.ok(prod.warnings.some((warning) => warning.includes("COGNITO_SES_FROM_EMAIL")));
  assert.equal(
    inputs({ PROD_DEPLOYMENT: "true", COGNITO_SES_FROM_EMAIL: "auth@example.com" }).warnings.some(
      (warning) => warning.includes("COGNITO_SES_FROM_EMAIL"),
    ),
    false,
  );
  assert.throws(
    () => inputs({ PROD_DEPLOYMENT: "true", DATABASE_BACKUP_RETENTION_DAYS: "40" }),
    /DATABASE_BACKUP_RETENTION_DAYS must be a whole number from 0 to 35/,
  );
});
