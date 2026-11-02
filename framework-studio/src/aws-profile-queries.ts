import { queryOptions } from "@tanstack/react-query";
import type { AwsConnectionObservation, AwsProfileCatalog } from "../shared/aws-connections";
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
  unchecked: "Not checked",
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
