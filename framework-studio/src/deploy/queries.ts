import { queryOptions } from "@tanstack/react-query";
import { deployApi } from "./api";

/** Shared identity and reads; each observer retains its own polling/staleness policy. */
export const deploymentOverviewQuery = (force = false) => queryOptions({
  queryKey: ["deploy", "overview"],
  queryFn: () => deployApi.overview(force),
});
export const deploymentDiscoveryQuery = (profile: string | undefined, force = false) => queryOptions({
  queryKey: ["deploy", "discover", profile],
  queryFn: () => deployApi.discover(profile!, force),
});
export const deploymentStatusQuery = (profile: string | undefined, deployment: string | undefined, region?: string, force = false) => queryOptions({
  queryKey: ["deploy", "status", profile, deployment, region],
  queryFn: () => deployApi.status(profile!, deployment!, force, region),
});
export const deploymentPlansQuery = () => queryOptions({
  queryKey: ["deploy", "plans"],
  queryFn: () => deployApi.plans(),
});
