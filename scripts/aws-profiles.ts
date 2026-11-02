import os from "node:os";
import type { AwsProfileKind } from "./aws-connection-contract";
import { inspectAwsProfiles, resolveAwsRegion } from "./aws-connections";

/** Compatibility projection for repository scripts. Only safe discovery metadata leaves this API. */
export type ProfileKind = AwsProfileKind;
export interface AwsProfile { readonly name: string; readonly region?: string; readonly kind: ProfileKind }
export function listAwsProfiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AwsProfile[] {
  return inspectAwsProfiles(env, home).profiles.map(({ name, kind, region }) => ({ name, kind, ...(region ? { region } : {}) }));
}
/** Region is explicit, then environment, then the selected profile; no implicit default region. */
export function profileRegion(profile: string | undefined, explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveAwsRegion(profile ?? env.AWS_PROFILE ?? "default", explicit, env).value;
}
