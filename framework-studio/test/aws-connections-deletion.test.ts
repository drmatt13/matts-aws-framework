import assert from "./support/assert";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ProfileDeletion } from "../server/aws-connections/deletion";
import { AwsConnectionsService } from "../server/aws-connections/service";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const config = "# Keep the file header\r\n[profile base]\r\nregion = us-east-1\r\nunknown = PRIVATE_UNKNOWN_SENTINEL\r\n\r\n# Preserve this comment before the next profile\r\n[profile other]\r\nregion = eu-west-1\r\nsso_session = team\r\nsso_account_id = 123456789012\r\nsso_role_name = Developer\r\n\r\n[sso-session team]\r\nsso_start_url = https://team.awsapps.com/start\r\nsso_region = us-east-1\r\n\r\n[services custom]\r\ns3 =\r\n  endpoint_url = https://example.invalid\r\n";
const credentials = "# Private credentials\n[base]\naws_access_key_id = SENTINEL_ACCESS_KEY\naws_secret_access_key = SENTINEL_SECRET_KEY\naws_session_token = SENTINEL_SESSION_TOKEN\n\n# Preserve the unrelated credentials\n[other]\ncredential_process = SENTINEL_EXTERNAL_COMMAND --argument\n";
function fixture(configText = config, credentialText = credentials) {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-profile-deletion-test-")); directories.push(directory);
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  writeFileSync(configFile, configText, { mode: 0o640 }); writeFileSync(credentialsFile, credentialText, { mode: 0o600 });
  const env = { AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile };
  return { directory, configFile, credentialsFile, config: configText, credentials: credentialText, env, deletion: new ProfileDeletion(env) };
}
function unchanged(f: ReturnType<typeof fixture>) {
  assert.equal(readFileSync(f.configFile, "utf8"), f.config);
  assert.equal(readFileSync(f.credentialsFile, "utf8"), f.credentials);
}
test("reviewed deletion removes only both selected profile definitions and preserves shared sessions, comments and file modes", () => {
  const f = fixture(); const review = f.deletion.review("base");
  assert.equal(review.name, "base"); assert.deepEqual(review.files, ["config", "credentials"]);
  assert.deepEqual(review.dependentProfiles, []); assert.deepEqual(review.blockers, []);
  assert.ok(Date.parse(review.expiresAt) - Date.now() <= 2 * 60_000);
  assert.doesNotMatch(JSON.stringify(review), /SENTINEL|aws_access_key|aws_secret|aws_session|credential_process|endpoint_url|\//);
  unchanged(f);
  assert.deepEqual(f.deletion.apply(review.id), { name: "base", changed: true });
  assert.equal(readFileSync(f.configFile, "utf8"), f.config.replace("[profile base]\r\nregion = us-east-1\r\nunknown = PRIVATE_UNKNOWN_SENTINEL\r\n", ""));
  assert.equal(readFileSync(f.credentialsFile, "utf8"), f.credentials.replace("[base]\naws_access_key_id = SENTINEL_ACCESS_KEY\naws_secret_access_key = SENTINEL_SECRET_KEY\naws_session_token = SENTINEL_SESSION_TOKEN\n", ""));
  assert.equal(statSync(f.configFile).mode & 0o777, 0o640); assert.equal(statSync(f.credentialsFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory).sort(), ["config", "credentials"]);
  assert.throws(() => f.deletion.apply(review.id), /expired/);
});
test("default, config-only and credentials-only spaced names delete the exact native section without a fallback", () => {
  for (const [name, configText, credentialText, files] of [
    ["default", "[default]\nregion=us-east-1\n[profile default-other]\nregion=eu-west-1\n", "# Credentials unchanged\n", ["config"]],
    ["team developer", "# Config unchanged\n", "[team developer]\ncredential_process = SENTINEL_PROVIDER\n[other]\ncredential_process = keep\n", ["credentials"]],
    ["team developer", '[profile "team developer"]\nregion=us-east-1\n[profile other]\nregion=eu-west-1\n', "# Credentials unchanged\n", ["config"]],
    ["base", "[profile\t base]\nregion=us-east-1\n[profile other]\nregion=eu-west-1\n", "# Credentials unchanged\n", ["config"]],
  ] as const) {
    const f = fixture(configText, credentialText); const review = f.deletion.review(name);
    assert.deepEqual(review.files, files); assert.deepEqual(review.blockers, []);
    f.deletion.apply(review.id);
    assert.match(readFileSync(files[0] === "config" ? f.configFile : f.credentialsFile, "utf8"), /unchanged|\[.*other\]/);
    assert.equal(readFileSync(files[0] === "config" ? f.credentialsFile : f.configFile, "utf8"), files[0] === "config" ? credentialText : configText);
  }
  const f = fixture(); assert.throws(() => f.deletion.review("missing"), /no longer exists/); unchanged(f);
  assert.throws(() => f.deletion.review("base\n[SENTINEL]"), /Choose an AWS profile/); unchanged(f);
});
test("source-profile dependents block deletion, including transitive and duplicate source declarations", () => {
  const f = fixture("[profile base]\nregion=us-east-1\n[profile child]\nrole_arn=arn:aws:iam::123456789012:role/one\nsource_profile=base\nsource_profile=other\n[profile grandchild]\nrole_arn=arn:aws:iam::123456789012:role/two\nsource_profile=child\n[profile other]\nregion=us-east-1\n");
  const review = f.deletion.review("base");
  assert.deepEqual(review.dependentProfiles, ["child", "grandchild"]);
  assert.ok(review.blockers.some(message => message.includes("credential source")));
  assert.throws(() => f.deletion.apply(review.id), /listed issues/); unchanged(f);
  // A nested service option named source_profile is unrelated to credentials.
  const nested = fixture("[profile base]\nregion=us-east-1\n[profile other]\ns3 =\n  source_profile = base\n");
  assert.deepEqual(nested.deletion.review("base").dependentProfiles, []);
  const upper = fixture("[profile base]\nregion=us-east-1\n[profile child]\nSOURCE_PROFILE = base\nrole_arn=arn:aws:iam::123456789012:role/one\n");
  assert.deepEqual(upper.deletion.review("base").dependentProfiles, ["child"]);
});
test("linked, read-only, managed, duplicate and malformed AWS definitions remain visible but cannot be deleted", () => {
  for (const kind of ["symlink", "hardlink", "read-only", "managed", "duplicate", "malformed"] as const) for (const fileKey of ["configFile", "credentialsFile"] as const) {
    const f = fixture();
    if (kind === "read-only") chmodSync(f[fileKey], 0o400);
    if (kind === "managed") writeFileSync(f[fileKey], "# This file is managed by another tool. Do not edit.\n" + readFileSync(f[fileKey], "utf8"));
    if (kind === "duplicate") writeFileSync(f[fileKey], readFileSync(f[fileKey], "utf8") + (fileKey === "configFile" ? "[profile base]\nregion=eu-west-1\n" : "[base]\naws_access_key_id=SENTINEL\n"));
    if (kind === "malformed") writeFileSync(f[fileKey], readFileSync(f[fileKey], "utf8") + "[malformed section\nunknown=SENTINEL\n");
    if (kind === "symlink" || kind === "hardlink") {
      const original = `${f[fileKey]}.original`; renameSync(f[fileKey], original);
      if (kind === "symlink") symlinkSync(original, f[fileKey]); else linkSync(original, f[fileKey]);
    }
    const before = [readFileSync(f.configFile, "utf8"), readFileSync(f.credentialsFile, "utf8")];
    const review = f.deletion.review("base"); assert.ok(review.blockers.length, `${kind} ${fileKey}`);
    assert.doesNotMatch(JSON.stringify(review), /SENTINEL|PRIVATE_UNKNOWN|aws_access_key/);
    assert.throws(() => f.deletion.apply(review.id), /listed issues/);
    assert.deepEqual([readFileSync(f.configFile, "utf8"), readFileSync(f.credentialsFile, "utf8")], before);
  }
});
test("stale file bytes, file identity, permissions, effective paths and newly created files reject with zero writes", () => {
  for (const scenario of ["config", "credentials", "identity", "permissions", "paths", "absent-file"] as const) {
    const f = fixture();
    if (scenario === "absent-file") rmSync(f.credentialsFile);
    const review = f.deletion.review("base");
    if (scenario === "config") writeFileSync(f.configFile, f.config + "# External edit\n");
    if (scenario === "credentials") writeFileSync(f.credentialsFile, f.credentials + "# External edit\n");
    if (scenario === "identity") { const temporary = `${f.configFile}.external`; writeFileSync(temporary, f.config, { mode: 0o640 }); renameSync(temporary, f.configFile); }
    if (scenario === "permissions") chmodSync(f.credentialsFile, 0o640);
    if (scenario === "paths") f.env.AWS_CONFIG_FILE = path.join(f.directory, "different-config");
    if (scenario === "absent-file") writeFileSync(f.credentialsFile, f.credentials, { mode: 0o600 });
    const before = [readFileSync(f.configFile, "utf8"), readFileSync(f.credentialsFile, "utf8")];
    assert.throws(() => f.deletion.apply(review.id), /changed after review/);
    assert.deepEqual([readFileSync(f.configFile, "utf8"), readFileSync(f.credentialsFile, "utf8")], before);
    assert.deepEqual(readdirSync(f.directory).sort(), ["config", "credentials"]);
  }
});
test("busy profiles, cancellation and existing writer locks prevent effects", () => {
  const f = fixture(); let busy = false;
  const deletion = new ProfileDeletion(f.env, () => busy);
  const review = deletion.review("base"); busy = true;
  assert.throws(() => deletion.apply(review.id), /in use/); unchanged(f);
  assert.ok(deletion.review("base").blockers.some(message => message.includes("in use")));
  busy = false; deletion.discard(review.id); assert.throws(() => deletion.apply(review.id), /expired/);
  for (const file of [f.configFile, f.credentialsFile]) {
    const fresh = deletion.review("base"); const lock = `${file}.studio-profile-lock`; writeFileSync(lock, "other writer");
    assert.throws(() => deletion.apply(fresh.id), /unresolved Studio lock/); unchanged(f);
    assert.equal(readFileSync(lock, "utf8"), "other writer"); rmSync(lock);
    assert.deepEqual(readdirSync(f.directory).sort(), ["config", "credentials"]);
  }
});
test("a second-file replacement failure compensates the first and leaves no partial deletion or private staging files", () => {
  const f = fixture(); let calls = 0;
  const deletion = new ProfileDeletion(f.env, undefined, { replace: (from, to) => { if (++calls === 2) throw new Error("SENTINEL_FILESYSTEM_FAILURE"); renameSync(from, to); } });
  const review = deletion.review("base");
  assert.throws(() => deletion.apply(review.id), error => {
    assert.match(String(error), /Completed replacements were restored/);
    assert.doesNotMatch(String(error), /SENTINEL|aws_access_key|PRIVATE_UNKNOWN/); return true;
  });
  assert.equal(calls, 3); unchanged(f);
  assert.equal(statSync(f.configFile).mode & 0o777, 0o640); assert.equal(statSync(f.credentialsFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory).sort(), ["config", "credentials"]);
});
test("compensation preserves intervening external edits and private restoration copies instead of overwriting them", () => {
  const f = fixture(); let calls = 0; const external = "# External editor owns this version\n[profile external]\nregion=eu-west-1\n";
  const deletion = new ProfileDeletion(f.env, undefined, { replace: (from, to) => {
    if (++calls === 2) { writeFileSync(f.configFile, external); throw new Error("SENTINEL_CONCURRENT_FAILURE"); }
    renameSync(from, to);
  } });
  const review = deletion.review("base");
  assert.throws(() => deletion.apply(review.id), error => { assert.match(String(error), /Current external edits were preserved/); assert.doesNotMatch(String(error), /SENTINEL/); return true; });
  assert.equal(readFileSync(f.configFile, "utf8"), external); assert.equal(readFileSync(f.credentialsFile, "utf8"), f.credentials);
  const restorations = readdirSync(f.directory).filter(file => file.endsWith(".restore")); assert.equal(restorations.length, 2);
  for (const restore of restorations) assert.equal(statSync(path.join(f.directory, restore)).mode & 0o777, 0o600);
  assert.ok(restorations.some(file => readFileSync(path.join(f.directory, file), "utf8") === f.config));
  assert.equal(readdirSync(f.directory).some(file => file.endsWith(".tmp") || file.endsWith(".studio-profile-lock")), false);
});
test("the shared service deletes without native commands, invalidates observations, and discards deletion reviews", async () => {
  const f = fixture(); const changed: readonly string[][] = []; let calls = 0;
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async () => { calls++; throw new Error("AWS must not run during deletion"); }, changed: profiles => (changed as string[][]).push([...profiles]) });
  try {
    const canceled = service.deleteReview("base"); assert.deepEqual(service.discard(canceled.id), { discarded: true });
    await assert.rejects(() => service.deleteApply(canceled.id), /expired/); unchanged(f);
    const review = service.deleteReview("base"); await service.deleteApply(review.id);
    assert.equal(calls, 0); assert.deepEqual(changed, [["base"]]);
    assert.equal(existsSync(f.configFile), true); assert.equal(existsSync(f.credentialsFile), true);
    assert.doesNotMatch(readFileSync(f.configFile, "utf8"), /\[profile base\]/);
    assert.doesNotMatch(readFileSync(f.credentialsFile, "utf8"), /\[base\]/);
  } finally { await service.dispose(); }
});
