import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AwsEditableFields, AwsProfileChangeRequest, AwsProfileReview } from "../../shared/aws-connection-management";
import { awsFilePaths, parseAwsDocument, safeAwsProfileConfiguration } from "../../../scripts/aws-connections";
import { isAwsProfileName } from "../../shared/aws-connections";

export class ConnectionInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (message: string): never => { throw new ConnectionInputError(400, message); };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const PROFILE_NAME = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/;
const FIELDS = new Set(["region", "role_arn", "source_profile", "role_session_name", "duration_seconds", "mfa_serial", "sso_session", "sso_account_id", "sso_role_name"]);
export function awsPaths(env: NodeJS.ProcessEnv) {
  return awsFilePaths(env);
}
function fileText(file: string): string {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw new ConnectionInputError(422, "AWS configuration could not be read. Check its file permissions."); }
}
export interface IniSection { name: string; start: number; end: number; body: number }
interface IniSetting { key: string; prefix: string; value: string; comment: string; newline: string; index: number; length: number }
function topLevelSettings(body: string): IniSetting[] {
  const result: IniSetting[] = [];
  let group = false;
  for (const line of body.matchAll(/([^\r\n]*)(\r?\n|$)/g)) {
    if (!line[0]) continue;
    const raw = line[1]!;
    if (!raw.trim() || /^\s*[#;]/.test(raw)) continue;
    if (group && /^[ \t]/.test(raw)) continue;
    const setting = /^([ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*)(.*)$/.exec(raw);
    if (!setting) continue;
    const comment = /\s+[;#].*$/.exec(setting[3]!)?.[0] ?? "";
    const value = setting[3]!.slice(0, setting[3]!.length - comment.length).trim();
    group = !value;
    result.push({ key: setting[2]!, prefix: setting[1]!, value, comment, newline: line[2]!, index: line.index!, length: line[0].length });
  }
  return result;
}
export function iniSections(text: string): IniSection[] {
  const sections: IniSection[] = [];
  const headers = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:[;#][^\r\n]*)?(?:\r?\n|$)/gm;
  for (const match of text.matchAll(headers)) {
    if (sections.length) sections.at(-1)!.end = match.index!;
    const rawName = match[1]!.trim();
    const quoted = /^(profile|sso-session)\s+(["'])(.*?)\2$/.exec(rawName);
    sections.push({ name: quoted ? `${quoted[1]} ${quoted[3]}` : rawName, start: match.index!, body: match.index! + match[0].length, end: text.length });
  }
  return sections;
}
export function sectionValues(text: string, name: string): Record<string, string> {
  const matches = iniSections(text).filter(section => section.name === name);
  if (matches.length > 1) throw new ConnectionInputError(422, "The selected section is duplicated. Resolve it outside Studio before editing.");
  if (!matches.length) return {};
  const section = matches[0]!;
  const values: Record<string, string> = {};
  for (const setting of topLevelSettings(text.slice(section.body, section.end))) values[setting.key] = setting.value;
  return values;
}
/** Replaces only approved key spans. Unrelated text is never serialized. */
export function patchIniSection(text: string, name: string, changes: Readonly<Record<string, string | undefined>>, create: boolean): string {
  const sections = iniSections(text).filter(section => section.name === name);
  if (sections.length > 1) throw new ConnectionInputError(422, "The selected section is duplicated. Resolve it outside Studio before editing.");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const section = sections[0];
  if (!section) {
    if (!create) throw new ConnectionInputError(409, "The selected AWS profile no longer exists. Refresh before reviewing.");
    const prefix = text && !text.endsWith("\n") ? newline : "";
    const profile = name.startsWith("profile ") ? name.slice("profile ".length) : undefined;
    const header = profile && !/^[A-Za-z0-9_+=,.@+%:/-]+$/.test(profile) ? `profile ${JSON.stringify(profile)}` : name;
    return text + prefix + (text && !text.endsWith(newline + newline) ? newline : "") + `[${header}]${newline}` + Object.entries(changes).filter(([, value]) => value !== undefined).map(([key, value]) => `${key} = ${value}${newline}`).join("");
  }
  let body = text.slice(section.body, section.end);
  for (const [key, value] of Object.entries(changes)) {
    const matches = topLevelSettings(body).filter(setting => setting.key === key);
    if (matches.length > 1) throw new ConnectionInputError(422, `The ${key} setting is duplicated. Resolve it outside Studio before editing.`);
    if (matches.length) {
      const match = matches[0]!;
      const replacement = value === undefined ? match.comment ? `${match.comment.trimStart()}${match.newline}` : "" : `${match.prefix}${value}${match.comment}${match.newline}`;
      body = body.slice(0, match.index) + replacement + body.slice(match.index + match.length);
    } else if (value !== undefined) body += `${body && !body.endsWith("\n") ? newline : ""}${key} = ${value}${newline}`;
  }
  return text.slice(0, section.body) + body + text.slice(section.end);
}
export function validateFields(input: unknown): AwsEditableFields {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Provide supported non-secret profile fields.");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FIELDS.has(key) || typeof value !== "string" || value.length > 2048 || /[\r\n\x00-\x1f]/.test(value)) return fail("This profile change contains unsupported fields or values.");
    const normalized = value.trim();
    if (normalized && key === "region" && !safeAwsProfileConfiguration({ region: normalized }).region) return fail("Enter an AWS region such as us-east-1.");
    if (normalized && key === "role_arn" && !/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(normalized)) return fail("Enter a complete IAM role ARN.");
    if (normalized && key === "mfa_serial" && !/^(?:arn:aws(?:-[a-z]+)*:iam::\d{12}:mfa\/[A-Za-z0-9_+=,.@/-]+|[A-Z0-9]{8,64})$/.test(normalized)) return fail("Enter an IAM MFA device ARN or hardware-device serial number.");
    if (normalized && ["source_profile", "sso_session"].includes(key) && (normalized.length > 512 || /[\[\]]/.test(normalized))) return fail("Choose an existing profile or session name.");
    if (normalized && key === "role_session_name" && !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(normalized)) return fail("Role session names contain 2–64 letters, numbers or _+=,.@- characters.");
    if (normalized && key === "sso_role_name" && !/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(normalized)) return fail("Choose the assigned permission-set name.");
    if (normalized && key === "sso_account_id" && !/^\d{12}$/.test(normalized)) return fail("Enter a 12-digit AWS account ID.");
    if (normalized && key === "duration_seconds" && (!/^\d+$/.test(normalized) || Number(normalized) < 900 || Number(normalized) > 43200)) return fail("Role duration must be between 900 and 43200 seconds; chained roles may allow only one hour.");
    result[key] = normalized;
  }
  return result;
}
function reviewValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return;
  if (key === "login_session") return /^arn:aws(?:-[a-z]+)*:(?:iam|sts)::\d{12}:[A-Za-z0-9_+=,.@/:-]+$/.test(value) ? value : "Unrecognized value";
  try { validateFields({ [key]: value }); return value; }
  catch { return "Unrecognized value"; }
}
interface FileAuthority { text: string; identity: string; exists: boolean; mode?: number; uid?: number; gid?: number }
function authority(file: string, writing = false): FileAuthority {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", identity: "absent", exists: false }; throw new ConnectionInputError(422, "AWS file metadata could not be read."); }
  if (writing && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !(stat.mode & 0o200) || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new ConnectionInputError(422, "This AWS file is linked, owned by another user or read-only. Edit it outside Studio.");
  const text = fileText(file);
  return { text, identity: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${hash(text)}`, exists: true, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
}
function safeParent(file: string): void {
  let current = path.dirname(file);
  while (current !== path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ConnectionInputError(422, "Studio does not edit AWS configuration through linked directories.");
    current = path.dirname(current);
  }
}
export interface AuthenticatedConfiguration { readonly fields: Readonly<Record<string, string>>; readonly session?: { readonly name: string; readonly fields: Readonly<Record<string, string>> } }
interface StoredReview { view: AwsProfileReview; config: FileAuthority; credentials: FileAuthority; paths: ReturnType<typeof awsPaths>; after: string }
export class ProfileConfiguration {
  private readonly reviews = new Map<string, StoredReview>();
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly busy: (profiles: readonly string[]) => boolean = () => false) {}
  review(input: AwsProfileChangeRequest, knownNames: readonly string[], affectedProfiles: readonly string[], authenticated?: AuthenticatedConfiguration): AwsProfileReview {
    if (!input || Object.keys(input).some(key => !["name", "create", "fields", "authenticationId"].includes(key)) || typeof input.name !== "string" || typeof input.create !== "boolean" || (input.create ? !PROFILE_NAME.test(input.name) : !isAwsProfileName(input.name))) return fail("Choose a valid AWS profile name and supported settings.");
    const fields = validateFields(input.fields);
    const paths = awsPaths(this.env);
    safeParent(paths.config);
    const config = authority(paths.config, true);
    const credentials = authority(paths.credentials);
    const header = input.name === "default" ? "default" : `profile ${input.name}`;
    const existing = sectionValues(config.text, header);
    const credentialSettings = sectionValues(credentials.text, input.name);
    const exists = knownNames.includes(input.name);
    if (input.create && exists) throw new ConnectionInputError(409, "That profile name already exists in AWS configuration or credentials.");
    if (!input.create && !exists) throw new ConnectionInputError(409, "That profile no longer exists. Refresh before editing.");
    const role = Boolean(existing.role_arn || credentialSettings.role_arn || fields.role_arn);
    const sso = Boolean(existing.sso_session || existing.sso_start_url || credentialSettings.sso_session);
    if (!input.create) {
      if (fields.role_arn && !existing.role_arn && !credentialSettings.role_arn || fields.sso_session && !sso) return fail("Create another profile to change authentication methods.");
      if (Object.keys(fields).some(key => Object.hasOwn(credentialSettings, key))) throw new ConnectionInputError(422, "The credentials file owns one of these settings. Edit that setting through the native terminal.");
    }
    if (input.create && !authenticated && !(fields.role_arn && fields.source_profile)) return fail("Authenticate the new connection, or provide a role ARN and source profile.");
    const staticSelfSource = Boolean((existing.aws_access_key_id || credentialSettings.aws_access_key_id) && (existing.aws_secret_access_key || credentialSettings.aws_secret_access_key) && existing.source_profile === input.name);
    if (role && fields.source_profile === input.name && !staticSelfSource) return fail("A role profile cannot use itself as its source without existing native static credentials.");
    if (fields.source_profile && !knownNames.includes(fields.source_profile)) return fail("Choose an existing source profile.");
    if (fields.source_profile && (existing.credential_source || credentialSettings.credential_source)) return fail("This role declares credential_source. Edit its source type outside Studio to avoid conflicting credential sources.");
    if (input.create && authenticated?.session && (!fields.sso_account_id || !fields.sso_role_name)) return fail("Choose an assigned AWS account and permission set before reviewing the new profile.");
    if (!input.create && Object.keys(fields).some(key => key !== "region" && (key.startsWith("sso_") ? !sso : !role))) return fail("Those fields do not belong to this profile's authentication method.");
    const approved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({ ...fields, ...authenticated?.fields })) approved[key] = value || undefined;
    if (approved.role_arn && !approved.source_profile && !existing.source_profile && !existing.credential_source) return fail("Select the role's source profile.");
    if (Object.hasOwn(approved, "role_arn") && !approved.role_arn || Object.hasOwn(approved, "source_profile") && !approved.source_profile && role && !existing.credential_source) return fail("A role profile must retain its role and credential source.");
    let after = patchIniSection(config.text, header, approved, input.create || !Object.keys(existing).length);
    const changes: { field: string; before?: string; after?: string }[] = [];
    for (const [key, value] of Object.entries(approved)) if (existing[key] !== value) changes.push({ field: key, ...(existing[key] ? { before: reviewValue(key, existing[key]) } : {}), ...(value ? { after: value } : {}) });
    if (authenticated?.session) {
      const sessionHeader = `sso-session ${authenticated.session.name}`;
      const previous = sectionValues(config.text, sessionHeader);
      if (Object.keys(previous).length && Object.entries(authenticated.session.fields).some(([key, value]) => previous[key] !== value)) throw new ConnectionInputError(409, "That shared session already has different settings. Choose a new session name to preserve its dependents.");
      after = patchIniSection(after, sessionHeader, authenticated.session.fields, true);
      for (const [key, value] of Object.entries(authenticated.session.fields)) if (previous[key] !== value) changes.push({ field: `${sessionHeader}.${key}`, after: value });
    }
    const configProfiles = parseAwsDocument(after, "config").profiles;
    const selectedSession = configProfiles.get(input.name)?.sso_session;
    if (selectedSession && !parseAwsDocument(after, "config").sessions.has(selectedSession)) return fail("The selected Identity Center session is missing. Choose an existing session or create it through guided setup.");
    const credentialsProfiles = parseAwsDocument(credentials.text, "credentials").profiles;
    const visited = new Set<string>(); let current: string | undefined = input.name;
    while (current) {
      if (visited.has(current)) return fail("This change would introduce a cycle in the source-profile chain.");
      visited.add(current);
      const settings: Record<string, string> = { ...configProfiles.get(current), ...credentialsProfiles.get(current) };
      if (settings.source_profile && settings.credential_source) return fail("A role profile must choose either source_profile or credential_source.");
      if (settings.source_profile === current && settings.aws_access_key_id && settings.aws_secret_access_key) break;
      current = settings.source_profile;
      if (current && !configProfiles.has(current) && !credentialsProfiles.has(current)) return fail("The source-profile chain contains a missing profile.");
    }
    if (this.busy(affectedProfiles)) throw new ConnectionInputError(409, "An affected profile is in use by a running AWS mutation. Wait for it to finish before editing.");
    const view: AwsProfileReview = { id: randomUUID(), name: input.name, create: input.create, changes, affectedProfiles, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    this.reviews.set(view.id, { view, config, credentials, paths, after });
    return view;
  }
  apply(id: string): { name: string; changed: boolean } {
    const stored = this.reviews.get(id);
    if (!stored || Date.parse(stored.view.expiresAt) <= Date.now()) throw new ConnectionInputError(409, "This profile review expired. Review the change again.");
    if (this.busy(stored.view.affectedProfiles)) throw new ConnectionInputError(409, "An affected profile is in use by a running AWS mutation. Wait before applying.");
    const paths = awsPaths(this.env);
    if (paths.config !== stored.paths.config || paths.credentials !== stored.paths.credentials) throw new ConnectionInputError(409, "AWS configuration paths changed after review. Review again; nothing was written.");
    safeParent(paths.config);
    if (authority(paths.config, true).identity !== stored.config.identity || authority(paths.credentials).identity !== stored.credentials.identity) throw new ConnectionInputError(409, "AWS configuration changed after review. Refresh and review again; nothing was written.");
    if (stored.after === stored.config.text) { this.reviews.delete(id); return { name: stored.view.name, changed: false }; }
    mkdirSync(path.dirname(paths.config), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(paths.config), `.studio-profile-${randomUUID()}.tmp`);
    const lockFile = `${paths.config}.studio-profile-lock`;
    let fd: number | undefined;
    let lock: number | undefined;
    try {
      try { lock = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
      catch { throw new ConnectionInputError(409, "Another configuration write or an unresolved Studio lock exists. Wait or inspect the lock before reviewing again."); }
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), stored.config.mode ?? 0o600);
      if (stored.config.mode !== undefined) fchmodSync(fd, stored.config.mode);
      if (process.platform !== "win32" && stored.config.uid !== undefined && stored.config.gid !== undefined) fchownSync(fd, stored.config.uid, stored.config.gid);
      writeFileSync(fd, stored.after, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (authority(paths.config, true).identity !== stored.config.identity || authority(paths.credentials).identity !== stored.credentials.identity) throw new ConnectionInputError(409, "AWS configuration changed during apply. Review again; nothing was written.");
      renameSync(temporary, paths.config);
      this.reviews.delete(id);
      return { name: stored.view.name, changed: true };
    } catch (error) {
      if (error instanceof ConnectionInputError) throw error;
      throw new ConnectionInputError(422, "The reviewed AWS configuration could not be written safely. Check file permissions; no replacement was completed.");
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the actual write result if cleanup is denied. */ }
      if (lock !== undefined) { closeSync(lock); try { rmSync(lockFile, { force: true }); } catch { /* An unresolved lock blocks subsequent writes. */ } }
    }
  }
  discard(id: string) { this.reviews.delete(id); return { discarded: true }; }
  dispose() { this.reviews.clear(); }
}
