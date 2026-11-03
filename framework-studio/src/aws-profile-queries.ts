import { queryOptions } from "@tanstack/react-query";
import type {
  AwsConnectionObservation,
  AwsProfileCatalog,
  AwsProfileDescriptor,
  AwsProfileKind,
} from "../shared/aws-connections";
import { call } from "./http";

export const AWS_PROFILE_CONFIGURATION_EVENT = "studio:aws-profile-configuration";
export function openAwsProfileConfiguration() {
  window.dispatchEvent(new window.Event(AWS_PROFILE_CONFIGURATION_EVENT));
}

export const awsProfileCatalogQuery = () =>
  queryOptions({
    queryKey: ["aws-connections", "catalog"],
    queryFn: ({ signal }) => call<AwsProfileCatalog>("/aws-connections", undefined, signal),
    staleTime: 30_000,
    retry: false,
  });
export const awsProfilesQuery = () => ({
  ...awsProfileCatalogQuery(),
  select: (catalog: AwsProfileCatalog) => catalog.profiles,
});

export const awsProfileIdentityQuery = (profile: string | undefined) =>
  queryOptions({
    queryKey: ["aws-connections", "identity", profile],
    queryFn: ({ signal }) =>
      call<AwsConnectionObservation>("/aws-connections/check", { profile }, signal),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
export const checkAwsProfile = (profile: string, signal?: AbortSignal) =>
  call<AwsConnectionObservation>("/aws-connections/check", { profile, force: true }, signal);
export const connectionStateLabels: Record<AwsConnectionObservation["state"], string> = {
  unchecked: "Unverified",
  checking: "Checking",
  connected: "Identity verified",
  "needs-auth": "Sign-in required",
  "configuration-error": "Configuration issue",
  unavailable: "Connection unavailable",
};
export const profileMethodLabels: Record<string, string> = {
  login: "AWS Console",
  sso: "IAM Identity Center",
  "assume-role": "IAM role",
  static: "Access keys",
  process: "External provider",
  unknown: "Custom configuration",
};

/**
 * A profile may configure more than one credential method; the AWS CLI's precedence picks one.
 * A Console or Identity Center session whose account differs from the identity the profile
 * resolved to is not the one in use, so the profile is described by the method that is.
 */
export function effectiveProfileKind(
  profile: AwsProfileDescriptor,
  observation: AwsConnectionObservation | undefined,
): AwsProfileKind {
  const identity = observation?.identity ?? observation?.lastKnownIdentity;
  const sessionAccount =
    profile.kind === "login"
      ? profile.loginSession?.split(":")[4]
      : profile.kind === "sso"
        ? profile.configuration.sso_account_id
        : undefined;
  if (!identity || !sessionAccount || sessionAccount === identity.account) return profile.kind;
  return (
    profile.mechanisms.find(
      (item): item is "sso" | "login" | "process" | "static" =>
        item !== profile.kind && ["sso", "login", "process", "static"].includes(item),
    ) ?? profile.kind
  );
}
