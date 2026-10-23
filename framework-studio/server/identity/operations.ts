import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { CognitoAction, CognitoOperation, CognitoOperationRecord, CognitoOperationResult, CognitoOperationReview, VerifiedCognitoTarget } from "../../shared/identity-operations";
import type { IdentitySelection } from "../../shared/identity";
import { EditError } from "../edits/io";
import { sha256 } from "../files";
import { sendJson } from "../http";
import { runCommand, studioEnvironment, Tools, type Runner } from "../deploy/process";
import type { IdentityService } from "./service";
import { ExternalCognitoReferenceError } from "./ownership";

const ACTIONS: readonly CognitoAction[] = ["create-user", "create-group", "add-to-group", "remove-from-group", "enable-user", "disable-user"];
const REJECTED = new Set(["AccessDeniedException", "NotAuthorizedException", "UserNotFoundException", "ResourceNotFoundException", "UsernameExistsException", "GroupExistsException", "AliasExistsException", "InvalidParameterException", "InvalidPasswordException", "TooManyRequestsException", "LimitExceededException"]);
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/.test(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export function readCognitoOperation(raw: unknown): CognitoOperation {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !ACTIONS.includes(value.action as CognitoAction)) throw new EditError(400, "Choose a supported Cognito user or group action. Password, reset and delete-user operations are unavailable.");
  const keys = value.action === "create-user" ? ["action", "username", "email", "givenName", "familyName"] : value.action === "create-group" ? ["action", "group", "description"] : ["add-to-group", "remove-from-group"].includes(String(value.action)) ? ["action", "username", "group"] : ["action", "username"];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new EditError(400, "This operation contains unsupported or missing fields. Pool IDs, credentials, role assignments and arbitrary attributes are not accepted.");
  if ("username" in value && !name(value.username) || "group" in value && !name(value.group)) throw new EditError(400, "Use a user/group name of 1–128 letters, numbers, dots, @, plus, minus or underscores, starting with a letter or number.");
  if (value.action === "create-user" && (!text(value.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || !text(value.givenName, 128) || !value.givenName.trim() || !text(value.familyName, 128) || !value.familyName.trim())) throw new EditError(400, "Provide an email address and nonempty given/family names. Email verification is not asserted by this tool.");
  if (value.action === "create-group" && !text(value.description, 256)) throw new EditError(400, "Use a group description of at most 256 characters without control characters.");
  return { ...value } as unknown as CognitoOperation;
}

function guardedDirectory(directory: string): string {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "Cognito operation state cannot traverse symbolic links. Inspect the selected state directory."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  return absolute;
}
function syncDirectory(directory: string) {
  let descriptor: number | undefined;
  try { descriptor = openSync(directory, "r"); fsyncSync(descriptor); }
  catch (error) { if (!["EINVAL", "ENOTSUP", ...(process.platform === "win32" ? ["EPERM", "EACCES", "EISDIR", "EBADF"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
interface SubjectState {
  user?: { username: string; enabled: boolean; status?: string; created?: string; modified?: string; attributes?: readonly { Name: string; Value: string }[] };
  group?: { name: string; roleArn?: string; precedence?: number; created?: string; modified?: string };
  groups?: readonly { name: string; roleArn?: string; precedence?: number }[];
}
interface StoredReview { readonly view: CognitoOperationReview; readonly fingerprint: string }
class ReadFailure extends Error { constructor(readonly code: string) { super("Cognito read could not establish the operation precondition."); } }

/** Reviewed, fixed Cognito operations. No password is accepted/generated locally,
 * no command result body is persisted, and AWS/CLI automatic retries are disabled. */
export class CognitoOperations {
  private readonly reviews = new Map<string, StoredReview>();
  private readonly tools: Tools;
  private readonly directory: string;
  private readonly active = new Set<string>();
  constructor(private readonly root: string, private readonly identity: Pick<IdentityService, "verifiedUserPool">, private readonly run: Runner = runCommand, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.tools = new Tools(root, env);
    this.directory = guardedDirectory(path.join(env.FRAMEWORK_STUDIO_STATE_DIRECTORY ?? path.join(root, ".cache/framework-studio"), "cognito-operations"));
  }
  history(): CognitoOperationRecord[] {
    guardedDirectory(this.directory); if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(file => /^[a-f0-9-]+\.json$/.test(file)).map(file => {
      try {
        const absolute = path.join(this.directory, file); if (lstatSync(absolute).isSymbolicLink()) throw new Error();
        const record = JSON.parse(readFileSync(absolute, "utf8")) as CognitoOperationRecord;
        if (!record.id || !ACTIONS.includes(record.action) || !["running", "applied", "unchanged", "rejected", "unconfirmed"].includes(record.status)) throw new Error();
        return record.status === "running" && !this.active.has(record.id) ? { ...record, status: "unconfirmed" as const, verification: "unverified" as const, message: "The previous process did not establish an outcome, or another process may still be active. Inspect the exact pool and operation before retrying; writes are never replayed." } : record;
      } catch { return { id: file.slice(0, -5), reviewId: "unknown", action: "create-user" as const, profile: "unknown", deployment: "unknown", account: "unknown", region: "unknown", mode: "dev" as const, poolId: "unknown", subjectDigest: "unknown", startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), status: "unconfirmed" as const, verification: "unverified" as const, message: "A Cognito operation record is unreadable. Preserve it and inspect the pool; this does not prove that no earlier write occurred." }; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).filter((record, index) => index < 50 || ["running", "unconfirmed"].includes(record.status));
  }
  private persist(record: CognitoOperationRecord) {
    guardedDirectory(this.directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${record.id}.json`), temporary = `${file}.${randomUUID()}.tmp`, descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(record)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, file); syncDirectory(this.directory);
  }
  private lock(target: VerifiedCognitoTarget): () => void {
    guardedDirectory(this.directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `pool-${sha256([target.account, target.region, target.poolId].join("|"))}.lock`), token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    let descriptor: number;
    try { descriptor = openSync(file, "wx", 0o600); }
    catch { throw new EditError(409, "Another Cognito operation or unrecovered pool lock exists. Inspect operation history and the exact pool before retrying; stale locks are not automatically reclaimed."); }
    try { writeFileSync(descriptor, token); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    syncDirectory(this.directory);
    return () => { try { if (readFileSync(file, "utf8") === token) { unlinkSync(file); syncDirectory(this.directory); } } catch { /* Preserve an unknown/concurrently replaced lock. */ } };
  }
  private async call(target: VerifiedCognitoTarget, operation: string, args: readonly string[], query?: string) {
    // MAX_ATTEMPTS includes the initial request. A timeout is not permission to retry.
    const env = { ...studioEnvironment(this.env, { profile: target.profile }), AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard" };
    return this.run(this.tools.aws(["cognito-idp", operation, "--user-pool-id", target.poolId, ...args, "--profile", target.profile, "--region", target.region, "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "20", ...(query ? ["--query", query] : [])], env), { timeoutMs: 30_000 });
  }
  private code(stderr: string): string { return /\(([A-Za-z][A-Za-z0-9]{1,80})\)/.exec(stderr)?.[1] ?? "AWS_OUTCOME_UNCONFIRMED"; }
  private async destination(selection: IdentitySelection): Promise<VerifiedCognitoTarget> {
    try { const target = await this.identity.verifiedUserPool(selection); if (!target.actorArn || !new RegExp(`^arn:aws:(?:iam|sts)::${target.account}:`).test(target.actorArn)) throw new Error(); return target; }
    catch (error) { if (error instanceof ExternalCognitoReferenceError) throw error; throw new EditError(422, "Could not verify exactly one deployment-owned Cognito pool in the selected account/region. Check credentials, target ownership and read permissions. No user/group write was requested."); }
  }
  private async read(target: VerifiedCognitoTarget, operation: string, args: readonly string[], query: string, absent?: string): Promise<any | undefined> {
    const result = await this.call(target, operation, args, query);
    if (result.code !== 0) { const code = this.code(result.stderr); if (code === absent) return undefined; throw new ReadFailure(code); }
    try { const parsed = JSON.parse(result.stdout); if (parsed === null || parsed === undefined) throw new Error(); return parsed; } catch { throw new ReadFailure("INVALID_AWS_RESPONSE"); }
  }
  private async subject(target: VerifiedCognitoTarget, operation: CognitoOperation): Promise<SubjectState> {
    const state: SubjectState = {};
    if ("username" in operation) {
      state.user = await this.read(target, "admin-get-user", ["--username", operation.username], "{username:Username,enabled:Enabled,status:UserStatus,created:UserCreateDate,modified:UserLastModifiedDate,attributes:UserAttributes[?Name=='sub']}", "UserNotFoundException");
      if (operation.action !== "create-user" && !state.user) throw new EditError(409, "The selected user no longer exists. Inspect the pool before reviewing another action.");
      if (operation.action === "create-user" && state.user) throw new EditError(409, "That user already exists. Studio will not overwrite it or resend an invitation.");
    }
    if ("group" in operation) {
      state.group = await this.read(target, "get-group", ["--group-name", operation.group], "Group.{name:GroupName,roleArn:RoleArn,precedence:Precedence,created:CreationDate,modified:LastModifiedDate}", "ResourceNotFoundException");
      if (operation.action !== "create-group" && !state.group) throw new EditError(409, "The selected group no longer exists. Inspect the pool before reviewing membership.");
      if (operation.action === "create-group" && state.group) throw new EditError(409, "That group already exists. Studio will not overwrite its role or precedence.");
    }
    if (operation.action === "add-to-group" || operation.action === "remove-from-group") {
      const groups = await this.read(target, "admin-list-groups-for-user", ["--username", operation.username], "Groups[].{name:GroupName,roleArn:RoleArn,precedence:Precedence}");
      if (!Array.isArray(groups) || groups.some(group => !group || typeof group.name !== "string")) throw new ReadFailure("INVALID_AWS_RESPONSE");
      state.groups = groups.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    }
    if (state.user && (typeof state.user.username !== "string" || typeof state.user.enabled !== "boolean")) throw new ReadFailure("INVALID_AWS_RESPONSE");
    if (state.group && state.group.name !== (operation as { group?: string }).group) throw new ReadFailure("INVALID_AWS_RESPONSE");
    return state;
  }
  private fingerprint(target: VerifiedCognitoTarget, state: SubjectState) { return sha256(JSON.stringify({ target: target.fingerprint, state })); }
  async review(selection: IdentitySelection, raw: unknown): Promise<CognitoOperationReview> {
    const operation = readCognitoOperation(raw), target = await this.destination(selection);
    if (operation.action === "create-user") {
      if (target.passwordless) throw new EditError(422, "This pool enables passwordless OTP factors. Studio's suppressed, Cognito-generated temporary-password creation flow is unavailable; no passwordless account is silently created.");
      if (target.requiredAttributes.some(name => !["email", "given_name", "family_name"].includes(name))) throw new EditError(422, "This pool requires additional attributes. Use its approved native administration workflow; this form supports the application's email/given-name/family-name schema only.");
    }
    let state: SubjectState;
    try { state = await this.subject(target, operation); }
    catch (error) { if (error instanceof EditError) throw error; throw new EditError(422, "Cognito could not establish the exact user/group precondition. Check read permissions and inspect the selected pool. No writes were requested."); }
    const member = "group" in operation && !!state.groups?.some(group => group.name === operation.group);
    const noEffect = operation.action === "enable-user" && state.user?.enabled === true || operation.action === "disable-user" && state.user?.enabled === false || operation.action === "add-to-group" && member || operation.action === "remove-from-group" && !member;
    const subject = "username" in operation ? `user ${operation.username}${"group" in operation ? ` / group ${operation.group}` : ""}` : `group ${operation.group}`;
    const subjectDigest = sha256(JSON.stringify({ username: "username" in operation ? operation.username : null, group: "group" in operation ? operation.group : null }));
    const view: CognitoOperationReview = { id: randomUUID(), subjectDigest, target, operation, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), noEffect,
      confirmation: `${operation.action} ${subject} in ${target.poolId} account ${target.account}`,
      ...(target.mode === "prod" ? { productionConfirmation: `AUTHORIZE PRODUCTION ${operation.action} ${subject} in ${target.poolId} account ${target.account} region ${target.region}` } : {}),
      before: { ...(state.user ? { user: { username: state.user.username, enabled: state.user.enabled, status: state.user.status } } : {}), ...(state.group ? { group: { name: state.group.name, roleArn: state.group.roleArn, precedence: state.group.precedence } } : {}), ...(state.groups ? { member } : {}) },
      effects: [noEffect ? "Current observed state already matches this request. Apply rechecks it and records unchanged without an AWS write." : `Calls exactly one Cognito ${operation.action} operation after rechecking the owned pool and user/group fingerprint.`,
        ...(operation.action === "create-user" ? ["Cognito generates a temporary password server-side; invitations are suppressed. Studio never receives, returns or stores that password. The user cannot complete sign-in through this tool; password/reset operations are unavailable.", "Email is not marked verified and aliases are never reassigned. Application database user rows and successful sign-in are separate outcomes."] : []),
        ...(operation.action === "create-group" ? ["Creates a group without an IAM role or precedence assignment. Policy authoring remains a separate source review."] : []),
        ...(["add-to-group", "remove-from-group"].includes(operation.action) ? ["Membership changes future Cognito token claims and can affect application RBAC and identity-pool IAM role selection. Existing issued tokens can remain valid; no effective IAM permission test is implied.", ...(state.group?.roleArn ? [`This group carries IAM role ${state.group.roleArn}, precedence ${state.group.precedence ?? "unspecified"}. Review the role's actual permissions before approval.`] : [])] : []),
        ...(operation.action === "disable-user" ? ["Disables this Cognito account and affects future authentication. Already issued JWTs can remain accepted until expiration; Studio does not revoke every application's cached authorization."] : []),
        ...(target.triggers.length ? [`Configured pool triggers can execute: ${target.triggers.join(", ")}. Suppressing invitations does not guarantee arbitrary trigger code has no side effects.`] : []),
        "An AWS acknowledgement and a follow-up metadata check are reported separately. Timeout/connection loss leaves an uncertain outcome; writes are never automatically retried. Persistent history excludes user/email/group inputs and raw AWS output."] };
    if (this.reviews.size >= 20) this.reviews.clear(); this.reviews.set(view.id, { view, fingerprint: this.fingerprint(target, state) }); return view;
  }
  private writeArgs(operation: CognitoOperation): { operation: string; args: string[]; query?: string } {
    switch (operation.action) {
      case "create-user": return { operation: "admin-create-user", args: ["--username", operation.username, "--message-action", "SUPPRESS", "--no-force-alias-creation", "--user-attributes", JSON.stringify([{ Name: "email", Value: operation.email }, { Name: "given_name", Value: operation.givenName }, { Name: "family_name", Value: operation.familyName }])], query: "User.{username:Username,status:UserStatus,enabled:Enabled}" };
      case "create-group": return { operation: "create-group", args: ["--group-name", operation.group, "--description", operation.description], query: "Group.{name:GroupName}" };
      case "add-to-group": case "remove-from-group": return { operation: operation.action === "add-to-group" ? "admin-add-user-to-group" : "admin-remove-user-from-group", args: ["--username", operation.username, "--group-name", operation.group] };
      case "enable-user": case "disable-user": return { operation: operation.action === "enable-user" ? "admin-enable-user" : "admin-disable-user", args: ["--username", operation.username] };
    }
  }
  private async observed(target: VerifiedCognitoTarget, operation: CognitoOperation): Promise<boolean> {
    if (operation.action === "create-user") return !!await this.read(target, "admin-get-user", ["--username", operation.username], "{username:Username}", "UserNotFoundException");
    if (operation.action === "create-group") return !!await this.read(target, "get-group", ["--group-name", operation.group], "Group.{name:GroupName}", "ResourceNotFoundException");
    const state = await this.subject(target, operation);
    if (operation.action === "enable-user" || operation.action === "disable-user") return state.user?.enabled === (operation.action === "enable-user");
    return "group" in operation && !!state.groups?.some(group => group.name === operation.group) === (operation.action === "add-to-group");
  }
  async apply(id: string, confirmation: string, productionConfirmation?: string): Promise<CognitoOperationResult> {
    const stored = this.reviews.get(id);
    if (!stored || Date.parse(stored.view.expiresAt) <= Date.now()) throw new EditError(409, "This Cognito operation review expired or was consumed. Inspect and review again; nothing was requested.");
    const { view } = stored;
    if (confirmation !== view.confirmation || view.productionConfirmation && productionConfirmation !== view.productionConfirmation) throw new EditError(400, "Type the exact action/user/pool/account confirmation and, for production, its separate operation-specific authorization.");
    this.reviews.delete(id);
    const release = this.lock(view.target);
    let record: CognitoOperationRecord | undefined;
    let writeStarted = false, acknowledged = false;
    try {
      const target = await this.destination(view.target);
      const state = await this.subject(target, view.operation);
      if (target.mode !== view.target.mode || this.fingerprint(target, state) !== stored.fingerprint) throw new EditError(409, "The pool, credentials, required configuration or user/group state changed after review. No write was requested; inspect and review again.");
      const now = new Date().toISOString();
      record = { id: randomUUID(), reviewId: id, action: view.operation.action, profile: target.profile, deployment: target.deployment, account: target.account, region: target.region, mode: target.mode, poolId: target.poolId, actorArn: target.actorArn, subjectDigest: view.subjectDigest, startedAt: now, updatedAt: now, status: "running", verification: "unverified", message: "The reviewed Cognito operation is in progress; no outcome is established yet." };
      this.active.add(record.id); this.persist(record);
      if (view.noEffect) { record = { ...record, status: "unchanged", verification: "observed", message: "Fresh metadata already matches the reviewed request. No AWS write was sent." }; }
      else {
        const command = this.writeArgs(view.operation); writeStarted = true;
        const result = await this.call(target, command.operation, command.args, command.query);
        if (result.code !== 0) { const code = result.missing ? "AWS_CLI_NOT_STARTED" : this.code(result.stderr); record = { ...record, status: result.missing || REJECTED.has(code) ? "rejected" : "unconfirmed", ...(REJECTED.has(code) || code === "AWS_CLI_NOT_STARTED" ? { code } : {}), message: REJECTED.has(code) || result.missing ? "Cognito rejected the request or the CLI could not start. No successful application was acknowledged. Inspect this exact pool before another approval." : "The write outcome is uncertain. Inspect this exact user/group in the selected pool before retrying; Studio never automatically retries writes." }; }
        else {
          acknowledged = true; let verified = false;
          try { verified = await this.observed(target, view.operation); } catch { /* A successful write is independent from a failed follow-up read. */ }
          record = { ...record, status: "applied", verification: verified ? "observed" : "unverified", message: verified ? "Cognito acknowledged the operation and follow-up metadata matches. Successful sign-in, token refresh and effective IAM remain separate checks." : "Cognito acknowledged the operation, but follow-up metadata is unavailable or has not converged. Refresh the exact pool before considering another write; no retry was sent." };
        }
      }
      record = { ...record, updatedAt: new Date().toISOString() }; this.persist(record); return { ...record, refreshRequired: true };
    } catch (error) {
      if (!record || !writeStarted && error instanceof EditError) throw error;
      record = { ...record, updatedAt: new Date().toISOString(), status: writeStarted ? "unconfirmed" : "rejected", verification: "unverified", message: writeStarted || acknowledged ? "The AWS or durable-history outcome is uncertain. Inspect the exact pool and preserve this operation record before retrying; no automatic retry was sent." : "The operation could not be prepared. No AWS write was sent." };
      try { this.persist(record); } catch { /* The earlier running journal stays uncertain if storage is unavailable. */ }
      return { ...record, refreshRequired: true };
    } finally { if (record) this.active.delete(record.id); release(); }
  }
}

/** Reuses the existing guarded /identity router; no arbitrary pool/command API. */
export function cognitoOperationsRouter(service: CognitoOperations) {
  const router = express.Router();
  router.get("/", (_request, response) => sendJson(response, () => service.history()));
  router.post("/review", (request, response) => sendJson(response, () => service.review(request.body?.selection, request.body?.operation)));
  router.post("/apply", (request, response) => sendJson(response, () => service.apply(request.body?.id, request.body?.confirmation, request.body?.productionConfirmation)));
  return router;
}
