/** Browser-safe AWS connection metadata. Credential material never belongs in these types. */
/** Existing names are opaque identifiers. Pass them as an argv value, never through a shell. */
export function isAwsProfileName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f-\x9f\[\]]/.test(value);
}
export type AwsProfileKind = "sso" | "login" | "process" | "assume-role" | "static" | "unknown";
export type AwsCredentialMechanism = AwsProfileKind | "web-identity" | "environment" | "instance-metadata" | "container-metadata";
export type AwsConnectionProblemCode = "missing-cli" | "unsupported-cli" | "profile" | "configuration" | "missing-region" | "no-credentials" | "expired" | "mfa-required" | "assume-role" | "external-provider" | "denied" | "network" | "throttled" | "canceled" | "timeout" | "failed";
export interface AwsConnectionProblem {
  readonly code: AwsConnectionProblemCode;
  readonly message: string;
  readonly action: "install-cli" | "update-cli" | "configure" | "connect" | "terminal" | "retry" | "permissions" | "none";
  readonly retryable: boolean;
}
export interface AwsConfigurationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "warning" | "error";
}
export type AwsRegionSource = "explicit" | "environment" | "profile" | "missing";
export interface AwsRegionResolution { readonly value?: string; readonly source: AwsRegionSource }
export const AWS_PROFILE_FIELDS = ["region", "role_arn", "source_profile", "credential_source", "sso_session", "sso_start_url", "sso_region", "sso_account_id", "sso_role_name", "role_session_name", "duration_seconds", "mfa_serial", "login_session"] as const;
export type AwsProfileField = typeof AWS_PROFILE_FIELDS[number];
export type AwsProfileConfiguration = Readonly<Partial<Record<AwsProfileField, string>>>;
export interface AwsProfileDescriptor {
  readonly name: string;
  readonly kind: AwsProfileKind;
  readonly mechanisms: readonly AwsCredentialMechanism[];
  readonly region?: string;
  readonly sourceProfile?: string;
  readonly roleArn?: string;
  readonly ssoSession?: string;
  readonly loginSession?: string;
  readonly credentialSource?: string;
  readonly hasMfa: boolean;
  readonly editable: boolean;
  readonly configuration: AwsProfileConfiguration;
  readonly provenance: { readonly config: boolean; readonly credentials: boolean; readonly readOnlyReason?: string };
  readonly diagnostics: readonly AwsConfigurationDiagnostic[];
}
export interface AwsSsoSessionDescriptor {
  readonly name: string;
  readonly startUrl?: string;
  readonly region?: string;
  readonly profiles: readonly string[];
}
export interface AwsProfileCatalog {
  readonly revision: string;
  readonly profiles: readonly AwsProfileDescriptor[];
  readonly sessions: readonly AwsSsoSessionDescriptor[];
  readonly diagnostics: readonly AwsConfigurationDiagnostic[];
  readonly environment: { readonly credentialsPresent: boolean; readonly endpointOverridesPresent: boolean };
}
export interface AwsResolvedIdentity {
  readonly account: string;
  readonly arn: string;
  readonly principalKind: "assumed-role" | "user" | "root" | "federated" | "unknown";
  readonly summary: string;
}
export interface AwsConnectionObservation {
  readonly profile: string;
  readonly revision: string;
  readonly state: "unchecked" | "checking" | "connected" | "needs-auth" | "configuration-error" | "unavailable";
  readonly checkedAt?: string;
  readonly identity?: AwsResolvedIdentity;
  readonly lastKnownIdentity?: AwsResolvedIdentity;
  readonly region: AwsRegionResolution;
  readonly credentialExpiration?: { readonly at: string; readonly source: "native-export" };
  readonly problem?: AwsConnectionProblem;
}
