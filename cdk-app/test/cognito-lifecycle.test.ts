import assert from "node:assert/strict";
import { test } from "node:test";
import { App, SecretValue, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { UserPool, UserPoolOperation } from "aws-cdk-lib/aws-cognito";
import { CognitoStack } from "../lib/app/cognito-stack";
import { validateCognitoReference, type CognitoReference } from "../lib/app/cognito-lifecycle";
import { identityPoolAccess } from "../lib/app/identity-pool-access";
import { appEventRegistry } from "../lib/framework/framework-events";

const env = { account: "111122223333", region: "us-east-1" };
const reference: CognitoReference = {
  ...env,
  originalDeployment: "retained-fixture",
  userPoolId: "us-east-1_AbC123",
  userPoolClientId: "abc123existingclient",
  userPoolDomainUrl: "https://retained-fixture.auth.us-east-1.amazoncognito.com",
};

function managed(retain: boolean, lateTrigger = false) {
  const app = new App();
  const events = new Stack(app, "Events", { env });
  for (const id of ["cognito-pre-signup-trigger", "cognito-custom-message", "cognito-post-confirmation-trigger"]) {
    const fn = new Function(events, id, { runtime: Runtime.NODEJS_24_X, handler: "index.handler", code: Code.fromInline("exports.handler=async(event)=>event") });
    appEventRegistry(events).lambda(id, fn);
  }
  const stack = new CognitoStack(app, "FixtureCognito", {
    env, retainStatefulResources: retain,
    googleClientId: "fixture-google-client", googleClientSecret: SecretValue.unsafePlainText("fixture-placeholder-never-deployed"),
    additionalProviders: [{ id: "enterprise-saml", name: "EnterpriseSAML", scope: "dev", type: "saml", metadataUrl: "https://idp.example.com/metadata", attributes: { email: "email", givenName: "given_name", familyName: "family_name", emailVerified: "email_verified" } }],
  });
  if (lateTrigger) {
    const fn = new Function(events, "LatePreAuthentication", { runtime: Runtime.NODEJS_24_X, handler: "index.handler", code: Code.fromInline("exports.handler=async(event)=>event") });
    (stack.userPool as UserPool).addTrigger(UserPoolOperation.PRE_AUTHENTICATION, fn);
  }
  return { stack, template: Template.fromStack(stack).toJSON(), events: Template.fromStack(events).toJSON() };
}

test("pool retention preserves native client, domain, providers and invoke grants with stable logical IDs", () => {
  const deleted = managed(false), retained = managed(true);
  assert.deepEqual(Object.keys(retained.template.Resources), Object.keys(deleted.template.Resources));
  assert.deepEqual(retained.template.Outputs, deleted.template.Outputs, "Existing output names, values and exports do not change when retention changes.");
  for (const [id, resource] of Object.entries<any>(retained.template.Resources)) {
    if (["AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolDomain", "AWS::Cognito::UserPoolIdentityProvider", "AWS::Lambda::Permission"].includes(resource.Type)) {
      assert.equal(resource.DeletionPolicy, "Retain", `${id} survives stack removal`);
      assert.equal(resource.UpdateReplacePolicy, "Retain", `${id} survives replacement`);
      if (resource.Type === "AWS::Cognito::UserPool") {
        assert.equal(resource.Properties.DeletionProtection, "ACTIVE");
        assert.equal(deleted.template.Resources[id].Properties.DeletionProtection, "INACTIVE");
      } else {
        assert.deepEqual(resource.Properties, deleted.template.Resources[id].Properties, `${id} retains the same configuration`);
      }
    }
  }
  assert.ok(Object.values<any>(retained.template.Resources).some(resource => resource.Type === "AWS::Cognito::UserPoolIdentityProvider"));
  assert.equal(Object.values<any>(retained.template.Resources).filter(resource => resource.Type === "AWS::Lambda::Permission").length, 3);
  // Pool retention cannot preserve a function owned by a different stack. The
  // teardown dependency review must keep or refuse these external dependencies.
  for (const resource of Object.values<any>(retained.events.Resources)) if (resource.Type === "AWS::Lambda::Function") assert.notEqual(resource.DeletionPolicy, "Retain");
});

test("retention also preserves pool invoke permissions attached after native stack construction", () => {
  const { template } = managed(true, true);
  const grants = Object.values<any>(template.Resources).filter(resource => resource.Type === "AWS::Lambda::Permission");
  assert.equal(grants.length, 4);
  assert.ok(grants.every(resource => resource.DeletionPolicy === "Retain" && resource.UpdateReplacePolicy === "Retain"));
});

test("reference mode preserves explicit pool/client/domain identity and emits no Cognito mutations or provider secrets", () => {
  const app = new App();
  const stack = new CognitoStack(app, "RecoveredCognito", {
    env, reference,
    // Existing source settings must never result in external pool writes or
    // managed-secret lookups in reference mode.
    googleClientId: "existing-source-google-client",
    additionalProviders: [{ id: "invalid-provider-is-not-applied" } as never],
    frontendUrl: "https://app.example.com", trustedFrontendUrls: ["https://app.example.com"],
  });
  const template = Template.fromStack(stack).toJSON();
  assert.equal(stack.userPool.userPoolId, reference.userPoolId);
  assert.equal(stack.userPoolClient.userPoolClientId, reference.userPoolClientId);
  assert.equal(stack.userPoolDomainUrl, reference.userPoolDomainUrl);
  assert.deepEqual(Object.values<any>(template.Resources ?? {}).filter(resource => resource.Type.startsWith("AWS::Cognito::")), []);
  assert.ok(!Object.keys(template.Parameters ?? {}).some(key => key.startsWith("FrameworkResourceArn")), "Referenced providers never receive managed-secret ARN parameters.");
  assert.equal(Object.values<any>(template.Resources).filter(resource => resource.Type === "AWS::SSM::Parameter").length, 1, "The deployable shell owns only its nonsecret reference manifest.");
  assert.equal(template.Outputs.UserPoolId.Value, reference.userPoolId);
  assert.equal(template.Outputs.UserPoolClientId.Value, reference.userPoolClientId);
  assert.equal(template.Outputs.UserPoolDomainUrl.Value, reference.userPoolDomainUrl);
  assert.equal(template.Outputs.UserPoolDomainUrl.Export.Name, "RecoveredCognito:UserPoolDomainUrl");
  assert.equal(template.Outputs.OAuthProviderRedirectUri.Value, `${reference.userPoolDomainUrl}/oauth2/idpresponse`);
  assert.equal(template.Outputs.UserPoolManagement.Value, "external-reference");
  assert.equal(template.Outputs.UserPoolOriginalDeployment.Value, reference.originalDeployment);
});

test("reference mode preserves custom domain endpoint only when explicitly observed", () => {
  const stack = new CognitoStack(new App(), "CustomReference", { env, reference: { ...reference, userPoolDomainUrl: "https://auth.example.com", userPoolDomainCloudFrontEndpoint: "retained-fixture.cloudfront.net" } });
  assert.equal(Template.fromStack(stack).toJSON().Outputs.UserPoolDomainCloudFrontEndpoint.Value, "retained-fixture.cloudfront.net");
});

test("invalid reference target and identity inputs fail before creating replacement resources", () => {
  const cases: [Partial<CognitoReference>, RegExp][] = [
    [{ account: "999988887777" }, /account/],
    [{ region: "us-west-2" }, /region/],
    [{ userPoolId: "us-west-2_AbC123" }, /userPoolId/],
    [{ userPoolId: "us-east-1_" }, /userPoolId/],
    [{ userPoolClientId: "client/with-path" }, /userPoolClientId/],
    [{ originalDeployment: "" }, /originalDeployment/],
    [{ userPoolDomainUrl: "http://auth.example.com" }, /HTTPS/],
    [{ userPoolDomainUrl: "https://auth.example.com/path" }, /HTTPS/],
    [{ userPoolDomainUrl: "https://auth.example.com/" }, /HTTPS/],
    [{ userPoolDomainUrl: "https://user:password@auth.example.com" }, /HTTPS/],
    [{ userPoolDomainUrl: "https://127.0.0.1" }, /HTTPS/],
    [{ userPoolDomainCloudFrontEndpoint: "https://distribution.cloudfront.net" }, /CloudFront/],
  ];
  for (const [change, error] of cases) assert.throws(() => validateCognitoReference({ ...reference, ...change }, env), error);
  assert.throws(() => new CognitoStack(new App(), "UnknownAccount", { reference }), /account/, "A reference requires an explicit resolved deployment account and region.");
});

test("reference descriptors reject nonobjects, missing public fields and secret or unknown fields safely", () => {
  for (const value of [null, undefined, [], "pool-id", {}, { ...reference, userPoolId: undefined }, { ...reference, password: "private-sentinel" }, { ...reference, userPoolDomainCloudFrontEndpoint: 1 }]) {
    assert.throws(() => validateCognitoReference(value as CognitoReference, env), error => error instanceof Error && /public identity fields/.test(error.message) && !error.message.includes("private-sentinel"));
  }
});

test("Identity Pool helper refuses duplicate groups or new role mappings against externally referenced pool", () => {
  const app = new App(); const auth = new CognitoStack(app, "ReferencedAuth", { env, reference }); const access = new Stack(app, "Access", { env });
  assert.throws(() => identityPoolAccess(access, { userPool: auth.userPool, userPoolClient: auth.userPoolClient, groupName: "existing-reader" }), /externally referenced User Pool/);
  assert.equal(Object.keys(Template.fromStack(access).toJSON().Resources ?? {}).length, 0, "No identity pool, group, IAM role or permission was created before refusal.");
});
