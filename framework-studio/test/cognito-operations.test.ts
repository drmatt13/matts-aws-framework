import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { CognitoOperations, readCognitoOperation } from "../server/identity/operations";
import { IdentityService } from "../server/identity/service";
import type { VerifiedCognitoTarget, CognitoOperation } from "../shared/identity-operations";
import type { CommandSpec, Runner } from "../server/deploy/process";
import type { DeployService } from "../server/deploy/service";

const roots: string[] = [], cache = path.resolve(__dirname, "../../.cache/framework-studio/cognito-operations-tests");
mkdirSync(cache, { recursive: true });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const selection = { profile: "dev", deployment: "campaign-dev", region: "us-east-1" };
const createUser: CognitoOperation = { action: "create-user", username: "campaign.user", email: "campaign.user@example.invalid", givenName: "Disposable", familyName: "Campaign" };
function fixture() { const root = mkdtempSync(path.join(cache, "case-")); roots.push(root); writeFileSync(path.join(root, "package.json"), "{}"); return root; }
function harness(mode: "dev" | "prod" = "dev") {
  const root = fixture(), calls: CommandSpec[] = [];
  const target: { -readonly [K in keyof VerifiedCognitoTarget]: VerifiedCognitoTarget[K] } = { ...selection, mode, account: "111122223333", actorArn: "arn:aws:iam::111122223333:role/CampaignOperator", poolId: "us-east-1_campaign", poolArn: "arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_campaign", fingerprint: "pool-v1", requiredAttributes: ["email", "given_name", "family_name"], passwordless: false, triggers: ["PreSignUp"] };
  const users = new Map<string, any>(), groups = new Map<string, any>(), memberships = new Set<string>();
  users.set("existing.user", { username: "existing.user", enabled: true, status: "CONFIRMED", created: "2026-01-01", modified: "2026-01-01", attributes: [{ Name: "sub", Value: "sub-existing" }] });
  groups.set("campaign-reader", { name: "campaign-reader", roleArn: "arn:aws:iam::111122223333:role/Reader", precedence: 10, created: "2026-01-01", modified: "2026-01-01" });
  let fail: "denied" | "unknown" | "followup" | undefined, applied = false;
  const run: Runner = async spec => {
    calls.push(spec); const op = spec.args[1]!, argument = (key: string) => spec.args[spec.args.indexOf(key) + 1]!;
    assert.equal(spec.env.AWS_PROFILE, "dev"); assert.equal(spec.env.AWS_MAX_ATTEMPTS, "1");
    const user = argument("--username"), group = argument("--group-name");
    if (fail === "followup" && applied && ["admin-get-user", "get-group", "admin-list-groups-for-user"].includes(op)) return { code: 1, stdout: "", stderr: "An error occurred (AccessDeniedException) private-error-never-return" };
    if (op === "admin-get-user") return users.has(user) ? { code: 0, stdout: JSON.stringify(users.get(user)), stderr: "" } : { code: 1, stdout: "", stderr: "An error occurred (UserNotFoundException) not found" };
    if (op === "get-group") return groups.has(group) ? { code: 0, stdout: JSON.stringify(groups.get(group)), stderr: "" } : { code: 1, stdout: "", stderr: "An error occurred (ResourceNotFoundException) not found" };
    if (op === "admin-list-groups-for-user") return { code: 0, stdout: JSON.stringify([...groups.values()].filter(group => memberships.has(`${user}|${group.name}`))), stderr: "" };
    if (fail === "denied") return { code: 1, stdout: "private-body", stderr: "An error occurred (AccessDeniedException) private-error-never-return" };
    applied = true;
    if (op === "admin-create-user") users.set(user, { username: user, enabled: true, status: "FORCE_CHANGE_PASSWORD", created: "2026-10-23", modified: "2026-10-23", attributes: [{ Name: "sub", Value: "sub-new" }] });
    else if (op === "create-group") groups.set(group, { name: group, created: "2026-10-23", modified: "2026-10-23" });
    else if (op === "admin-add-user-to-group") memberships.add(`${user}|${group}`);
    else if (op === "admin-remove-user-from-group") memberships.delete(`${user}|${group}`);
    else if (op === "admin-enable-user" || op === "admin-disable-user") users.get(user).enabled = op === "admin-enable-user";
    else throw new Error(`Unexpected write ${op}`);
    return fail === "unknown" ? { code: null, stdout: "", stderr: "Connection closed private-error-never-return" } : { code: 0, stdout: '{"Password":"private-password-never-return","UserAttributes":["private-body"]}', stderr: "" };
  };
  const identity = { async verifiedUserPool() { return { ...target }; } };
  return { root, target, calls, users, groups, memberships, identity, service: new CognitoOperations(root, identity, run, {}), fail(value: typeof fail) { fail = value; }, writeCalls: () => calls.filter(call => !["admin-get-user", "get-group", "admin-list-groups-for-user"].includes(call.args[1]!)) };
}

test("operation input has no password, arbitrary attributes, IAM role or delete surface", () => {
  for (const raw of [{ ...createUser, password: "never" }, { ...createUser, emailVerified: true }, { action: "delete-user", username: "test" }, { action: "create-group", group: "reader", description: "", roleArn: "arn:aws:iam::1:role/Admin" }, { action: "disable-user", username: "--cli-input-json" }]) assert.throws(() => readCognitoOperation(raw), /supported|unsupported|name/);
});
test("review reads only; exact suppressed user creation never sends a password or forced verification/alias override", async () => {
  const h = harness(), review = await h.service.review(selection, createUser);
  assert.equal(h.writeCalls().length, 0); assert.equal(h.service.history().length, 0); assert.match(review.effects.join(" "), /PreSignUp/);
  await assert.rejects(h.service.apply(review.id, "wrong"), /exact action/); assert.equal(h.writeCalls().length, 0);
  const result = await h.service.apply(review.id, review.confirmation);
  assert.equal(result.status, "applied"); assert.equal(result.verification, "observed");
  const write = h.writeCalls()[0]!; assert.ok(write.args.includes("SUPPRESS")); assert.ok(write.args.includes("--no-force-alias-creation")); assert.ok(!write.args.includes("--temporary-password")); assert.ok(!write.args.join(" ").includes("email_verified"));
  assert.doesNotMatch(JSON.stringify(result), /private-password|private-body/);
  const journal = readdirSync(path.join(h.root, ".cache/framework-studio/cognito-operations")).filter(file => file.endsWith(".json")).map(file => readFileSync(path.join(h.root, ".cache/framework-studio/cognito-operations", file), "utf8")).join("");
  assert.doesNotMatch(journal, /campaign\.user|example\.invalid|Disposable|private-password|private-body/);
  await assert.rejects(h.service.apply(review.id, review.confirmation), /consumed/); assert.equal(h.writeCalls().length, 1);
});
test("production needs a second exact operation authorization; selection or subject drift refuses with zero writes", async () => {
  const h = harness("prod"), review = await h.service.review(selection, createUser);
  assert.match(review.productionConfirmation!, /AUTHORIZE PRODUCTION.*create-user.*campaign.user.*111122223333/);
  await assert.rejects(h.service.apply(review.id, review.confirmation), /production/); assert.equal(h.writeCalls().length, 0);
  h.target.fingerprint = "pool-v2";
  await assert.rejects(h.service.apply(review.id, review.confirmation, review.productionConfirmation), /changed after review/); assert.equal(h.writeCalls().length, 0);
  const second = await h.service.review(selection, { action: "disable-user", username: "existing.user" });
  h.users.get("existing.user").modified = "concurrent-change";
  await assert.rejects(h.service.apply(second.id, second.confirmation, second.productionConfirmation), /changed after review/); assert.equal(h.writeCalls().length, 0);
});
test("create-group, membership and enable/disable have reviewed lifecycle and no-op evidence", async () => {
  const h = harness();
  const execute = async (operation: CognitoOperation) => { const review = await h.service.review(selection, operation); return h.service.apply(review.id, review.confirmation); };
  assert.equal((await execute({ action: "create-group", group: "new-group", description: "Disposable group" })).status, "applied");
  const groupWrite = h.writeCalls().find(call => call.args[1] === "create-group")!; assert.ok(!groupWrite.args.includes("--role-arn")); assert.ok(!groupWrite.args.includes("--precedence"));
  const add = await h.service.review(selection, { action: "add-to-group", username: "existing.user", group: "campaign-reader" });
  assert.match(add.effects.join(" "), /role\/Reader/); assert.equal((await h.service.apply(add.id, add.confirmation)).status, "applied");
  assert.equal((await execute({ action: "add-to-group", username: "existing.user", group: "campaign-reader" })).status, "unchanged");
  assert.equal((await execute({ action: "remove-from-group", username: "existing.user", group: "campaign-reader" })).status, "applied");
  assert.equal((await execute({ action: "disable-user", username: "existing.user" })).status, "applied");
  assert.equal((await execute({ action: "disable-user", username: "existing.user" })).status, "unchanged");
  assert.equal((await execute({ action: "enable-user", username: "existing.user" })).status, "applied");
  assert.equal(h.writeCalls().length, 5);
});
test("explicit rejection, unknown acknowledgement and failed follow-up stay distinct without automatic retries", async () => {
  for (const failure of ["denied", "unknown", "followup"] as const) {
    const h = harness(), review = await h.service.review(selection, createUser); h.fail(failure);
    const result = await h.service.apply(review.id, review.confirmation);
    assert.equal(result.status, failure === "denied" ? "rejected" : failure === "unknown" ? "unconfirmed" : "applied");
    assert.equal(result.verification, "unverified"); assert.equal(h.writeCalls().length, 1); assert.doesNotMatch(JSON.stringify(result), /private-/);
    const restarted = new CognitoOperations(h.root, h.identity, async () => { throw new Error("Restart never replays writes"); }, {});
    const restored = restarted.history()[0]!;
    assert.equal(restored.status, result.status); assert.equal(restored.actorArn, h.target.actorArn); assert.equal(restored.subjectDigest, review.subjectDigest); assert.equal(restored.poolId, h.target.poolId); assert.equal(restored.startedAt, result.startedAt);
    assert.doesNotMatch(JSON.stringify(restored), /campaign\.user|example\.invalid|Disposable|private-/);
    await assert.rejects(restarted.apply(review.id, review.confirmation), /consumed/); assert.equal(h.writeCalls().length, 1);
  }
});
test("passwordless pools and unknown required attributes refuse rather than creating an unintended credential flow", async () => {
  const h = harness(); h.target.passwordless = true;
  await assert.rejects(h.service.review(selection, createUser), /passwordless/); assert.equal(h.calls.length, 0);
  h.target.passwordless = false; (h.target.requiredAttributes as string[]).push("custom:tenant");
  await assert.rejects(h.service.review(selection, createUser), /additional attributes/); assert.equal(h.calls.length, 0);
});
test("restarted running operations remain uncertain and never replay user data", () => {
  const h = harness(), directory = path.join(h.root, ".cache/framework-studio/cognito-operations"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), JSON.stringify({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", action: "create-user", status: "running", startedAt: "2026-10-23", poolId: h.target.poolId }));
  assert.equal(h.service.history()[0]?.status, "unconfirmed"); assert.equal(h.calls.length, 0);
});
test("verified pool helper rejects unowned stack/account and fingerprints only the observed pool", async () => {
  const root = fixture(); let calls = 0;
  const deploy = { targets: () => [{ name: selection.deployment, mode: "dev", account: "111122223333" }], observer: { status: async () => ({ ok: true, value: { context: { account: "111122223333", arn: "arn:aws:iam::111122223333:role/Test" }, detail: { stacks: [{ name: "campaign-CognitoStack", identity: { deployment: selection.deployment, mode: "dev" } }] } } }) } } as unknown as Pick<DeployService, "targets" | "observer">;
  const service = new IdentityService(root, deploy, async spec => { calls++; return { code: 0, stdout: JSON.stringify(spec.args[1] === "list-stack-resources" ? ["us-east-1_campaign"] : { id: "us-east-1_campaign", arn: "arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_campaign", schema: [{ name: "email", required: true }], policies: { SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD"] } }, triggers: {} }), stderr: "" }; }, {});
  const target = await service.verifiedUserPool(selection); assert.equal(target.poolId, "us-east-1_campaign"); assert.equal(target.passwordless, false); assert.equal(calls, 2);
  await assert.rejects(service.verifiedUserPool({ ...selection, deployment: "unowned" }), /declared/); assert.equal(calls, 2);
});
