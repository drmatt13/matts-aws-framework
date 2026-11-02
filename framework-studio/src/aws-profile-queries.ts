import { queryOptions } from "@tanstack/react-query";
import type { AccountContext, AwsProfileInfo } from "../shared/deploy";
import type { Observation } from "./deploy/api";
import { call } from "./http";

export const awsProfilesQuery = () => queryOptions({
  queryKey: ["aws-profiles"],
  queryFn: ({ signal }) => call<readonly AwsProfileInfo[]>("/deploy/profiles", undefined, signal),
  staleTime: 0,
  retry: false,
});

export const awsProfileIdentityQuery = (profile: string | undefined) => queryOptions({
  queryKey: ["aws-profile-identity", profile],
  queryFn: ({ signal }) => call<Observation<{ context: AccountContext }>>(`/deploy/identity?profile=${encodeURIComponent(profile!)}&force=1`, undefined, signal),
  staleTime: 0,
  retry: false,
});
