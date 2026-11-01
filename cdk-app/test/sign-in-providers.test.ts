import assert from "node:assert/strict";
import test from "node:test";
import { App, SecretValue, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { resources } from "../../framework-config/resources";
import { SIGN_IN_PROVIDERS, signInProviderKeys, type SignInProviderSettings } from "../../framework-config/resources/sign-in-providers";
import { resolveDeploymentInputs } from "../deployment";
import { lambdaHandler } from "../lambda_functions/event_functions/cognito-pre-token-generation/index";
import { CognitoStack } from "../lib/app/cognito-stack";
import { appEventRegistry } from "../lib/framework/framework-events";

const env = { account: "111122223333", region: "us-east-1" };
const tenant = "00000000-1111-2222-3333-444444444444";
const resolve = (file: Record<string, string>) =>
  resolveDeploymentInputs({ getContext: () => undefined, env: { CDK_DEFAULT_ACCOUNT: env.account, CDK_DEFAULT_REGION: env.region, ...file } }).signInProviders;

// ---------------------------------------------------------------------------
// The inputs file decides which providers exist
// ---------------------------------------------------------------------------

test("a provider is included when its inputs file sets all of its lines, and absent when it sets none", () => {
  assert.deepEqual(resolve({}), {});
  assert.deepEqual(resolve({ GOOGLE_CLIENT_ID: " google-client ", GOOGLE_CLIENT_SECRET: "fixture" }), { google: { clientId: "google-client" } });
  assert.deepEqual(
    resolve({
      MICROSOFT_CLIENT_ID: "microsoft-client", MICROSOFT_TENANT_ID: tenant, MICROSOFT_CLIENT_SECRET: "fixture",
      META_APP_ID: "meta-app", META_APP_SECRET: "fixture",
    }),
    { microsoft: { clientId: "microsoft-client", tenantId: tenant }, meta: { appId: "meta-app" } },
  );
});

test("a partly configured provider stops synthesis and names what is unset", () => {
  assert.throws(() => resolve({ GOOGLE_CLIENT_ID: "google-client" }), /Google sign-in is partly configured: .*Unset: GOOGLE_CLIENT_SECRET\./);
  assert.throws(() => resolve({ META_APP_SECRET: "fixture" }), /Meta sign-in is partly configured: .*Unset: META_APP_ID\./);
  assert.throws(
    () => resolve({ MICROSOFT_CLIENT_ID: "microsoft-client", MICROSOFT_CLIENT_SECRET: "fixture" }),
    /Microsoft sign-in is partly configured: set MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_SECRET .*Unset: MICROSOFT_TENANT_ID\./,
  );
  assert.throws(() => resolve({ GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "   " }), /Unset: GOOGLE_CLIENT_SECRET/, "a blank secret line is unset");
});

test("Microsoft trusts one Entra tenant: the multi-tenant endpoints are refused", () => {
  for (const tenantId of ["common", "organizations", "consumers", "contoso.onmicrosoft.com"]) {
    assert.throws(
      () => resolve({ MICROSOFT_CLIENT_ID: "microsoft-client", MICROSOFT_TENANT_ID: tenantId, MICROSOFT_CLIENT_SECRET: "fixture" }),
      /MICROSOFT_TENANT_ID must be your Entra directory \(tenant\) ID, a GUID/,
    );
  }
});

test("every provider's lines are catalog entries, and Google's secret keeps its managed binding", () => {
  for (const id of Object.keys(SIGN_IN_PROVIDERS) as (keyof typeof SIGN_IN_PROVIDERS)[]) {
    const keys = signInProviderKeys(id);
    for (const key of keys) assert.ok(resources.signInProviders[key].fromEnv, `${id}: ${key} is read from the inputs file`);
    assert.equal(resources.signInProviders[keys.at(-1)!].kind, "secret", `${id}: its client secret is a declared secret`);
  }
  assert.deepEqual(resources.signInProviders.googleClientSecret.bindingPath, ["googleClientSecret"]);
});

// ---------------------------------------------------------------------------
// The Cognito stack builds exactly the configured providers
// ---------------------------------------------------------------------------

const secrets = {
  google: SecretValue.unsafePlainText("fixture-google-never-deployed"),
  microsoft: SecretValue.unsafePlainText("fixture-microsoft-never-deployed"),
  meta: SecretValue.unsafePlainText("fixture-meta-never-deployed"),
};

function synthesize(signInProviders: SignInProviderSettings) {
  const app = new App();
  const events = new Stack(app, "Events", { env });
  for (const id of ["cognito-pre-signup-trigger", "cognito-custom-message", "cognito-post-confirmation-trigger", "cognito-pre-token-generation"]) {
    appEventRegistry(events).lambda(id, new Function(events, id, { runtime: Runtime.NODEJS_24_X, handler: "index.handler", code: Code.fromInline("exports.handler=async(event)=>event") }));
  }
  const stack = new CognitoStack(app, "SignInCognito", { env, signInProviders, signInProviderSecrets: secrets });
  return Template.fromStack(stack);
}

test("each configured provider is built under its Cognito name and offered by the app client", () => {
  const template = synthesize({
    google: { clientId: "google-client" },
    microsoft: { clientId: "microsoft-client", tenantId: tenant },
    meta: { appId: "meta-app" },
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
    ProviderName: "Google", ProviderType: "Google",
    AttributeMapping: Match.objectLike({ email_verified: "email_verified" }),
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
    ProviderName: "MicrosoftEntraID", ProviderType: "OIDC",
    ProviderDetails: Match.objectLike({ client_id: "microsoft-client", oidc_issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, authorize_scopes: "openid email profile" }),
    AttributeMapping: { email: "email", given_name: "given_name", family_name: "family_name", email_verified: "xms_edov" },
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
    ProviderName: "Facebook", ProviderType: "Facebook",
    ProviderDetails: Match.objectLike({ client_id: "meta-app", authorize_scopes: "public_profile,email" }),
    AttributeMapping: { email: "email", given_name: "first_name", family_name: "last_name" },
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    SupportedIdentityProviders: ["COGNITO", "Google", { Ref: Match.stringLikeRegexp("^MicrosoftEntraID") }, "Facebook"],
  });
  assert.equal(template.toJSON().Outputs.SignInProviders.Value, "google,microsoft,meta");
});

test("a deployment without providers offers Cognito alone and publishes none", () => {
  const template = synthesize({});
  template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  template.hasResourceProperties("AWS::Cognito::UserPool", { LambdaConfig: Match.objectLike({ PreTokenGeneration: Match.anyValue() }) });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", { SupportedIdentityProviders: ["COGNITO"] });
  assert.equal(template.toJSON().Outputs.SignInProviders.Value, "none");
  assert.equal(synthesize({ meta: { appId: "meta-app" } }).toJSON().Outputs.SignInProviders.Value, "meta");
});

// ---------------------------------------------------------------------------
// The token trigger marks only Facebook users' email verified
// ---------------------------------------------------------------------------

const tokenEvent = (userAttributes: Record<string, string>) => ({
  triggerSource: "TokenGeneration_HostedAuth",
  userName: "facebook_1234567890",
  request: { userAttributes, groupConfiguration: {} },
  response: { claimsOverrideDetails: null },
}) as unknown as PreTokenGenerationTriggerEvent;
const identities = (...providers: string[]) => JSON.stringify(providers.map((providerType) => ({ providerName: providerType, providerType, userId: "1234567890", primary: true })));

test("a Facebook user's ID token states a verified email", async () => {
  const event = await lambdaHandler(tokenEvent({ "cognito:user_status": "EXTERNAL_PROVIDER", email: "person@example.com", identities: identities("Facebook") }));
  assert.deepEqual(event.response.claimsOverrideDetails, { claimsToAddOrOverride: { email_verified: "true" } });
});

test("every other token is left as Cognito issued it", async () => {
  for (const attributes of <Record<string, string>[]>[
    { "cognito:user_status": "EXTERNAL_PROVIDER", email: "person@example.com", identities: identities("Google") },
    { "cognito:user_status": "EXTERNAL_PROVIDER", email: "person@example.com", identities: identities("OIDC") },
    // A native account someone linked a Facebook identity to keeps its own answer.
    { "cognito:user_status": "CONFIRMED", email: "person@example.com", identities: identities("Facebook") },
    { "cognito:user_status": "EXTERNAL_PROVIDER", identities: identities("Facebook") },
    { "cognito:user_status": "EXTERNAL_PROVIDER", email: "person@example.com", identities: identities("Facebook", "Google") },
    { "cognito:user_status": "EXTERNAL_PROVIDER", email: "person@example.com", identities: "not json" },
    { "cognito:user_status": "CONFIRMED", email: "person@example.com" },
  ]) {
    const event = await lambdaHandler(tokenEvent(attributes));
    assert.equal(event.response.claimsOverrideDetails, null, JSON.stringify(attributes));
  }
});
