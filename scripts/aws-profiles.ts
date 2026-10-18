import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The AWS profiles on this machine, read from ~/.aws/config and
 * ~/.aws/credentials (or AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE).
 *
 * Only names, each profile's region and the kind of credentials it uses leave
 * this function. Values — keys, tokens, role ARNs, start URLs — are never
 * returned, and a profile name never implies a deployment mode.
 */

export type ProfileKind = "sso" | "login" | "process" | "assume-role" | "static" | "unknown";

export interface AwsProfile {
  readonly name: string;
  readonly region?: string;
  readonly kind: ProfileKind;
}

function sections(text: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      result.set(header[1]!.trim(), current);
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current.set(pair[1]!.toLowerCase(), pair[2]!.trim());
  }
  return result;
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

export function listAwsProfiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AwsProfile[] {
  const config = sections(read(env.AWS_CONFIG_FILE ?? path.join(home, ".aws", "config")));
  const credentials = sections(read(env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(home, ".aws", "credentials")));
  const profiles = new Map<string, { config?: Map<string, string>; credentials?: Map<string, string> }>();
  for (const [header, values] of config) {
    if (header.startsWith("sso-session ") || header.startsWith("services ")) continue;
    const name = header === "default" ? "default" : header.startsWith("profile ") ? header.slice("profile ".length).trim() : undefined;
    if (name) profiles.set(name, { ...profiles.get(name), config: values });
  }
  for (const [name, values] of credentials) profiles.set(name, { ...profiles.get(name), credentials: values });
  return [...profiles].map(([name, { config: settings, credentials: secrets }]) => {
    const has = (key: string) => settings?.has(key) || secrets?.has(key);
    const kind: ProfileKind = has("sso_session") || has("sso_start_url") ? "sso"
      : has("login_session") ? "login"
      : has("credential_process") ? "process"
      : has("role_arn") ? "assume-role"
      : has("aws_access_key_id") ? "static"
      : "unknown";
    const region = settings?.get("region") || secrets?.get("region");
    return { name, kind, ...(region ? { region } : {}) };
  }).sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)));
}

/** The region a command for this profile uses: explicit, the profile's, then the environment's. */
export function profileRegion(profile: string | undefined, explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicit) return explicit;
  const configured = listAwsProfiles(env).find((entry) => entry.name === (profile ?? env.AWS_PROFILE ?? "default"))?.region;
  return configured ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
}
