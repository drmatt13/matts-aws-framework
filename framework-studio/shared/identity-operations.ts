import type { IdentitySelection } from "./identity";
import type { Mode } from "./model";

export type CognitoAction = "create-user" | "create-group" | "add-to-group" | "remove-from-group" | "enable-user" | "disable-user";
export type CognitoOperation =
  | { readonly action: "create-user"; readonly username: string; readonly email: string; readonly givenName: string; readonly familyName: string }
  | { readonly action: "create-group"; readonly group: string; readonly description: string }
  | { readonly action: "add-to-group" | "remove-from-group"; readonly username: string; readonly group: string }
  | { readonly action: "enable-user" | "disable-user"; readonly username: string };

/** Re-resolved through owned CloudFormation identities, never a browser pool ID. */
export interface VerifiedCognitoTarget extends IdentitySelection {
  readonly mode: Mode;
  readonly account: string;
  readonly actorArn?: string;
  readonly poolId: string;
  readonly poolArn: string;
  readonly fingerprint: string;
  readonly requiredAttributes: readonly string[];
  readonly passwordless: boolean;
  readonly triggers: readonly string[];
}
export interface CognitoOperationReview {
  readonly id: string;
  readonly subjectDigest: string;
  readonly target: VerifiedCognitoTarget;
  readonly operation: CognitoOperation;
  readonly confirmation: string;
  readonly productionConfirmation?: string;
  readonly expiresAt: string;
  readonly noEffect: boolean;
  readonly before: { readonly user?: { readonly username: string; readonly enabled: boolean; readonly status?: string }; readonly group?: { readonly name: string; readonly roleArn?: string; readonly precedence?: number }; readonly member?: boolean };
  readonly effects: readonly string[];
}
export interface CognitoOperationRecord {
  readonly id: string;
  readonly reviewId: string;
  readonly action: CognitoAction;
  readonly profile: string;
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  readonly mode: Mode;
  readonly poolId: string;
  readonly startedAt: string;
  readonly actorArn?: string;
  /** Hash of exact user/group identifiers; excludes attributes and credentials. */
  readonly subjectDigest: string;
  readonly updatedAt: string;
  readonly status: "running" | "applied" | "unchanged" | "rejected" | "unconfirmed";
  readonly verification: "observed" | "unverified";
  readonly message: string;
  readonly code?: string;
}
export interface CognitoOperationResult extends CognitoOperationRecord {
  readonly refreshRequired: true;
}
