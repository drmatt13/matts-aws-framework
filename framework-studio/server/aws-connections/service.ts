import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { AwsConnectionError, awsIdentity, connectionEnvironment, loadAwsCatalog, problem, readAwsFiles, resolveAwsRegion, runPrivateAws } from "../../../scripts/aws-connections";
import { isAwsProfileName, type AwsConnectionObservation, type AwsProfileCatalog } from "../../shared/aws-connections";
import type { AwsAuthenticationRequest, AwsCliCapabilities, AwsLogoutReview, AwsProfileChangeRequest } from "../../shared/aws-connection-management";
import { AuthenticationCoordinator, profileDependents, type AuthenticationOptions } from "./authentication";
import { awsPaths, ConnectionInputError, ProfileConfiguration } from "./configuration";
import { ProfileDeletion } from "./deletion";

export interface AwsConnectionsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: typeof runPrivateAws;
  readonly authentication?: Omit<AuthenticationOptions, "env" | "changed">;
  readonly busy?: (profiles: readonly string[]) => boolean;
  readonly changed?: (profiles: readonly string[]) => void;
  readonly watch?: boolean;
}
interface CheckCache { at: number; observation?: AwsConnectionObservation; pending?: Promise<AwsConnectionObservation>; forced?: boolean }
export class AwsConnectionsService {
  readonly authentication: AuthenticationCoordinator;
  readonly configuration: ProfileConfiguration;
  readonly deletion: ProfileDeletion;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: typeof runPrivateAws;
  private readonly checks = new Map<string, CheckCache>();
  private readonly lastGood = new Map<string, AwsConnectionObservation>();
  private readonly logoutReviews = new Map<string, { view: AwsLogoutReview; revision: string }>();
  private readonly reviewAuthentications = new Map<string, string>();
  private capabilities?: { at: number; value: Promise<AwsCliCapabilities> };
  private revision?: string;
  private readonly watchers: FSWatcher[] = [];
  private readonly controller = new AbortController();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private credentialMutation = false;
  get hasCredentialMutation(): boolean { return this.credentialMutation; }
  constructor(readonly root: string, private readonly options: AwsConnectionsOptions = {}) {
    this.env = options.env ?? process.env; this.run = options.run ?? runPrivateAws;
    this.authentication = new AuthenticationCoordinator({ ...options.authentication, env: this.env, changed: profiles => this.invalidate(profiles) });
    this.configuration = new ProfileConfiguration(this.env, profiles => this.busy(profiles));
    this.deletion = new ProfileDeletion(this.env, profiles => this.busy(profiles));
    if (options.watch !== false) {
      const paths = awsPaths(this.env);
      for (const directory of new Set([path.dirname(paths.config), path.dirname(paths.credentials)])) if (existsSync(directory)) {
        try {
          const watcher = watch(directory, { persistent: false }, (_event, file) => {
            if (file && ![path.basename(paths.config), path.basename(paths.credentials)].includes(String(file))) return;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.invalidate(); }, 150);
            this.refreshTimer.unref();
          });
          watcher.on("error", () => { /* On-demand revision checks remain authoritative. */ });
          this.watchers.push(watcher);
        } catch { /* Missing/watch-restricted paths are checked on demand. */ }
      }
    }
  }
  private busy(profiles: readonly string[]) { return this.credentialMutation || Boolean(this.options.busy?.(profiles)) || this.authentication.isBusy(profiles); }
  async catalog(): Promise<AwsProfileCatalog & { readonly capabilities: AwsCliCapabilities }> {
    const catalog = await loadAwsCatalog(this.env);
    if (this.revision && this.revision !== catalog.revision) this.invalidate();
    this.revision = catalog.revision;
    return { ...catalog, capabilities: await this.cliCapabilities() };
  }
  async cliCapabilities(): Promise<AwsCliCapabilities> {
    if (this.capabilities && Date.now() - this.capabilities.at < 5 * 60_000) return this.capabilities.value;
    const value = this.run(["--version"], { env: this.env, snapshot: false, timeoutMs: 5_000, signal: this.controller.signal }).then(result => {
      const version = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout} ${result.stderr}`);
      const major = Number(version?.[1]), minor = Number(version?.[2]);
      const atLeast = (minimum: number) => major > 2 || major === 2 && minor >= minimum;
      return { available: Boolean(version), ...(version ? { version: `${version[1]}.${version[2]}.${version[3]}` } : {}), credentialExport: atLeast(9), modernSso: atLeast(9), pkce: atLeast(22), consoleLogin: atLeast(32) };
    }).catch(() => ({ available: false, credentialExport: false, modernSso: false, pkce: false, consoleLogin: false }));
    this.capabilities = { at: Date.now(), value }; return value;
  }
  async check(profile: string, force = false): Promise<AwsConnectionObservation> {
    if (!isAwsProfileName(profile)) throw new ConnectionInputError(400, "Choose an AWS profile.");
    const catalog = await loadAwsCatalog(this.env);
    const descriptor = catalog.profiles.find(entry => entry.name === profile);
    const region = resolveAwsRegion(profile, undefined, this.env);
    const base = { profile, revision: catalog.revision, region };
    const known = this.lastGood.get(profile)?.identity;
    const key = JSON.stringify([profile, catalog.revision, region.value]);
    const cached = this.checks.get(key);
    if (cached?.pending) return force && !cached.forced ? cached.pending.then(() => this.check(profile, true)) : cached.pending;
    if (cached?.observation && !force && Date.now() - cached.at < (cached.observation.state === "connected" ? 30_000 : 5_000)) return cached.observation;
    const record: CheckCache = { at: Date.now(), forced: force };
    const pending = (async (): Promise<AwsConnectionObservation> => {
      const checkedAt = new Date().toISOString();
      try {
        if (!descriptor) throw new AwsConnectionError(problem("profile"));
        const env = connectionEnvironment(this.env, profile);
        // A claimed endpoint must never establish trusted AWS account evidence.
        for (const name of Object.keys(env)) if (name === "AWS_ENDPOINT_URL" || name.startsWith("AWS_ENDPOINT_URL_")) delete env[name];
        env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
        const result = await this.run(["sts", "get-caller-identity", "--profile", profile, ...(region.value ? ["--region", region.value] : []), "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt", "--cli-connect-timeout", "5", "--cli-read-timeout", "20"], { env, timeoutMs: 30_000, signal: this.controller.signal, cwd: this.root });
        const parsed = JSON.parse(result.stdout);
        if (typeof parsed.Account !== "string" || !/^\d{12}$/.test(parsed.Account) || typeof parsed.Arn !== "string" || !new RegExp(`^arn:aws(?:-[a-z]+)*:(?:iam|sts)::${parsed.Account}:[A-Za-z0-9_+=,.@/:-]+$`).test(parsed.Arn)) throw new AwsConnectionError(problem("failed"));
        let credentialExpiration: AwsConnectionObservation["credentialExpiration"];
        if (force) {
          try {
            // This optional native-provider observation is private and separate from the successful STS identity check.
            const exported = await this.run(["configure", "export-credentials", "--profile", profile, "--format", "process", "--no-cli-pager", "--no-cli-auto-prompt", "--cli-connect-timeout", "3", "--cli-read-timeout", "5"], { env, timeoutMs: 5_000, signal: this.controller.signal, cwd: this.root });
            const credentials = JSON.parse(exported.stdout);
            const expiration = typeof credentials?.Expiration === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(credentials.Expiration) ? Date.parse(credentials.Expiration) : NaN;
            if (credentials?.Version === 1 && typeof credentials.AccessKeyId === "string" && credentials.AccessKeyId && typeof credentials.SecretAccessKey === "string" && credentials.SecretAccessKey && Number.isFinite(expiration) && expiration > Date.now()) credentialExpiration = { at: new Date(expiration).toISOString(), source: "native-export" };
          } catch { /* Unsupported export or unavailable expiration does not negate verified identity. */ }
        }
        if (readAwsFiles(this.env).revision !== catalog.revision) throw new AwsConnectionError(problem("configuration"));
        const observation: AwsConnectionObservation = { ...base, checkedAt, state: "connected", identity: awsIdentity(parsed.Account, parsed.Arn), ...(credentialExpiration ? { credentialExpiration } : {}) };
        this.lastGood.set(profile, observation);
        return observation;
      } catch (error) {
        const issue = error instanceof AwsConnectionError ? error.problem : problem("failed");
        const state = ["expired", "no-credentials", "mfa-required"].includes(issue.code) ? "needs-auth" : ["configuration", "profile", "missing-region"].includes(issue.code) ? "configuration-error" : "unavailable";
        return { ...base, checkedAt, state, ...(known ? { lastKnownIdentity: known } : {}), problem: issue };
      }
    })();
    record.pending = pending; this.checks.set(key, record);
    const observation = await pending;
    record.pending = undefined; record.observation = observation; record.at = Date.now();
    return observation;
  }
  invalidate(profiles?: readonly string[]) {
    for (const [key, value] of this.checks) if (!profiles || !value.observation || profiles.includes(value.observation.profile)) this.checks.delete(key);
    this.logoutReviews.clear();
    this.options.changed?.(profiles ?? []);
  }
  async startAuthentication(request: AwsAuthenticationRequest) {
    if (this.credentialMutation) throw new ConnectionInputError(409, "Native sign-out is in progress. Wait before signing in again.");
    const catalog = await this.catalog();
    return this.authentication.start(request, catalog, catalog.capabilities);
  }
  async review(input: AwsProfileChangeRequest) {
    const catalog = await loadAwsCatalog(this.env);
    const descriptor = catalog.profiles.find(profile => profile.name === input?.name);
    if (descriptor && !descriptor.editable) throw new ConnectionInputError(422, descriptor.provenance.readOnlyReason ?? "This profile is read-only. Edit it through its native configuration manager.");
    const affected = profileDependents(catalog, [input?.name]);
    const authenticated = input?.authenticationId ? this.authentication.configuration(input.authenticationId, input.name) : undefined;
    const review = this.configuration.review(input, catalog.profiles.map(profile => profile.name), affected, authenticated);
    if (input.authenticationId) this.reviewAuthentications.set(review.id, input.authenticationId);
    return review;
  }
  async apply(reviewId: string) {
    const result = this.configuration.apply(reviewId);
    const authenticationId = this.reviewAuthentications.get(reviewId);
    if (authenticationId) { this.authentication.releaseConfiguration(authenticationId); this.reviewAuthentications.delete(reviewId); }
    const catalog = await loadAwsCatalog(this.env).catch(() => undefined);
    this.invalidate(catalog ? profileDependents(catalog, [result.name]) : undefined);
    return result;
  }
  deleteReview(profile: string) { return this.deletion.review(profile); }
  async deleteApply(reviewId: string) {
    const review = this.deletion.get(reviewId);
    if (review.blockers.length) return this.deletion.apply(reviewId);
    const catalog = await loadAwsCatalog(this.env).catch(() => { throw new ConnectionInputError(409, "AWS configuration could not be validated. Refresh and review deletion again; nothing was written."); });
    // Malformed role sources cannot start native authentication; let users remove
    // those broken profiles without asking rootProfile to resolve an invalid chain.
    const profile = catalog.profiles.find(entry => entry.name === review.name);
    const invalidChain = profile?.diagnostics.some(issue => ["role-cycle", "missing-source-profile"].includes(issue.code));
    const release = this.authentication.lockProfiles(catalog, invalidChain ? [] : [review.name]);
    try {
      const result = this.deletion.apply(reviewId);
      this.lastGood.delete(result.name);
      this.invalidate([result.name]);
      return result;
    } finally { release(); }
  }
  discard(reviewId: string) {
    this.configuration.discard(reviewId); this.deletion.discard(reviewId);
    this.reviewAuthentications.delete(reviewId);
    return { discarded: true };
  }
  async logoutReview(profile: string): Promise<AwsLogoutReview> {
    const catalog = await loadAwsCatalog(this.env);
    const descriptor = catalog.profiles.find(entry => entry.name === profile);
    if (!descriptor) throw new ConnectionInputError(400, "Choose an AWS profile.");
    let root = descriptor; const seen = new Set<string>();
    while (root.sourceProfile && !seen.has(root.name)) { seen.add(root.name); const next = catalog.profiles.find(entry => entry.name === root.sourceProfile); if (!next) break; root = next; }
    if (root.kind !== "sso" && root.kind !== "login") throw new ConnectionInputError(422, "This profile has no native browser session to sign out. Use its provider's own session controls.");
    const roots = catalog.profiles.filter(entry => root.kind === "sso" ? entry.kind === "sso" : root.loginSession ? entry.loginSession === root.loginSession : entry.name === root.name).map(entry => entry.name);
    const affectedProfiles = profileDependents(catalog, roots);
    if (this.busy(affectedProfiles)) throw new ConnectionInputError(409, "An affected profile is in use. Wait for its operation or sign-in to finish before signing out.");
    const view: AwsLogoutReview = { id: randomUUID(), profile: root.name, method: root.kind, affectedProfiles, message: root.kind === "sso" ? "Sign out of all Identity Center sessions on this machine. Other AWS tools and profiles are affected. Already-issued role sessions may remain valid until they expire." : "Sign out of this shared Console login session. Other profiles and tools using it are affected. Already-issued role sessions may remain valid until they expire.", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    this.logoutReviews.set(view.id, { view, revision: catalog.revision }); return view;
  }
  async logoutApply(id: string) {
    const review = this.logoutReviews.get(id);
    const catalog = await loadAwsCatalog(this.env);
    if (!review || Date.parse(review.view.expiresAt) <= Date.now() || review.revision !== catalog.revision) throw new ConnectionInputError(409, "This sign-out review expired or configuration changed. Review its impact again.");
    if (this.busy(review.view.affectedProfiles)) throw new ConnectionInputError(409, "An affected profile is in use. Wait before signing out.");
    const release = this.authentication.lockProfiles(catalog, review.view.affectedProfiles);
    this.credentialMutation = true;
    try {
      const args = review.view.method === "sso" ? ["sso", "logout", "--profile", review.view.profile] : ["logout", "--profile", review.view.profile];
      await this.run([...args, "--no-cli-pager", "--no-cli-auto-prompt"], { env: this.env, timeoutMs: 30_000, signal: this.controller.signal, cwd: this.root });
      this.invalidate(review.view.affectedProfiles);
      return { signedOut: true, affectedProfiles: review.view.affectedProfiles, message: "Native shared-session sign-out completed. Already-issued role sessions may remain valid." };
    } catch { throw new ConnectionInputError(422, "Native sign-out could not be confirmed. Test the affected connections before relying on their status."); }
    finally { this.credentialMutation = false; release(); }
  }
  async dispose() {
    this.controller.abort(); if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.close();
    await this.authentication.dispose(); this.configuration.dispose(); this.deletion.dispose(); this.checks.clear(); this.logoutReviews.clear();
    this.reviewAuthentications.clear();
  }
}
