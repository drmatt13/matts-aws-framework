import { call } from "./http";

import type {
  AwsAuthenticationSession,
  AwsAuthenticationRequest,
  AwsProfileReview,
  AwsLogoutReview,
  AwsProfileChangeRequest,
  AwsProfileDeletionReview,
} from "../shared/aws-connection-management";
export type AuthenticationSession = AwsAuthenticationSession;
export type ProfileReview = AwsProfileReview;
export type ProfileDeletionReview = AwsProfileDeletionReview;
export type LogoutReview = AwsLogoutReview;
export type AuthenticationRequest = AwsAuthenticationRequest;
export const awsConnectionsApi = {
  authenticate: (request: AuthenticationRequest) =>
    call<AuthenticationSession>("/aws-connections/authentication", request),
  authentication: (id: string, signal?: AbortSignal) =>
    call<AuthenticationSession>(
      `/aws-connections/authentication/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  cancel: (id: string) =>
    call<AuthenticationSession>(
      `/aws-connections/authentication/${encodeURIComponent(id)}/cancel`,
      {},
    ),
  confirm: (id: string, accepted: boolean) =>
    call<AuthenticationSession>(
      `/aws-connections/authentication/${encodeURIComponent(id)}/confirm`,
      { accepted },
    ),
  accounts: (id: string, signal?: AbortSignal) =>
    call<{ accounts: readonly { accountId: string; accountName?: string }[] }>(
      `/aws-connections/authentication/${encodeURIComponent(id)}/accounts`,
      undefined,
      signal,
    ),
  roles: (id: string, account: string) =>
    call<{ roles: readonly { roleName: string }[] }>(
      `/aws-connections/authentication/${encodeURIComponent(id)}/roles`,
      { account },
    ),
  review: (request: AwsProfileChangeRequest) =>
    call<ProfileReview>("/aws-connections/review", request),
  apply: (reviewId: string) =>
    call<{ name: string; changed: boolean; message?: string }>("/aws-connections/apply", {
      reviewId,
    }),
  discard: (reviewId: string) =>
    call<{ discarded: boolean }>("/aws-connections/discard", { reviewId }),
  logoutReview: (profile: string) =>
    call<LogoutReview>("/aws-connections/logout/review", { profile }),
  logout: (reviewId: string) =>
    call<{ message: string }>("/aws-connections/logout/apply", { reviewId }),
  deleteReview: (profile: string) =>
    call<ProfileDeletionReview>("/aws-connections/delete/review", { profile }),
  deleteProfile: (reviewId: string) =>
    call<{ name: string; changed: true }>("/aws-connections/delete/apply", {
      reviewId,
    }),
};

export function authenticationFinished(session: AuthenticationSession) {
  return ["complete", "failed", "canceled"].includes(session.state);
}
