import type { Mode } from "./model";

export interface IdentitySource {
  readonly mode: Mode;
  readonly file: string;
  readonly hash: string;
  readonly exists: boolean;
  /** Fixed public input allowlist. Secrets are represented by presence only. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly google: { readonly clientIdPresent: boolean; readonly authoredSecretPresent: boolean };
  readonly providers: readonly string[];
  readonly declaredProviders?: readonly { readonly id: string; readonly name: string; readonly type: string; readonly scope: string }[];
  readonly identityPools: "not-declared" | "source-review-required";
  readonly problems: readonly string[];
}
export interface IdentitySelection { readonly profile: string; readonly deployment: string; readonly region: string }
export interface IdentityContext extends IdentitySelection { readonly account: string; readonly observedAt: string }
export interface CognitoObservation {
  readonly context: IdentityContext;
  readonly poolId: string;
  readonly management?: "framework-managed" | "external-reference";
  readonly originalDeployment?: string;
  readonly selectedClientId?: string;
  readonly pool: { readonly name?: string; readonly status?: string; readonly deletionProtection?: string; readonly estimatedUsers?: number; readonly domain?: string; readonly customDomain?: string };
  readonly clients: readonly { readonly id: string; readonly name?: string; readonly callbacks: readonly string[]; readonly logout: readonly string[]; readonly providers: readonly string[] }[];
  readonly providers: readonly { readonly name: string; readonly type: string; readonly settings: Readonly<Record<string, string>>; readonly mappedAttributes: readonly string[]; readonly providerSide: "unverified"; readonly signIn: "unverified" }[];
  readonly groups: readonly { readonly name: string; readonly precedence?: number; readonly roleArn?: string }[];
  readonly users: readonly { readonly username: string; readonly status?: string; readonly enabled: boolean; readonly createdAt?: string }[];
  readonly nextToken?: string;
  readonly warnings: readonly string[];
}
export interface IdentityPoolsObservation {
  readonly context: IdentityContext;
  readonly pools: readonly { readonly id: string; readonly name: string; readonly guests: boolean; readonly providers: readonly { readonly name: string; readonly clientId: string }[]; readonly roles: Readonly<Record<string, string>>; readonly mappings: Readonly<Record<string, unknown>> }[];
  readonly warnings: readonly string[];
}
export interface DomainsObservation {
  readonly context: IdentityContext;
  readonly certificates: readonly { readonly purpose: string; readonly arn: string; readonly status?: string; readonly names: readonly string[]; readonly expires?: string; readonly problems: readonly string[]; readonly validation: readonly { readonly domain?: string; readonly status?: string; readonly name?: string; readonly type?: string; readonly value?: string }[] }[];
  readonly dns: readonly { readonly hostname: string; readonly addresses: readonly string[]; readonly problem?: string }[];
  readonly records: readonly { readonly hostname: string; readonly target?: string; readonly instruction: string }[];
  readonly health: readonly { readonly check: string; readonly status: "unverified"; readonly detail: string }[];
  readonly warnings: readonly string[];
}
