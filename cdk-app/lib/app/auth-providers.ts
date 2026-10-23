import { SecretValue } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { ResourceReference } from "@repo/framework/config";
import { resolveDeploymentSecret } from "../framework/framework-resources";

interface CommonProvider {
  readonly id: string;
  readonly name: string;
  readonly scope: "both" | "dev" | "prod";
  readonly attributes: { readonly email: string; readonly givenName: string; readonly familyName: string; readonly emailVerified: string };
}
export type AdditionalAuthProvider = CommonProvider & ({ readonly type: "oidc"; readonly issuer: string; readonly clientId: string; readonly clientSecret: ResourceReference<"secret">; readonly scopes: readonly string[] } | { readonly type: "saml"; readonly metadataUrl: string });

type AdditionalProviderOptions = { readonly id: string; readonly type: "oidc"; readonly options: Omit<cognito.UserPoolIdentityProviderOidcProps, "userPool"> } | { readonly id: string; readonly type: "saml"; readonly options: Omit<cognito.UserPoolIdentityProviderSamlProps, "userPool"> };
/** Prepare provider settings without taking or mutating the application's user pool. */
export function additionalAuthProviderOptions(scope: Construct, providers: readonly AdditionalAuthProvider[]): readonly AdditionalProviderOptions[] {
  const names = new Set(["Google", "COGNITO"]);
  return providers.map(provider => {
    if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || !/^[A-Za-z][A-Za-z0-9_-]{2,31}$/.test(provider.name) || names.has(provider.name)) throw new Error("Authentication provider identifiers and names must be unique, safe literal values; Google and COGNITO are reserved.");
    names.add(provider.name);
    for (const attribute of Object.values(provider.attributes)) if (!attribute.trim() || /[\x00-\x1f\x7f]/.test(attribute)) throw new Error(`Provider ${provider.name} requires explicit email, name and verified-email claim mappings.`);
    const url = new URL(provider.type === "oidc" ? provider.issuer : provider.metadataUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && !["80", "443"].includes(url.port)) || (provider.type === "oidc" && url.search)) throw new Error(`Provider ${provider.name} requires an HTTPS issuer/metadata URL without credentials or fragments.`);
    const attributeMapping = Object.fromEntries(Object.entries(provider.attributes).map(([key, value]) => [key, cognito.ProviderAttribute.other(value)]));
    if (provider.type === "oidc") {
      if (!provider.scopes.includes("openid") || !provider.clientId.trim()) throw new Error(`OIDC provider ${provider.name} requires a client ID and openid scope.`);
      const handle = resolveDeploymentSecret(scope, provider.clientSecret, true)!;
      return { id: `AdditionalProvider-${provider.id}`, type: "oidc" as const, options: { name: provider.name, issuerUrl: provider.issuer, clientId: provider.clientId, clientSecret: SecretValue.secretsManager(handle.secretArn).unsafeUnwrap(), scopes: [...provider.scopes], attributeMapping, attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET } };
    }
    return { id: `AdditionalProvider-${provider.id}`, type: "saml" as const, options: { name: provider.name, metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(provider.metadataUrl), attributeMapping, idpInitiated: false, idpSignout: false } };
  });
}
/** Convenience for native source that does not expose individually editable pool hooks. */
export function additionalAuthProviders(scope: Construct, userPool: cognito.UserPool, providers: readonly AdditionalAuthProvider[]) {
  return additionalAuthProviderOptions(scope, providers).map(provider => provider.type === "oidc"
    ? new cognito.UserPoolIdentityProviderOidc(scope, provider.id, { userPool, ...provider.options })
    : new cognito.UserPoolIdentityProviderSaml(scope, provider.id, { userPool, ...provider.options }));
}
