import { resource } from "@repo/framework/config";

/**
 * Sign-in providers the framework federates into the application's Cognito user pool. The catalog
 * key `signInProviders` is the framework's: the Cognito stack builds each provider whose settings an
 * environment's inputs file supplies, and AWS Studio shows the group as framework managed.
 *
 * Client IDs are ordinary inputs; each client secret is a `resource.secret`, so
 * `npm run deploy:resources` uploads it to Secrets Manager and templates carry only a
 * resolve reference. Author values only in cdk-app/.env.<mode>. A provider is off while all of its
 * lines are unset there, included once all are set, and a partly configured one stops synthesis.
 */
export const signInProviders = {
  googleClientId: resource.fromEnv("GOOGLE_CLIENT_ID", { tags: { area: "auth" } }),
  // Formerly `resources.googleClientSecret`: its managed secret keeps that binding.
  googleClientSecret: resource.secret("GOOGLE_CLIENT_SECRET", { tags: { area: "auth" }, bindingPath: ["googleClientSecret"] }),
  microsoftClientId: resource.fromEnv("MICROSOFT_CLIENT_ID", { tags: { area: "auth" } }),
  microsoftTenantId: resource.fromEnv("MICROSOFT_TENANT_ID", { tags: { area: "auth" } }),
  microsoftClientSecret: resource.secret("MICROSOFT_CLIENT_SECRET", { tags: { area: "auth" } }),
  metaAppId: resource.fromEnv("META_APP_ID", { tags: { area: "auth" } }),
  metaAppSecret: resource.secret("META_APP_SECRET", { tags: { area: "auth" } }),
};

export type SignInProviderId = "google" | "microsoft" | "meta";
type Key = keyof typeof signInProviders;

/**
 * Each provider's entries in `signInProviders` and the name its Cognito identity provider takes.
 * The client app's sign-in buttons follow the deployed list, never this table directly.
 */
export const SIGN_IN_PROVIDERS = {
  google: { title: "Google", cognitoName: "Google", settings: { clientId: "googleClientId" }, secret: "googleClientSecret" },
  microsoft: { title: "Microsoft", cognitoName: "MicrosoftEntraID", settings: { clientId: "microsoftClientId", tenantId: "microsoftTenantId" }, secret: "microsoftClientSecret" },
  meta: { title: "Meta", cognitoName: "Facebook", settings: { appId: "metaAppId" }, secret: "metaAppSecret" },
} as const satisfies Readonly<Record<SignInProviderId, {
  readonly title: string;
  /** The Cognito identity provider name; the hosted UI's `identity_provider` parameter. */
  readonly cognitoName: string;
  /** Non-secret settings: field name to catalog key. */
  readonly settings: Readonly<Record<string, Key>>;
  readonly secret: Key;
}>>;

/** A provider's non-secret settings, resolved: what the Cognito stack builds it from. */
export type SignInProviderSettings = {
  readonly [Id in SignInProviderId]?: { readonly [Field in keyof (typeof SIGN_IN_PROVIDERS)[Id]["settings"]]: string };
};

/** Every catalog key a provider reads, its secret last. */
export const signInProviderKeys = (id: SignInProviderId): readonly Key[] =>
  [...Object.values(SIGN_IN_PROVIDERS[id].settings), SIGN_IN_PROVIDERS[id].secret];
