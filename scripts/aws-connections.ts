import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSharedConfigFiles, loadSsoSessionData } from "@smithy/shared-ini-file-loader";
import type { AwsConfigurationDiagnostic, AwsConnectionProblem, AwsCredentialMechanism, AwsProfileCatalog, AwsProfileConfiguration, AwsProfileDescriptor, AwsProfileKind, AwsRegionResolution, AwsResolvedIdentity } from "./aws-connection-contract";
import { AWS_PROFILE_FIELDS, isAwsProfileName } from "./aws-connection-contract";
export { isAwsProfileName } from "./aws-connection-contract";

/** Host-only helpers. Raw documents, subprocess output and credentials must never enter HTTP DTOs. */
export interface AwsFileDocument {
  readonly path: string;
  readonly text: string;
  readonly exists: boolean;
  readonly stat?: Stats;
  readonly readOnlyReason?: string;
  readonly problem?: AwsConfigurationDiagnostic;
}
export interface AwsFiles { readonly config: AwsFileDocument; readonly credentials: AwsFileDocument; readonly revision: string }
export interface ParsedAwsDocument {
  readonly profiles: Map<string, Record<string, string>>;
  readonly sessions: Map<string, Record<string, string>>;
  readonly diagnostics: readonly AwsConfigurationDiagnostic[];
  readonly ambiguousProfiles: ReadonlySet<string>;
}
const diagnostic = (code: string, message: string, severity: "warning" | "error" = "error"): AwsConfigurationDiagnostic => ({ code, message, severity });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const expanded = (value: string | undefined, fallback: string, home: string) => path.resolve(value?.startsWith("~/") ? path.join(home, value.slice(2)) : value || fallback);

export function awsFilePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  return { config: expanded(env.AWS_CONFIG_FILE, path.join(home, ".aws", "config"), home), credentials: expanded(env.AWS_SHARED_CREDENTIALS_FILE, path.join(home, ".aws", "credentials"), home) };
}
function readDocument(file: string): AwsFileDocument {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) return { path: file, text: "", exists: true, stat, problem: diagnostic("not-file", "An AWS configuration path is not a regular file.") };
    if (stat.size > 2 * 1024 * 1024) return { path: file, text: "", exists: true, stat, problem: diagnostic("file-too-large", "An AWS configuration file exceeds the supported size.") };
    const text = readFileSync(file, "utf8");
    const readOnlyReason = stat.isSymbolicLink() || realpathSync(file) !== file ? "This file uses a symbolic link; edit it outside Studio."
      : stat.nlink > 1 ? "This file has multiple hard links; edit it outside Studio."
      : !(stat.mode & 0o200) || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ? "This file is owned by another user or is read-only." : undefined;
    return { path: file, text, exists: true, stat, ...(readOnlyReason ? { readOnlyReason } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, text: "", exists: false };
    return { path: file, text: "", exists: true, problem: diagnostic("unreadable-file", "An AWS configuration file could not be read. Check local file permissions.") };
  }
}
export function readAwsFiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AwsFiles {
  const locations = awsFilePaths(env, home);
  const config = readDocument(locations.config), credentials = readDocument(locations.credentials);
  const revision = digest(JSON.stringify([locations, config.text, credentials.text, config.exists, credentials.exists, config.stat?.ino, credentials.stat?.ino, config.problem?.code, credentials.problem?.code]));
  return { config, credentials, revision };
}

/** Structural scan for diagnostics/byte-preserving writers. AWS loaders remain the async read authority. */
export function parseAwsDocument(text: string, kind: "config" | "credentials"): ParsedAwsDocument {
  const profiles = new Map<string, Record<string, string>>(), sessions = new Map<string, Record<string, string>>();
  const diagnostics: AwsConfigurationDiagnostic[] = [], ambiguousProfiles = new Set<string>();
  const seenSections = new Set<string>();
  let values: Record<string, string> | undefined, profile: string | undefined, nested = false;
  if (text.includes("\0")) diagnostics.push(diagnostic("invalid-file", "An AWS configuration file contains invalid characters."));
  for (const original of text.split(/\r?\n/)) {
    const line = original.split(/(^|\s)[;#]/)[0]!.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      values = undefined; profile = undefined; nested = false;
      const match = /^\[([^\]]+)\]$/.exec(line);
      if (!match) { diagnostics.push(diagnostic("invalid-section", "An AWS configuration section is malformed.")); continue; }
      const header = match[1]!.trim();
      const duplicate = seenSections.has(header); seenSections.add(header);
      if (duplicate) diagnostics.push(diagnostic("duplicate-section", "An AWS configuration section is duplicated. Resolve it outside Studio."));
      const session = kind === "config" ? /^sso-session\s+["']?([^"']+)["']?$/.exec(header) : undefined;
      if (session) {
        const name = session[1]!.trim(); values = sessions.get(name) ?? Object.create(null); sessions.set(name, values!);
      } else {
        const named = kind === "config" ? /^profile\s+["']?([^"']+)["']?$/.exec(header) : undefined;
        profile = kind === "credentials" || header === "default" ? header : named?.[1]?.trim();
        if (profile === "__proto__" || profile === "constructor" || profile === "prototype") { diagnostics.push(diagnostic("invalid-profile", "An AWS profile uses an unsupported reserved name.")); profile = undefined; }
        if (profile) { values = profiles.get(profile) ?? Object.create(null); profiles.set(profile, values!); if (duplicate) ambiguousProfiles.add(profile); }
      }
      continue;
    }
    const setting = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!setting) { diagnostics.push(diagnostic("invalid-setting", "An AWS configuration setting is malformed.")); continue; }
    if (!values) continue;
    if (nested && /^\s/.test(original)) continue;
    nested = setting[2] === "";
    if (nested) continue;
    const key = setting[1]!;
    if (Object.hasOwn(values, key)) { diagnostics.push(diagnostic("duplicate-setting", "An AWS configuration setting is duplicated. Resolve it outside Studio.")); if (profile) ambiguousProfiles.add(profile); }
    values[key] = setting[2]!;
  }
  return { profiles, sessions, diagnostics, ambiguousProfiles };
}

function mechanisms(values: Record<string, string>): AwsCredentialMechanism[] {
  const result: AwsCredentialMechanism[] = [];
  if (values.role_arn && !values.web_identity_token_file) result.push("assume-role");
  if (values.web_identity_token_file) result.push("web-identity");
  if (values.sso_session || values.sso_start_url) result.push("sso");
  if (values.login_session) result.push("login");
  if (values.credential_process) result.push("process");
  if (values.aws_access_key_id || values.aws_secret_access_key) result.push("static");
  if (values.credential_source === "Environment") result.push("environment");
  if (values.credential_source === "Ec2InstanceMetadata") result.push("instance-metadata");
  if (values.credential_source === "EcsContainer") result.push("container-metadata");
  return result;
}
function profileKind(items: readonly AwsCredentialMechanism[]): AwsProfileKind {
  if (items.includes("assume-role")) return "assume-role";
  return items.find((item): item is Exclude<AwsProfileKind, "assume-role" | "unknown"> => ["sso", "login", "process", "static"].includes(item)) ?? "unknown";
}
/** Invalid public settings may contain pasted credential material; expose diagnostics, not their raw values. */
export function safeAwsProfileConfiguration(values: Record<string, string>): AwsProfileConfiguration {
  const result: Record<string, string> = {};
  for (const key of AWS_PROFILE_FIELDS) {
    const value = values[key];
    if (!value || value.length > 2048 || /[\x00-\x1f]/.test(value)) continue;
    let safe = false;
    if (["region", "sso_region"].includes(key)) safe = /^[a-z]{2,8}(?:-[a-z0-9]+){1,5}-\d{1,2}$/.test(value);
    else if (key === "role_arn") safe = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(value);
    else if (key === "login_session") safe = /^arn:aws(?:-[a-z]+)*:(?:iam|sts)::\d{12}:[A-Za-z0-9_+=,.@/:-]+$/.test(value);
    else if (key === "mfa_serial") safe = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:mfa\/[A-Za-z0-9_+=,.@/-]+$/.test(value) || /^[A-Z0-9]{5,32}$/.test(value);
    else if (key === "sso_account_id") safe = /^\d{12}$/.test(value);
    else if (key === "duration_seconds") safe = /^\d{3,5}$/.test(value) && Number(value) >= 900 && Number(value) <= 43200;
    else if (key === "credential_source") safe = ["Environment", "Ec2InstanceMetadata", "EcsContainer"].includes(value);
    else if (key === "sso_start_url") {
      try { const url = new URL(value); safe = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port && ["awsapps.com", "amazonaws.com", "amazonaws.com.cn"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); } catch { /* An invalid URL is not public metadata. */ }
    } else if (key === "source_profile" || key === "sso_session") safe = isAwsProfileName(value);
    else safe = /^[A-Za-z0-9_+=,.@+%:/ -]{1,128}$/.test(value);
    if (safe) result[key] = value;
  }
  return result;
}
export function configuredAwsProfiles(files: AwsFiles) {
  const config = parseAwsDocument(files.config.text, "config"), credentials = parseAwsDocument(files.credentials.text, "credentials");
  const merged = new Map<string, Record<string, string>>();
  for (const name of new Set([...config.profiles.keys(), ...credentials.profiles.keys()])) merged.set(name, { ...config.profiles.get(name), ...credentials.profiles.get(name) });
  return { config, credentials, merged };
}
function projectCatalog(files: AwsFiles, env: NodeJS.ProcessEnv, authoritative?: { configFile: Record<string, Record<string, string | undefined>>; credentialsFile: Record<string, Record<string, string | undefined>>; sessions: Record<string, Record<string, string | undefined>> }): AwsProfileCatalog {
  const parsed = configuredAwsProfiles(files);
  if (authoritative) {
    // The CLI permits quoted names the SDK loader does not recognize. Keep the
    // structural reader's metadata for those names; actual resolution stays CLI-owned.
    for (const name of parsed.merged.keys()) parsed.merged.set(name, Object.fromEntries(Object.entries({ ...(authoritative.configFile[name] ?? parsed.config.profiles.get(name)), ...(authoritative.credentialsFile[name] ?? parsed.credentials.profiles.get(name)) }).filter((item): item is [string, string] => typeof item[1] === "string")));
  }
  const diagnostics = [files.config.problem, files.credentials.problem, ...parsed.config.diagnostics, ...parsed.credentials.diagnostics].filter((item): item is AwsConfigurationDiagnostic => Boolean(item));
  const profiles: AwsProfileDescriptor[] = [];
  const hasRoute = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const values = parsed.merged.get(name);
    if (!values) return false;
    if (values.role_arn && !values.web_identity_token_file) return values.source_profile === name && values.aws_access_key_id && values.aws_secret_access_key ? true : values.source_profile ? hasRoute(values.source_profile, seen) : ["Environment", "Ec2InstanceMetadata", "EcsContainer"].includes(values.credential_source);
    if (values.web_identity_token_file) return Boolean(values.role_arn);
    if (values.sso_session || values.sso_start_url) {
      const session = values.sso_session ? authoritative?.sessions[values.sso_session] ?? parsed.config.sessions.get(values.sso_session) : values;
      return Boolean(values.sso_account_id && values.sso_role_name && session?.sso_start_url && session.sso_region);
    }
    return Boolean(values.login_session || values.credential_process || (values.aws_access_key_id && values.aws_secret_access_key));
  };
  for (const [name, values] of parsed.merged) {
    const problems: AwsConfigurationDiagnostic[] = [];
    if (values.source_profile && !parsed.merged.has(values.source_profile)) problems.push(diagnostic("missing-source-profile", "The source profile is missing."));
    if (values.source_profile && values.credential_source) problems.push(diagnostic("conflicting-role-source", "A role profile cannot declare both source_profile and credential_source."));
    if (values.role_arn && !/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/.+/.test(values.role_arn)) problems.push(diagnostic("invalid-role", "The IAM role ARN is invalid."));
    if (values.sso_session && !(authoritative?.sessions[values.sso_session] ?? parsed.config.sessions.get(values.sso_session))) problems.push(diagnostic("missing-sso-session", "The referenced IAM Identity Center session is missing."));
    if ((values.aws_access_key_id && !values.aws_secret_access_key) || (!values.aws_access_key_id && values.aws_secret_access_key)) problems.push(diagnostic("incomplete-static-credentials", "The profile has incomplete access-key configuration."));
    let cursor: string | undefined = name; const visited = new Set<string>();
    while (cursor) { if (visited.has(cursor)) { problems.push(diagnostic("role-cycle", "The source-profile chain contains a cycle.")); break; } visited.add(cursor); const source = parsed.merged.get(cursor); if (source?.source_profile === cursor && source.aws_access_key_id && source.aws_secret_access_key) break; cursor = source?.source_profile; }
    if (!hasRoute(name)) problems.push(diagnostic("no-credential-route", "The profile has no complete configured credential source."));
    if (values.sso_start_url && !values.sso_session) problems.push(diagnostic("legacy-sso", "This legacy Identity Center profile does not support modern shared-session refresh.", "warning"));
    if (values.endpoint_url || values.services || Object.keys(env).some(key => /^AWS_ENDPOINT_URL(?:_|$)/.test(key) && env[key])) problems.push(diagnostic("endpoint-override", "Configured endpoint overrides are ignored for trusted AWS identity checks.", "warning"));
    if (parsed.config.ambiguousProfiles.has(name) || parsed.credentials.ambiguousProfiles.has(name)) problems.push(diagnostic("ambiguous-profile", "This profile contains duplicate configuration. Resolve it outside Studio."));
    const readOnlyReason = files.config.readOnlyReason ?? files.config.problem?.message ?? (problems.some(problem => problem.code === "ambiguous-profile") ? "This profile has ambiguous configuration." : undefined);
    const configuration = safeAwsProfileConfiguration(values);
    for (const key of AWS_PROFILE_FIELDS) if (values[key] && !configuration[key]) problems.push(diagnostic("invalid-public-setting", `The ${key} setting is invalid. Review it using the native AWS configuration tools.`));
    const items = mechanisms(values);
    profiles.push({ name, kind: profileKind(items), mechanisms: items, ...(configuration.region ? { region: configuration.region } : {}), ...(configuration.source_profile ? { sourceProfile: configuration.source_profile } : {}), ...(configuration.role_arn ? { roleArn: configuration.role_arn } : {}), ...(configuration.sso_session ? { ssoSession: configuration.sso_session } : {}), ...(configuration.login_session ? { loginSession: configuration.login_session } : {}), ...(configuration.credential_source ? { credentialSource: configuration.credential_source } : {}), hasMfa: Boolean(values.mfa_serial), editable: !readOnlyReason, configuration, provenance: { config: parsed.config.profiles.has(name), credentials: parsed.credentials.profiles.has(name), ...(readOnlyReason ? { readOnlyReason } : {}) }, diagnostics: problems });
  }
  profiles.sort((a, b) => a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name));
  const sessions = [...parsed.config.sessions].map(([name, values]) => { const safe = safeAwsProfileConfiguration(values); return { name, ...(safe.sso_start_url ? { startUrl: safe.sso_start_url } : {}), ...(safe.sso_region ? { region: safe.sso_region } : {}), profiles: profiles.filter(profile => profile.ssoSession === name).map(profile => profile.name) }; });
  return { revision: files.revision, profiles, sessions, diagnostics, environment: { credentialsPresent: Boolean(env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN), endpointOverridesPresent: Object.keys(env).some(key => /^AWS_ENDPOINT_URL(?:_|$)/.test(key) && Boolean(env[key])) } };
}
export function inspectAwsProfiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AwsProfileCatalog { return projectCatalog(readAwsFiles(env, home), env); }
export async function loadAwsCatalog(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<AwsProfileCatalog> {
  const files = readAwsFiles(env, home);
  const [loaded, sessions] = await Promise.all([loadSharedConfigFiles({ configFilepath: files.config.path, filepath: files.credentials.path, ignoreCache: true }), loadSsoSessionData({ configFilepath: files.config.path })]);
  // A concurrent external edit is reported by the next revision; do not mix two generations.
  if (readAwsFiles(env, home).revision !== files.revision) throw new AwsConnectionError(problem("configuration"));
  return projectCatalog(files, env, { ...loaded, sessions });
}

export function resolveAwsRegion(profile: string | undefined, explicit?: string, env: NodeJS.ProcessEnv = process.env): AwsRegionResolution {
  if (explicit) { const value = safeAwsProfileConfiguration({ region: explicit }).region; return value ? { value, source: "explicit" } : { source: "missing" }; }
  if (env.AWS_REGION || env.AWS_DEFAULT_REGION) { const value = safeAwsProfileConfiguration({ region: (env.AWS_REGION || env.AWS_DEFAULT_REGION)! }).region; return value ? { value, source: "environment" } : { source: "missing" }; }
  const values = profile ? configuredAwsProfiles(readAwsFiles(env)).merged.get(profile) : undefined;
  const value = values ? safeAwsProfileConfiguration(values).region : undefined;
  return value ? { value, source: "profile" } : { source: "missing" };
}
const DIRECT_CREDENTIALS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN"];
export function connectionEnvironment(base: NodeJS.ProcessEnv, profile: string, options: { readonly region?: string; readonly validate?: boolean } = {}): NodeJS.ProcessEnv {
  if (!isAwsProfileName(profile)) throw new AwsConnectionError(problem("profile"));
  const files = readAwsFiles(base), parsed = configuredAwsProfiles(files);
  if (options.validate !== false) {
    const catalog = projectCatalog(files, base), descriptor = catalog.profiles.find(entry => entry.name === profile);
    if (!descriptor) throw new AwsConnectionError(problem("profile"));
    if (catalog.diagnostics.some(item => item.severity === "error") || descriptor.diagnostics.some(item => item.severity === "error")) throw new AwsConnectionError(problem("configuration"));
  }
  const sources = new Set<string>(); let cursor: string | undefined = profile; const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) { seen.add(cursor); const item = parsed.merged.get(cursor); if (item?.credential_source) sources.add(item.credential_source); cursor = item?.source_profile; }
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE", "npm_config_profile"]) delete env[key];
  for (const key of Object.keys(env)) if (/^AWS_ENDPOINT_URL(?:_|$)/.test(key)) delete env[key];
  env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
  if (!sources.has("Environment")) for (const key of DIRECT_CREDENTIALS) delete env[key];
  if (!sources.has("EcsContainer")) for (const key of ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"]) delete env[key];
  env.AWS_EC2_METADATA_DISABLED = sources.has("Ec2InstanceMetadata") ? "false" : "true";
  env.AWS_PROFILE = profile;
  const region = resolveAwsRegion(profile, options.region, base).value;
  if (region) { env.AWS_REGION = region; env.AWS_DEFAULT_REGION = region; }
  env.AWS_PAGER = ""; env.AWS_CLI_AUTO_PROMPT = "off"; env.NO_COLOR = "1";
  return env;
}

/** Makes no source-file writes. Every copy is private and disposed by its owning operation. */
export function withoutAwsCliHistory(text: string, kind: "config" | "credentials"): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/), output: string[] = []; let inProfile = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inProfile = kind === "credentials" || header[1]!.trim() === "default" || /^profile\s+/.test(header[1]!.trim());
      output.push(line);
      if (inProfile) output.push("cli_history = disabled");
    } else if (inProfile && /^\s*cli_history\s*=/i.test(line)) {
      // Remove every old occurrence; duplicate settings must not re-enable history.
    } else output.push(line);
  }
  return output.join(newline);
}
export interface AwsExecutionSnapshot {
  readonly directory: string;
  readonly configFile: string;
  readonly credentialsFile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
  dispose(): void;
}
const snapshots = new Set<string>();
let exitHook = false;
export function disposeAwsExecutionSnapshots(): void { for (const directory of [...snapshots]) { rmSync(directory, { recursive: true, force: true }); snapshots.delete(directory); } }
/** Reclaim only our private, same-user snapshots whose recorded process no longer exists. */
export function recoverAwsExecutionSnapshots(): void {
  let entries: string[]; try { entries = readdirSync(os.tmpdir()); } catch { return; }
  for (const entry of entries) {
    if (!/^aws-studio-connection-[A-Za-z0-9]+$/.test(entry)) continue;
    const directory = path.join(os.tmpdir(), entry);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) continue;
      const ownerFile = path.join(directory, "owner.json"), ownerStat = lstatSync(ownerFile);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 512) continue;
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { kind?: unknown; pid?: unknown };
      if (owner.kind !== "aws-studio-connection" || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 || owner.pid === process.pid) continue;
      try { process.kill(Number(owner.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(directory, { recursive: true, force: true }); }
    } catch { /* Unknown or modified directories are not ours to remove. */ }
  }
}
export function createAwsExecutionSnapshot(env: NodeJS.ProcessEnv = process.env, additions?: { readonly config?: string; readonly credentials?: string }): AwsExecutionSnapshot {
  const files = readAwsFiles(env);
  if (files.config.problem || files.credentials.problem) throw new AwsConnectionError(problem("configuration"));
  const directory = mkdtempSync(path.join(os.tmpdir(), "aws-studio-connection-")); chmodSync(directory, 0o700);
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  snapshots.add(directory);
  if (!exitHook) { exitHook = true; recoverAwsExecutionSnapshots(); process.once("exit", disposeAwsExecutionSnapshots); }
  try {
    writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ kind: "aws-studio-connection", pid: process.pid }), { mode: 0o600, flag: "wx" });
    let config = withoutAwsCliHistory(additions?.config ?? files.config.text, "config");
    const credentialsText = additions?.credentials ?? files.credentials.text;
    const configured = parseAwsDocument(config, "config").profiles;
    for (const name of parseAwsDocument(credentialsText, "credentials").profiles.keys()) if (!configured.has(name)) {
      const encoded = /^[A-Za-z0-9_+=,.@+%:/-]+$/.test(name) ? name : JSON.stringify(name);
      config += `\n[${name === "default" ? "default" : `profile ${encoded}`}]\ncli_history = disabled\n`;
    }
    writeFileSync(configFile, config, { mode: 0o600, flag: "wx" });
    writeFileSync(credentialsFile, withoutAwsCliHistory(credentialsText, "credentials"), { mode: 0o600, flag: "wx" });
    let disposed = false;
    return { directory, configFile, credentialsFile, revision: files.revision, environment: { ...env, AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" }, dispose() { if (disposed) return; disposed = true; rmSync(directory, { recursive: true, force: true }); snapshots.delete(directory); } };
  } catch { rmSync(directory, { recursive: true, force: true }); snapshots.delete(directory); throw new AwsConnectionError(problem("configuration")); }
}

const PROBLEMS: Record<AwsConnectionProblem["code"], Omit<AwsConnectionProblem, "code">> = {
  "missing-cli": { message: "The AWS CLI is unavailable. Install AWS CLI v2 and restart Studio.", action: "install-cli", retryable: false },
  "unsupported-cli": { message: "This feature requires a newer AWS CLI v2. Update the AWS CLI.", action: "update-cli", retryable: false },
  profile: { message: "The selected profile is unavailable. Choose a configured AWS profile.", action: "configure", retryable: false },
  configuration: { message: "The AWS profile configuration is incomplete, ambiguous, or unreadable. Review its configuration.", action: "configure", retryable: false },
  "missing-region": { message: "Choose an AWS region to complete this connection check.", action: "configure", retryable: false },
  "no-credentials": { message: "No usable credentials are available for this profile. Connect or configure its credential source.", action: "connect", retryable: false },
  expired: { message: "The selected profile needs authentication. Reconnect its sign-in session.", action: "connect", retryable: false },
  "mfa-required": { message: "This profile requires an MFA interaction. Authenticate with the AWS CLI in your terminal, then test again.", action: "terminal", retryable: false },
  "assume-role": { message: "The source identity could not assume the configured IAM role. Check role trust and sts:AssumeRole permissions.", action: "permissions", retryable: false },
  "external-provider": { message: "The external credential provider could not supply credentials. Repair it using its own tools, then test again.", action: "terminal", retryable: false },
  denied: { message: "AWS denied this operation. Authentication and permission to perform this action are separate checks.", action: "permissions", retryable: false },
  network: { message: "AWS could not be reached. Check network, proxy, TLS certificate, and endpoint settings.", action: "retry", retryable: true },
  throttled: { message: "AWS throttled the request. Wait briefly, then try again.", action: "retry", retryable: true },
  canceled: { message: "The AWS connection action was canceled. Shared native authentication caches may already have changed.", action: "none", retryable: false },
  timeout: { message: "The AWS connection action exceeded its time limit. Check the provider or try again.", action: "retry", retryable: true },
  failed: { message: "The AWS connection action failed. Check the profile configuration and try again.", action: "retry", retryable: true },
};
export function problem(code: AwsConnectionProblem["code"]): AwsConnectionProblem { return { code, ...PROBLEMS[code] }; }
export class AwsConnectionError extends Error {
  readonly status: number;
  constructor(readonly problem: AwsConnectionProblem) { super(problem.message); this.name = "AwsConnectionError"; this.status = problem.code === "canceled" ? 409 : 422; }
}
export function classifyAwsConnectionError(stderr: string, missing = false): AwsConnectionProblem {
  if (missing || /ENOENT|command not found|is not recognized/i.test(stderr)) return problem("missing-cli");
  if (/invalid choice|Unknown options/.test(stderr)) return problem("unsupported-cli");
  if (/ProfileNotFound|config profile .* could not be found/i.test(stderr)) return problem("profile");
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT)\b|Could not connect|EndpointConnection|SSL validation|CERT_|certificate verify|connection.*(?:closed|reset)|proxy|timed out/i.test(stderr)) return problem("network");
  if (/MFA|mfa|EOF when reading a line|Cannot perform an interactive login/.test(stderr)) return problem("mfa-required");
  if (/ExpiredToken|UnauthorizedSSOToken|SSO session .* expired|Error loading SSO Token|Token has expired|invalid_grant|refresh token.*expired|reauthenticate|Error loading login session token|refresh login credentials|refreshing a login session/i.test(stderr)) return problem("expired");
  if (/AssumeRole.*(?:AccessDenied|denied)|(?:AccessDenied|denied).*AssumeRole/i.test(stderr)) return problem("assume-role");
  if (/credential_process|credential process|process credentials|CredentialRetrievalError/i.test(stderr)) return problem("external-provider");
  if (/Unable to locate credentials|NoCredentials|InvalidClientTokenId|UnrecognizedClientException|No login session|login session.*not found/i.test(stderr)) return problem("no-credentials");
  if (/NoRegionError|You must specify a region|region.*not configured/i.test(stderr)) return problem("missing-region");
  if (/Unable to parse config|ConfigParseError|PartialCredentials|source_profile|credential_source|InvalidConfig|Missing.*sso_/i.test(stderr)) return problem("configuration");
  if (/AccessDenied|UnauthorizedOperation|not authorized|ForbiddenException/i.test(stderr)) return problem("denied");
  if (/Throttling|Rate exceeded|TooManyRequests/i.test(stderr)) return problem("throttled");
  return problem("failed");
}
export function awsIdentity(account: string, arn: string): AwsResolvedIdentity {
  const principalKind = /:assumed-role\//.test(arn) ? "assumed-role" : /:user\//.test(arn) ? "user" : /:root$/.test(arn) ? "root" : /:federated-user\//.test(arn) ? "federated" : "unknown";
  const summary = principalKind === "assumed-role" ? arn.slice(arn.indexOf(":assumed-role/") + 14).replace(/\//g, " / ") : arn.split(":").slice(5).join(":").replace(/^(?:user|federated-user)\//, "");
  return { account, arn, principalKind, summary };
}
function killPrivateProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}
export function privateAwsCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const fake = env.FRAMEWORK_AWS_CLI;
  return { file: fake ? process.execPath : "aws", args: [...(fake ? [fake] : []), ...args] };
}
export interface PrivateAwsOptions { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly cwd?: string; readonly snapshot?: boolean }
export async function runPrivateAws(args: readonly string[], options: PrivateAwsOptions = {}): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  if (options.signal?.aborted) throw new AwsConnectionError(problem("canceled"));
  const snapshot = options.snapshot === false ? undefined : createAwsExecutionSnapshot(options.env ?? process.env);
  const env = snapshot?.environment ?? options.env ?? process.env;
  const command = privateAwsCommand(args, env);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command.file, command.args, { env, cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let stdout = "", stderr = "", finished = false;
      const finish = (error?: AwsConnectionError, code = 0) => { if (finished) return; finished = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve({ stdout, stderr, code }); };
      const abort = () => { killPrivateProcess(child); finish(new AwsConnectionError(problem("canceled"))); };
      const timer = setTimeout(() => { killPrivateProcess(child); finish(new AwsConnectionError(problem("timeout"))); }, options.timeoutMs ?? 30_000);
      const append = (value: Buffer, stream: "stdout" | "stderr") => {
        if (stdout.length + stderr.length + value.length > 1024 * 1024) { killPrivateProcess(child); finish(new AwsConnectionError(problem("failed"))); return; }
        if (stream === "stdout") stdout += value.toString("utf8"); else stderr += value.toString("utf8");
      };
      child.stdout.on("data", (value: Buffer) => append(value, "stdout")); child.stderr.on("data", (value: Buffer) => append(value, "stderr"));
      child.once("error", (error: NodeJS.ErrnoException) => finish(new AwsConnectionError(classifyAwsConnectionError("", error.code === "ENOENT"))));
      child.once("close", code => finish(code === 0 ? undefined : new AwsConnectionError(classifyAwsConnectionError(stderr)), code ?? 1));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } finally { snapshot?.dispose(); }
}
export interface CliAwsCredentialIdentity { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expiration?: Date }
export function cliCredentialProvider(profile: string, options: Omit<PrivateAwsOptions, "snapshot"> = {}): () => Promise<CliAwsCredentialIdentity> {
  let cached: CliAwsCredentialIdentity | undefined, cachedAt = 0, cachedRevision: string | undefined, pending: Promise<CliAwsCredentialIdentity> | undefined;
  return async () => {
    const revision = readAwsFiles(options.env ?? process.env).revision;
    if (cached && revision === cachedRevision && (cached.expiration ? cached.expiration.getTime() - Date.now() > 5 * 60_000 : Date.now() - cachedAt < 30_000)) return cached;
    if (!pending) pending = (async () => {
      const env = connectionEnvironment(options.env ?? process.env, profile);
      const result = await runPrivateAws(["configure", "export-credentials", "--profile", profile, "--format", "process", "--no-cli-pager"], { ...options, env });
      if (readAwsFiles(options.env ?? process.env).revision !== revision) throw new AwsConnectionError(problem("configuration"));
      let value: Record<string, unknown>; try { value = JSON.parse(result.stdout); } catch { throw new AwsConnectionError(problem("failed")); }
      if (value.Version !== 1 || typeof value.AccessKeyId !== "string" || !value.AccessKeyId || typeof value.SecretAccessKey !== "string" || !value.SecretAccessKey || (value.SessionToken !== undefined && typeof value.SessionToken !== "string")) throw new AwsConnectionError(problem("failed"));
      const expiration = value.Expiration === undefined ? undefined : typeof value.Expiration === "string" ? new Date(value.Expiration) : new Date(NaN);
      if (expiration && !Number.isFinite(expiration.getTime())) throw new AwsConnectionError(problem("failed"));
      if (expiration && expiration.getTime() <= Date.now()) throw new AwsConnectionError(problem("expired"));
      cached = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, ...(value.SessionToken ? { sessionToken: value.SessionToken as string } : {}), ...(expiration ? { expiration } : {}) }; cachedAt = Date.now(); cachedRevision = revision;
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
