import assert from "./support/assert";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { patchIniSection, ProfileConfiguration } from "../server/aws-connections/configuration";
import { spawnSync } from "node:child_process";
import { cliCredentialProvider, runPrivateAws } from "../../scripts/aws-connections";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(config = "# Keep this comment\r\n[profile base]\r\nregion = us-east-1\r\nunknown = preserve-me\r\n\r\n[services custom]\r\ns3 =\r\n  endpoint_url = https://example.invalid\r\n", credentials = "[base]\naws_access_key_id = SENTINEL_ACCESS_KEY\naws_secret_access_key = SENTINEL_SECRET_KEY\n") {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-profile-review-test-")); directories.push(directory);
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  writeFileSync(configFile, config, { mode: 0o600 }); writeFileSync(credentialsFile, credentials, { mode: 0o600 });
  const env = { AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile };
  return { directory, configFile, credentialsFile, config, credentials, env, service: new ProfileConfiguration(env) };
}
test("profile field review preserves unrelated bytes, CRLF, native credentials and permissions", () => {
  const f = fixture();
  const review = f.service.review({ name: "base", create: false, fields: { region: "eu-west-1" } }, ["base"], ["base"]);
  assert.deepEqual(review.changes, [{ field: "region", before: "us-east-1", after: "eu-west-1" }]);
  assert.doesNotMatch(JSON.stringify(review), /SENTINEL|unknown|endpoint_url/);
  assert.equal(readFileSync(f.configFile, "utf8"), f.config);
  assert.deepEqual(f.service.apply(review.id), { name: "base", changed: true });
  assert.equal(readFileSync(f.configFile, "utf8"), f.config.replace("region = us-east-1", "region = eu-west-1"));
  assert.equal(readFileSync(f.credentialsFile, "utf8"), f.credentials);
  assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  assert.throws(() => f.service.apply(review.id), /expired/);
});
test("stale config and stale credential-file revisions refuse without replacing either file", () => {
  for (const changed of ["configFile", "credentialsFile"] as const) {
    const f = fixture();
    const review = f.service.review({ name: "base", create: false, fields: { region: "eu-west-1" } }, ["base"], ["base"]);
    const before = readFileSync(f[changed], "utf8") + "# External change\n";
    writeFileSync(f[changed], before);
    assert.throws(() => f.service.apply(review.id), /changed after review/);
    assert.equal(readFileSync(f[changed], "utf8"), before);
    if (changed === "credentialsFile") assert.equal(readFileSync(f.configFile, "utf8"), f.config);
  }
});
test("ambiguous, linked and read-only configuration remains outside the writer", () => {
  assert.throws(() => patchIniSection("[profile a]\nregion=x\n[profile a]\nregion=y\n", "profile a", { region: "us-east-1" }, false), /duplicated/);
  assert.throws(() => patchIniSection("[profile a]\nregion=x\nregion=y\n", "profile a", { region: "us-east-1" }, false), /duplicated/);
  for (const kind of ["symlink", "hardlink", "read-only"] as const) {
    const f = fixture();
    if (kind === "read-only") chmodSync(f.configFile, 0o400);
    else { const original = f.configFile + ".original"; writeFileSync(original, f.config); rmSync(f.configFile); if (kind === "symlink") symlinkSync(original, f.configFile); else linkSync(original, f.configFile); }
    assert.throws(() => f.service.review({ name: "base", create: false, fields: { region: "eu-west-1" } }, ["base"], ["base"]), /read-only|linked/);
  }
});
test("supported edits preserve inline comments and quoted existing profile headers", () => {
  const f = fixture("# Shared setup\r\n[profile \"team developer\"]\r\nregion = us-east-1  # PRIVATE_COMMENT_SENTINEL\r\n");
  const review = f.service.review({ name: "team developer", create: false, fields: { region: "eu-west-1" } }, ["team developer"], ["team developer"]);
  assert.doesNotMatch(JSON.stringify(review), /PRIVATE_COMMENT_SENTINEL/);
  f.service.apply(review.id);
  assert.equal(readFileSync(f.configFile, "utf8"), f.config.replace("us-east-1", "eu-west-1"));
  assert.equal(patchIniSection("[profile base]\nregion=us-east-1 # Keep\n", "profile base", { region: undefined }, false), "[profile base]\n# Keep\n");
});
test("a credentials-only spaced profile gains a native-compatible config stanza after a reviewed region edit", { skip: spawnSync("aws", ["--version"], { encoding: "utf8" }).status !== 0 }, async () => {
  const credentials = "[team developer]\naws_access_key_id = SYNTHETIC_OFFLINE_ACCESS_KEY\naws_secret_access_key = SYNTHETIC_OFFLINE_SECRET\n";
  const f = fixture("# Preserve the original file comment\n", credentials);
  const review = f.service.review({ name: "team developer", create: false, fields: { region: "eu-west-1" } }, ["team developer"], ["team developer"]);
  f.service.apply(review.id);
  const saved = readFileSync(f.configFile, "utf8");
  assert.match(saved, /\[profile "team developer"\]/);
  assert.ok(saved.startsWith("# Preserve the original file comment\n"));
  assert.equal(readFileSync(f.credentialsFile, "utf8"), credentials);
  const env = { ...process.env, ...f.env, FRAMEWORK_AWS_CLI: undefined, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_EC2_METADATA_DISABLED: "true" };
  const region = await runPrivateAws(["configure", "get", "region", "--profile", "team developer"], { env, snapshot: false });
  assert.equal(region.stdout.trim(), "eu-west-1", "the native CLI reads the saved region rather than ignoring an unquoted header");
  assert.equal((await cliCredentialProvider("team developer", { env })()).accessKeyId, "SYNTHETIC_OFFLINE_ACCESS_KEY");
  assert.equal(readFileSync(f.configFile, "utf8"), saved);
});
test("nested service settings are preserved while a top-level profile field is added", () => {
  const original = "[profile base]\ns3 =\n  region = custom-service-value # preserve\n  address = unchanged\n";
  const updated = patchIniSection(original, "profile base", { region: "eu-west-1" }, false);
  assert.equal(updated, original + "region = eu-west-1\n");
});
test("configuration paths remain bound even when reviewed files did not exist", () => {
  const f = fixture(); rmSync(f.configFile); rmSync(f.credentialsFile);
  const review = f.service.review({ name: "console", create: true, fields: { region: "us-east-1" } }, [], ["console"], { fields: { login_session: "arn:aws:iam::123456789012:user/test", region: "us-east-1" } });
  f.env.AWS_CONFIG_FILE = path.join(f.directory, "another-config");
  assert.throws(() => f.service.apply(review.id), /paths changed/);
  assert.equal(existsSync(f.env.AWS_CONFIG_FILE), false);
});
test("creation rejects collisions, cycles, method conversion and browser credential material", () => {
  const f = fixture("[profile base]\nregion=us-east-1\n[profile chained]\nrole_arn=arn:aws:iam::123456789012:role/one\nsource_profile=base\n");
  assert.throws(() => f.service.review({ name: "base", create: true, fields: { role_arn: "arn:aws:iam::123456789012:role/example", source_profile: "base" } }, ["base"], ["base"]), /already exists/);
  assert.throws(() => f.service.review({ name: "base", create: false, fields: { role_arn: "arn:aws:iam::123456789012:role/example" } }, ["base"], ["base"]), /change authentication/);
  assert.throws(() => f.service.review({ name: "base", create: false, fields: { aws_secret_access_key: "SENTINEL" } as never }, ["base"], ["base"]), /unsupported/);
  assert.throws(() => f.service.review({ name: "chained", create: false, fields: { source_profile: "chained" } }, ["base", "chained"], ["chained"]), /itself/);
  assert.throws(() => f.service.review({ name: "chained", create: false, fields: { region: "us-east-1\naws_secret_access_key=SENTINEL" } }, ["base", "chained"], ["chained"]), /unsupported/);
  assert.equal(readFileSync(f.configFile, "utf8"), f.config);
});
test("authenticated SSO creation preserves shared sessions and requires account/role selection", () => {
  const f = fixture();
  const authenticated = { fields: { sso_session: "team" }, session: { name: "team", fields: { sso_start_url: "https://team.awsapps.com/start", sso_region: "us-east-1", sso_registration_scopes: "sso:account:access" } } };
  assert.throws(() => f.service.review({ name: "team-dev", create: true, fields: { region: "us-west-2" } }, ["base"], ["team-dev"], authenticated), /account and permission set/);
  const review = f.service.review({ name: "team-dev", create: true, fields: { region: "us-west-2", sso_account_id: "123456789012", sso_role_name: "Developer" } }, ["base"], ["team-dev"], authenticated);
  f.service.apply(review.id);
  assert.match(readFileSync(f.configFile, "utf8"), /\[profile team-dev\]/);
  assert.match(readFileSync(f.configFile, "utf8"), /\[sso-session team\]/);
  assert.equal(readFileSync(f.credentialsFile, "utf8"), f.credentials);
});
test("running mutations and unresolved writer locks prevent configuration replacement", () => {
  const f = fixture(); let busy = false;
  const service = new ProfileConfiguration(f.env, () => busy);
  const review = service.review({ name: "base", create: false, fields: { region: "eu-west-1" } }, ["base"], ["base"]);
  busy = true; assert.throws(() => service.apply(review.id), /running AWS mutation/); busy = false;
  writeFileSync(f.configFile + ".studio-profile-lock", "other owner");
  assert.throws(() => service.apply(review.id), /unresolved Studio lock/);
  assert.equal(readFileSync(f.configFile, "utf8"), f.config);
  assert.equal(existsSync(f.configFile + ".studio-profile-lock"), true);
});
