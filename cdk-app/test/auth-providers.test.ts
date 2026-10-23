import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool, UserPoolClientIdentityProvider, UserPoolIdentityProviderOidc, UserPoolIdentityProviderSaml } from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineResources, resource } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { additionalAuthProviderOptions, additionalAuthProviders } from "../lib/app/auth-providers";
import { initializeFrameworkResources, finalizeFrameworkResources } from "../lib/framework/framework-resources";

const attributes = { email: "email", givenName: "given_name", familyName: "family_name", emailVerified: "email_verified" };
test("OIDC and SAML source create native providers and app-client registrations; OIDC uses managed secret ARN parameter", () => {
  const app = new App(); const stack = new Stack(app, "Auth", { env: { account: "111122223333", region: "us-east-1" } }); const pool = new UserPool(stack, "Pool");
  const resources = defineResources({ enterpriseSecret: resource.secret("ENTERPRISE_CLIENT_SECRET") });
  const config = defineFrameworkConfig({ resources, defaults, http: [], events: [], webSocket: [], tasks: [], services: [], workflows: [] });
  initializeFrameworkResources(app, { config, mode: "dev", deployment: "campaign-auth" });
  const providers = additionalAuthProviders(stack, pool, [
    { id: "enterprise-oidc", name: "EnterpriseOIDC", scope: "dev", type: "oidc", attributes, issuer: "https://idp.example.com", clientId: "fake-public-client", clientSecret: resources.enterpriseSecret, scopes: ["openid", "email", "profile"] },
    { id: "enterprise-saml", name: "EnterpriseSAML", scope: "dev", type: "saml", attributes, metadataUrl: "https://idp.example.com/metadata" },
  ]);
  const client = pool.addClient("Client", { supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO, ...providers.map(provider => UserPoolClientIdentityProvider.custom(provider.providerName))] });
  providers.forEach(provider => client.node.addDependency(provider));
  finalizeFrameworkResources(app);
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", { ProviderName: "EnterpriseOIDC", ProviderType: "OIDC", ProviderDetails: Match.objectLike({ client_id: "fake-public-client", oidc_issuer: "https://idp.example.com", authorize_scopes: "openid email profile", client_secret: Match.anyValue() }), AttributeMapping: { email: "email", given_name: "given_name", family_name: "family_name", email_verified: "email_verified" } });
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", { ProviderName: "EnterpriseSAML", ProviderType: "SAML", ProviderDetails: Match.objectLike({ MetadataURL: "https://idp.example.com/metadata" }) });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", { SupportedIdentityProviders: ["COGNITO", { Ref: Match.anyValue() }, { Ref: Match.anyValue() }] });
  assert.match(JSON.stringify(template.toJSON()), /resolve:secretsmanager:/);
  assert.ok(Object.values(template.toJSON().Parameters).some(parameter => (parameter as { AllowedPattern?: string }).AllowedPattern?.includes("secretsmanager")));
});
test("provider source rejects insecure issuer, missing openid and reserved provider name", () => {
  const app = new App(); const stack = new Stack(app, "Auth"); const pool = new UserPool(stack, "Pool");
  assert.throws(() => additionalAuthProviders(stack, pool, [{ id: "saml", name: "Google", scope: "dev", type: "saml", attributes, metadataUrl: "https://idp.example.com/metadata" }]), /reserved/);
  assert.throws(() => additionalAuthProviders(stack, pool, [{ id: "saml", name: "Enterprise", scope: "dev", type: "saml", attributes, metadataUrl: "http://idp.example.com/metadata" }]), /HTTPS/);
});

test("direct native provider construction preserves convenience-helper construct identities and template", () => {
  const render = (direct: boolean) => {
    const app = new App(); const stack = new Stack(app, "Auth", { env: { account: "111122223333", region: "us-east-1" } }); const pool = new UserPool(stack, "Pool");
    const resources = defineResources({ enterpriseSecret: resource.secret("ENTERPRISE_CLIENT_SECRET") });
    initializeFrameworkResources(app, { config: defineFrameworkConfig({ resources, defaults, http: [], events: [], webSocket: [], tasks: [], services: [], workflows: [] }), mode: "dev", deployment: "campaign-auth" });
    const declarations = [{ id: "enterprise-oidc", name: "EnterpriseOIDC", scope: "dev" as const, type: "oidc" as const, attributes, issuer: "https://idp.example.com", clientId: "fake-public-client", clientSecret: resources.enterpriseSecret, scopes: ["openid", "email"] }, { id: "enterprise-saml", name: "EnterpriseSAML", scope: "dev" as const, type: "saml" as const, attributes, metadataUrl: "https://idp.example.com/metadata" }];
    if (direct) additionalAuthProviderOptions(stack, declarations).map(provider => provider.type === "oidc" ? new UserPoolIdentityProviderOidc(stack, provider.id, { userPool: pool, ...provider.options }) : new UserPoolIdentityProviderSaml(stack, provider.id, { userPool: pool, ...provider.options }));
    else additionalAuthProviders(stack, pool, declarations);
    finalizeFrameworkResources(app); return Template.fromStack(stack).toJSON();
  };
  assert.deepEqual(render(true), render(false));
});
