/** Safe browser contracts. Raw AWS files, provider commands and credentials never cross this boundary. */
export type AwsEditableFields = Partial<Record<"region" | "role_arn" | "source_profile" | "role_session_name" | "duration_seconds" | "mfa_serial" | "sso_session" | "sso_account_id" | "sso_role_name", string>>;
export interface AwsProfileChangeRequest {
  readonly name: string;
  readonly create: boolean;
  readonly fields: AwsEditableFields;
  readonly authenticationId?: string;
}
export interface AwsProfileReview {
  readonly id: string;
  readonly name: string;
  readonly create: boolean;
  readonly changes: readonly { readonly field: string; readonly before?: string; readonly after?: string }[];
  readonly affectedProfiles: readonly string[];
  readonly expiresAt: string;
}
export interface AwsProfileDeletionReview {
  readonly id: string;
  readonly name: string;
  readonly files: readonly ("config" | "credentials")[];
  readonly dependentProfiles: readonly string[];
  readonly blockers: readonly string[];
  readonly expiresAt: string;
}
export interface AwsAuthenticationRequest {
  readonly profile?: string;
  readonly method?: "login" | "sso";
  readonly name?: string;
  readonly region?: string;
  readonly session?: string;
  readonly startUrl?: string;
  readonly ssoRegion?: string;
}
export interface AwsAuthenticationSession {
  readonly id: string;
  readonly profile: string;
  readonly method: "login" | "sso";
  readonly state: "starting" | "waiting-browser" | "confirmation-required" | "verifying" | "complete" | "failed" | "canceled";
  readonly message: string;
  readonly affectedProfiles: readonly string[];
  readonly authorizationUrl?: string;
  readonly confirmation?: { readonly message: string; readonly previousArn: string; readonly nextArn: string };
  readonly reviewRequired?: boolean;
}
export interface AwsLogoutReview {
  readonly id: string;
  readonly profile: string;
  readonly method: "login" | "sso";
  readonly affectedProfiles: readonly string[];
  readonly message: string;
  readonly expiresAt: string;
}
export interface AwsCliCapabilities {
  readonly available: boolean;
  readonly version?: string;
  readonly credentialExport: boolean;
  readonly modernSso: boolean;
  readonly pkce: boolean;
  readonly consoleLogin: boolean;
}
