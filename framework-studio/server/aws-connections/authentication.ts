import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fromSso } from "@aws-sdk/token-providers";
import { ListAccountsCommand, ListAccountRolesCommand, SSOClient } from "@aws-sdk/client-sso";
import { createAwsExecutionSnapshot, runPrivateAws, connectionEnvironment, resolveAwsRegion, safeAwsProfileConfiguration } from "../../../scripts/aws-connections";
import { isAwsProfileName, type AwsProfileCatalog, type AwsProfileDescriptor } from "../../shared/aws-connections";
import type { AwsAuthenticationRequest, AwsAuthenticationSession, AwsCliCapabilities } from "../../shared/aws-connection-management";
import { stopTree } from "../deploy/process";
import { ConnectionInputError, patchIniSection, PROFILE_NAME, sectionValues, type AuthenticatedConfiguration } from "./configuration";

type Snapshot = Awaited<ReturnType<typeof createAwsExecutionSnapshot>>;
export interface AuthCommand {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly onOutput: (chunk: string) => void;
  readonly signal: AbortSignal;
  readonly onInput: (write: (value: string) => void) => void;
}
export type AuthRunner = (command: AuthCommand) => Promise<number>;
export const runAuthenticationCommand: AuthRunner = command => new Promise((resolve, reject) => {
  const fake = command.env.FRAMEWORK_AWS_CLI;
  let child: ChildProcess;
  try {
    child = spawn(fake ? process.execPath : "aws", [...(fake ? [fake] : []), ...command.args], {
      env: command.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { reject(new ConnectionInputError(422, "The AWS CLI could not be started. Check its installation.")); return; }
  const abort = () => stopTree(child);
  command.signal.addEventListener("abort", abort, { once: true });
  command.onInput(value => { if (!child.stdin?.destroyed) child.stdin?.write(value); });
  child.stdout!.on("data", chunk => command.onOutput(String(chunk)));
  child.stderr!.on("data", chunk => command.onOutput(String(chunk)));
  child.once("error", () => reject(new ConnectionInputError(422, "The AWS CLI could not be started. Check its installation.")));
  child.once("close", code => { command.signal.removeEventListener("abort", abort); resolve(code ?? -1); });
  if (command.signal.aborted) abort();
});

interface AuthRecord {
  view: AwsAuthenticationSession;
  request: AwsAuthenticationRequest;
  existing: boolean;
  root: AwsProfileDescriptor | undefined;
  catalog: AwsProfileCatalog;
  snapshot?: Snapshot;
  controller: AbortController;
  write?: (value: string) => void;
  release?: () => void;
  createdAt: number;
  output: string;
  completed?: AuthenticatedConfiguration;
  task?: Promise<void>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
const active = (view: AwsAuthenticationSession) => !["complete", "failed", "canceled"].includes(view.state);
const arnPattern = "arn:aws(?:-[a-z]+)*:(?:iam|sts)::\\d{12}:[A-Za-z0-9_+=,.@/:-]+";
export function safeAuthorizationUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (!["amazonaws.com", "amazonaws.com.cn", "awsapps.com", "awsapps.cn", "signin.aws", "signin.aws.amazon.com", "signin.aws.amazon.com.cn"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return;
    return url.href;
  } catch { return; }
}
export function profileDependents(catalog: AwsProfileCatalog, roots: readonly string[]): string[] {
  const selected = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const profile of catalog.profiles) if (profile.sourceProfile && selected.has(profile.sourceProfile) && !selected.has(profile.name)) { selected.add(profile.name); changed = true; }
  }
  return [...selected];
}
function rootProfile(catalog: AwsProfileCatalog, profile: AwsProfileDescriptor): AwsProfileDescriptor {
  const visited = new Set<string>();
  let current = profile;
  while (current.sourceProfile) {
    if (current.sourceProfile === current.name && current.mechanisms.includes("static")) break;
    if (visited.has(current.name)) throw new ConnectionInputError(422, "The selected role chain contains a cycle. Repair its source profiles first.");
    visited.add(current.name);
    const parent = catalog.profiles.find(entry => entry.name === current.sourceProfile);
    if (!parent) throw new ConnectionInputError(422, "The selected role's source profile is missing.");
    current = parent;
  }
  return current;
}
function nativeSessionKey(env: NodeJS.ProcessEnv, method: "login" | "sso", shared: string): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const cache = method === "login" ? env.AWS_LOGIN_CACHE_DIRECTORY ?? path.join(home, ".aws", "login", "cache") : path.join(home, ".aws", "sso", "cache");
  return `${path.resolve(cache)}|${method}|${shared}`;
}
/** A machine-local lease, keyed by native shared session rather than repository or leaf profile. */
function sessionLease(key: string): () => void {
  const directory = path.join(os.tmpdir(), `aws-studio-auth-${process.getuid?.() ?? "user"}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (parent.isSymbolicLink() || process.getuid && parent.uid !== process.getuid() || process.platform !== "win32" && (parent.mode & 0o077)) throw new ConnectionInputError(422, "The private authentication lock directory has unsafe ownership or permissions.");
  const lock = path.join(directory, createHash("sha256").update(key).digest("hex"));
  const token = randomUUID();
  const claim = () => { mkdirSync(lock, { mode: 0o700 }); writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" }); };
  try { claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ConnectionInputError(422, "A private authentication lock could not be created.");
    try {
      const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error();
      try { process.kill(owner.pid, 0); throw new ConnectionInputError(409, "Another Studio process is authenticating this shared AWS session."); }
      catch (running) { if ((running as NodeJS.ErrnoException).code !== "ESRCH") throw running; }
      rmSync(lock, { recursive: true }); claim();
    } catch (issue) { if (issue instanceof ConnectionInputError) throw issue; throw new ConnectionInputError(409, "A shared authentication lock is unresolved. Wait for the other Studio process to finish."); }
  }
  return () => {
    try { if (JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).token === token) rmSync(lock, { recursive: true }); } catch { /* Never remove a lease another process owns. */ }
  };
}
export interface AuthenticationOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: AuthRunner;
  readonly changed?: (profiles: readonly string[]) => void;
  readonly verify?: (profile: string, env: NodeJS.ProcessEnv) => Promise<void>;
}
export class AuthenticationCoordinator {
  private readonly sessions = new Map<string, AuthRecord>();
  private readonly keys = new Map<string, string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: AuthRunner;
  constructor(private readonly options: AuthenticationOptions = {}) { this.env = options.env ?? process.env; this.run = options.run ?? runAuthenticationCommand; }
  isBusy(profiles: readonly string[]): boolean { return [...this.sessions.values()].some(record => active(record.view) && record.view.affectedProfiles.some(profile => profiles.includes(profile))); }
  lockProfiles(catalog: AwsProfileCatalog, profiles: readonly string[]): () => void {
    const keys = new Set<string>();
    for (const profile of catalog.profiles.filter(entry => profiles.includes(entry.name))) {
      const root = rootProfile(catalog, profile);
      if (root.kind === "sso" || root.kind === "login") keys.add(nativeSessionKey(this.env, root.kind, root.kind === "sso" ? root.ssoSession ?? `legacy:${root.configuration.sso_start_url ?? root.name}` : root.loginSession ?? root.name));
    }
    const releases: (() => void)[] = [];
    try { for (const key of [...keys].sort()) releases.push(sessionLease(key)); }
    catch (error) { releases.reverse().forEach(release => release()); throw error; }
    return () => releases.reverse().forEach(release => release());
  }
  async start(request: AwsAuthenticationRequest, catalog: AwsProfileCatalog, capabilities: AwsCliCapabilities): Promise<AwsAuthenticationSession> {
    await this.expire();
    if (!request || typeof request !== "object" || Object.keys(request).some(key => !["profile", "method", "name", "region", "session", "startUrl", "ssoRegion"].includes(key))) throw new ConnectionInputError(400, "Choose a supported AWS connection method.");
    const existing = request.profile !== undefined;
    const selected = existing ? catalog.profiles.find(profile => profile.name === request.profile) : undefined;
    if (existing && !selected) throw new ConnectionInputError(400, "Select a profile from this machine's AWS configuration.");
    const root = selected ? rootProfile(catalog, selected) : undefined;
    const method = root?.kind ?? request.method;
    if (method !== "login" && method !== "sso") throw new ConnectionInputError(422, "This profile authenticates through its configured provider. Use its native terminal workflow, then test the connection.");
    if (method === "login" && !capabilities.consoleLogin || method === "sso" && !capabilities.modernSso) throw new ConnectionInputError(422, method === "login" ? "Console sign-in requires AWS CLI 2.32.0 or newer." : "This Identity Center flow requires AWS CLI 2.9.0 or newer.");
    const name = root?.name ?? request.name;
    if (!name || (existing ? !isAwsProfileName(name) : !PROFILE_NAME.test(name))) throw new ConnectionInputError(400, "Enter a valid profile name.");
    if (!existing && catalog.profiles.some(profile => profile.name === name)) throw new ConnectionInputError(409, "That profile already exists. Choose another name or reconnect the existing profile.");
    const region = resolveAwsRegion(root?.name, request.region, this.env).value;
    if (request.region && !safeAwsProfileConfiguration({ region: request.region }).region) throw new ConnectionInputError(400, "Choose a valid AWS region.");
    if (method === "login" && !region) throw new ConnectionInputError(400, "Choose an AWS region before Console sign-in.");
    let session = root?.ssoSession ?? request.session;
    if (method === "sso" && !existing) {
      if (!session || !PROFILE_NAME.test(session)) throw new ConnectionInputError(400, "Enter an Identity Center session name.");
      const known = catalog.sessions.find(entry => entry.name === session);
      const startUrl = known?.startUrl ?? request.startUrl;
      const ssoRegion = known?.region ?? request.ssoRegion;
      if (!startUrl || !safeAwsProfileConfiguration({ sso_start_url: startUrl }).sso_start_url || !ssoRegion || !safeAwsProfileConfiguration({ sso_region: ssoRegion }).sso_region) throw new ConnectionInputError(400, "Enter the AWS access portal/issuer URL and its Identity Center region.");
      if (known && (request.startUrl && request.startUrl !== known.startUrl || request.ssoRegion && request.ssoRegion !== known.region)) throw new ConnectionInputError(409, "This shared session has different settings. Reuse its settings or choose a new name.");
      request = { ...request, session, startUrl, ssoRegion };
    }
    const shared = method === "sso" ? session ?? `legacy:${root?.configuration.sso_start_url ?? name}` : root?.loginSession ?? name;
    const key = nativeSessionKey(this.env, method, shared);
    const running = this.keys.get(key);
    if (running) { const record = this.sessions.get(running); if (record && active(record.view)) return record.view; }
    const related = catalog.profiles.filter(profile => method === "sso" ? session ? profile.ssoSession === session : root?.configuration.sso_start_url ? profile.configuration.sso_start_url === root.configuration.sso_start_url : profile.name === name : root?.loginSession ? profile.loginSession === root.loginSession : profile.name === name).map(profile => profile.name);
    const affectedProfiles = profileDependents(catalog, related.length ? related : [name]);
    const record: AuthRecord = { view: { id: randomUUID(), profile: name, method, state: "starting", message: "Preparing native AWS sign-in…", affectedProfiles }, request: { ...request, ...(region ? { region } : {}) }, existing, root, catalog, controller: new AbortController(), createdAt: Date.now(), output: "", release: sessionLease(key) };
    this.sessions.set(record.view.id, record); this.keys.set(key, record.view.id);
    record.task = this.execute(record).finally(() => { record.release?.(); record.release = undefined; if (this.keys.get(key) === record.view.id) this.keys.delete(key); });
    return record.view;
  }
  private update(record: AuthRecord, changes: Partial<AwsAuthenticationSession>) { record.view = { ...record.view, ...changes }; }
  private output(record: AuthRecord, chunk: string) {
    // This bounded text remains private and is erased when the command finishes.
    record.output = (record.output + chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")).slice(-16_384);
    for (const match of record.output.matchAll(/https:\/\/[^\s<>"']+/g)) {
      const url = safeAuthorizationUrl(match[0].replace(/[),.;]+$/, ""));
      if (url) this.update(record, { state: "waiting-browser", message: "Finish sign-in in your browser.", authorizationUrl: url });
    }
    const confirmation = new RegExp(`already configured to use session (${arnPattern})\\. Do you want to overwrite it to use (${arnPattern}) instead\\? \\(y/n\\):`).exec(record.output);
    if (confirmation) {
      this.update(record, { state: "confirmation-required", message: "The browser selected another AWS identity. Review the change before continuing.", confirmation: { previousArn: confirmation[1]!, nextArn: confirmation[2]!, message: "Replace this profile's Console session with the identity selected in your browser?" } });
      return;
    }
    if (/(?:\(y\/n\)|\[y\/n\]|Enter [^\r\n:]{1,100}:)\s*$/i.test(record.output)) {
      this.update(record, { state: "failed", message: "The AWS CLI requested an unsupported interaction. Complete sign-in in the native terminal, then test this connection." });
      record.controller.abort();
    }
  }
  private async execute(record: AuthRecord) {
    const timer = setTimeout(() => { this.update(record, { state: "failed", message: "Sign-in timed out. Start a new connection attempt when ready." }); record.controller.abort(); }, 10 * 60_000);
    timer.unref();
    try {
      const snapshot = await createAwsExecutionSnapshot(this.env);
      record.snapshot = snapshot;
      snapshot.environment.AWS_PROFILE = record.view.profile;
      delete snapshot.environment.AWS_DEFAULT_PROFILE;
      for (const name of Object.keys(snapshot.environment)) if (name === "AWS_ENDPOINT_URL" || name.startsWith("AWS_ENDPOINT_URL_")) delete snapshot.environment[name];
      snapshot.environment.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
      if (record.controller.signal.aborted) return;
      let staged = readFileSync(snapshot.configFile, "utf8");
      const header = record.view.profile === "default" ? "default" : `profile ${record.view.profile}`;
      if (!record.existing) {
        const fields = record.view.method === "sso" ? { sso_session: record.request.session!, cli_history: "disabled" } : { region: record.request.region!, cli_history: "disabled" };
        staged = patchIniSection(staged, header, fields, true);
        if (record.view.method === "sso") staged = patchIniSection(staged, `sso-session ${record.request.session}`, { sso_start_url: record.request.startUrl!, sso_region: record.request.ssoRegion!, sso_registration_scopes: "sso:account:access" }, true);
        writeFileSync(snapshot.configFile, staged, { mode: 0o600 });
      }
      const args = record.view.method === "login" ? ["login", "--profile", record.view.profile, "--region", record.request.region!, "--no-cli-pager", "--no-cli-auto-prompt"]
        : ["sso", "login", ...(record.root?.ssoSession || record.request.session ? ["--sso-session", (record.root?.ssoSession ?? record.request.session)!] : ["--profile", record.view.profile]), "--no-browser", "--no-cli-pager", "--no-cli-auto-prompt"];
      this.update(record, { state: "waiting-browser", message: "Waiting for the AWS CLI to open sign-in…" });
      const code = await this.run({ args, env: snapshot.environment, signal: record.controller.signal, onOutput: chunk => this.output(record, chunk), onInput: write => { record.write = write; } });
      if (record.controller.signal.aborted || record.view.state === "failed") return;
      if (code !== 0) throw new ConnectionInputError(422, /SignInLocalDevelopmentAccess|signin:AuthorizeOAuth2Access|signin:CreateOAuth2Token|AccessDenied/i.test(record.output) ? "AWS denied this sign-in. Ask your administrator to check sign-in permissions, including SignInLocalDevelopmentAccess for Console login." : "AWS sign-in did not complete. Retry or use the native terminal to diagnose this connection.");
      this.update(record, { state: "verifying", message: "Verifying the authenticated connection…", authorizationUrl: undefined, confirmation: undefined });
      const values = sectionValues(readFileSync(snapshot.configFile, "utf8"), header);
      if (record.view.method === "login") {
        if (!values.login_session || !new RegExp(`^${arnPattern}$`).test(values.login_session)) throw new ConnectionInputError(422, "The AWS CLI did not establish a Console session. Sign in again.");
        if (this.options.verify) await this.options.verify(record.view.profile, snapshot.environment);
        else await runPrivateAws(["sts", "get-caller-identity", "--profile", record.view.profile, "--region", record.request.region!, "--output", "json", "--no-cli-pager"], { env: connectionEnvironment(snapshot.environment, record.view.profile), snapshot: false, signal: record.controller.signal, timeoutMs: 30_000 });
        record.completed = { fields: { login_session: values.login_session, region: record.request.region! } };
      } else {
        if (!record.existing) {
          const fields = sectionValues(readFileSync(snapshot.configFile, "utf8"), `sso-session ${record.request.session}`);
          record.completed = { fields: { sso_session: record.request.session! }, session: { name: record.request.session!, fields: { sso_start_url: fields.sso_start_url!, sso_region: fields.sso_region!, sso_registration_scopes: "sso:account:access" } } };
        } else if (this.options.verify) await this.options.verify(record.view.profile, snapshot.environment);
        else await runPrivateAws(["sts", "get-caller-identity", "--profile", record.view.profile, ...(record.request.region ? ["--region", record.request.region] : []), "--output", "json", "--no-cli-pager"], { env: connectionEnvironment(snapshot.environment, record.view.profile), snapshot: false, signal: record.controller.signal, timeoutMs: 30_000 });
      }
      const changedLogin = record.view.method === "login" && record.root?.loginSession !== record.completed?.fields.login_session;
      if (record.view.method === "login") { snapshot.dispose(); record.snapshot = undefined; }
      else {
        // Account discovery needs only a session reference. Erase credential-bearing copies as soon as native authentication finishes.
        const sessionName = record.root?.ssoSession ?? record.request.session;
        if (sessionName) {
          const sessionFields = sectionValues(readFileSync(snapshot.configFile, "utf8"), `sso-session ${sessionName}`);
          let minimal = patchIniSection("", header, { sso_session: sessionName, cli_history: "disabled" }, true);
          minimal = patchIniSection(minimal, `sso-session ${sessionName}`, { sso_start_url: sessionFields.sso_start_url, sso_region: sessionFields.sso_region, sso_registration_scopes: "sso:account:access" }, true);
          writeFileSync(snapshot.configFile, minimal, { mode: 0o600 }); writeFileSync(snapshot.credentialsFile, "", { mode: 0o600 });
        } else { snapshot.dispose(); record.snapshot = undefined; }
      }
      this.update(record, { state: "complete", message: record.existing ? changedLogin ? "Authenticated with another identity. Review the profile change before saving it." : "Native sign-in completed. Test the connection to refresh its identity." : "Authenticated. Complete configuration and review the new profile.", reviewRequired: !record.existing || changedLogin });
      record.expiryTimer = setTimeout(() => { record.controller.abort(); record.snapshot?.dispose(); record.snapshot = undefined; this.sessions.delete(record.view.id); }, Math.max(1, 15 * 60_000 - (Date.now() - record.createdAt)));
      record.expiryTimer.unref();
      this.options.changed?.(record.view.affectedProfiles);
    } catch (error) {
      if (!record.controller.signal.aborted) this.update(record, { state: "failed", message: error instanceof ConnectionInputError ? error.message : "The native AWS authentication flow could not complete. Retry or use the terminal workflow." });
    } finally {
      clearTimeout(timer); record.output = ""; record.write = undefined;
      if (record.view.state !== "complete" && record.snapshot) { await record.snapshot.dispose(); record.snapshot = undefined; }
    }
  }
  get(id: string): AwsAuthenticationSession { return this.record(id).view; }
  private record(id: string): AuthRecord {
    const record = this.sessions.get(id);
    if (!record || Date.now() - record.createdAt > 15 * 60_000) throw new ConnectionInputError(404, "This authentication session expired. Start sign-in again.");
    return record;
  }
  confirm(id: string, accepted: boolean) {
    const record = this.record(id);
    if (record.view.state !== "confirmation-required" || !record.write || typeof accepted !== "boolean") throw new ConnectionInputError(409, "There is no pending identity-change confirmation.");
    record.write(accepted ? "y\n" : "n\n");
    record.output = "";
    this.update(record, { state: accepted ? "verifying" : "canceled", message: accepted ? "Completing native sign-in…" : "The identity change was declined.", confirmation: undefined, authorizationUrl: undefined });
    if (!accepted) record.controller.abort();
    return record.view;
  }
  cancel(id: string) {
    const record = this.record(id);
    if (active(record.view)) { this.update(record, { state: "canceled", message: "Sign-in was canceled. Native shared caches may already have changed.", authorizationUrl: undefined, confirmation: undefined }); record.controller.abort(); }
    else if (record.view.state === "complete") {
      record.snapshot?.dispose(); record.snapshot = undefined; record.controller.abort(); record.completed = undefined;
      this.update(record, { state: "canceled", message: "Connection setup was canceled. Native shared authentication caches may remain available.", reviewRequired: false, authorizationUrl: undefined, confirmation: undefined });
    }
    return record.view;
  }
  releaseConfiguration(id: string) {
    const record = this.sessions.get(id);
    if (record) { record.snapshot?.dispose(); record.snapshot = undefined; if (record.expiryTimer) clearTimeout(record.expiryTimer); this.sessions.delete(id); }
  }
  configuration(id: string, name: string): AuthenticatedConfiguration | undefined {
    const record = this.record(id);
    if (record.view.state !== "complete" || record.view.profile !== name) throw new ConnectionInputError(409, "Complete authentication for this profile before reviewing its configuration.");
    return record.completed;
  }
  private async ssoClient(id: string) {
    const record = this.record(id);
    if (record.view.method !== "sso" || record.view.state !== "complete" || !record.snapshot) throw new ConnectionInputError(409, "Complete Identity Center sign-in before choosing an account and role.");
    const session = record.root?.ssoSession ?? record.request.session;
    const region = record.request.ssoRegion ?? record.catalog.sessions.find(entry => entry.name === session)?.region ?? record.root?.configuration.sso_region;
    if (!region) throw new ConnectionInputError(422, "This session has no Identity Center region.");
    try {
      const token = await fromSso({ profile: record.view.profile, configFilepath: record.snapshot.configFile, filepath: record.snapshot.credentialsFile, ignoreCache: true, clientConfig: { ignoreConfiguredEndpointUrls: true, requestHandler: { connectionTimeout: 5_000, requestTimeout: 20_000 }, maxAttempts: 1 } })();
      return { token: token.token, client: new SSOClient({ region, maxAttempts: 2, ignoreConfiguredEndpointUrls: true, requestHandler: { connectionTimeout: 5_000, requestTimeout: 20_000 } }), signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(30_000)]) };
    } catch { throw new ConnectionInputError(422, "The Identity Center session is unavailable. Sign in again before choosing an account."); }
  }
  async accounts(id: string) {
    const { token, client, signal } = await this.ssoClient(id);
    const accounts: { accountId: string; accountName?: string }[] = [];
    const seen = new Set<string>(); let nextToken: string | undefined;
    try {
      do {
        const result = await client.send(new ListAccountsCommand({ accessToken: token, nextToken }), { abortSignal: signal });
        for (const account of result.accountList ?? []) if (account.accountId && /^\d{12}$/.test(account.accountId)) accounts.push({ accountId: account.accountId, ...(account.accountName ? { accountName: account.accountName } : {}) });
        nextToken = result.nextToken;
        if (nextToken && seen.has(nextToken)) throw new Error();
        if (nextToken) seen.add(nextToken);
      } while (nextToken && accounts.length < 2000);
      return { accounts };
    } catch { throw new ConnectionInputError(422, "Assigned AWS accounts could not be listed. Check the Identity Center session and assignments."); }
    finally { client.destroy(); }
  }
  async roles(id: string, account: string) {
    if (!/^\d{12}$/.test(account)) throw new ConnectionInputError(400, "Choose an AWS account.");
    const { token, client, signal } = await this.ssoClient(id);
    const roles: { roleName: string }[] = []; const seen = new Set<string>(); let nextToken: string | undefined;
    try {
      do {
        const result = await client.send(new ListAccountRolesCommand({ accessToken: token, accountId: account, nextToken }), { abortSignal: signal });
        for (const role of result.roleList ?? []) if (role.roleName) roles.push({ roleName: role.roleName });
        nextToken = result.nextToken; if (nextToken && seen.has(nextToken)) throw new Error(); if (nextToken) seen.add(nextToken);
      } while (nextToken && roles.length < 2000);
      return { roles };
    } catch { throw new ConnectionInputError(422, "Assigned permission sets could not be listed for this account. Check your Identity Center assignments."); }
    finally { client.destroy(); }
  }
  private async expire() {
    for (const [id, record] of this.sessions) if (Date.now() - record.createdAt > 15 * 60_000) { record.controller.abort(); if (record.expiryTimer) clearTimeout(record.expiryTimer); await record.task; await record.snapshot?.dispose(); this.sessions.delete(id); }
  }
  async dispose() {
    for (const record of this.sessions.values()) { record.controller.abort(); if (record.expiryTimer) clearTimeout(record.expiryTimer); }
    await Promise.allSettled([...this.sessions.values()].map(async record => { await record.task; await record.snapshot?.dispose(); record.release?.(); }));
    this.sessions.clear(); this.keys.clear();
  }
}
