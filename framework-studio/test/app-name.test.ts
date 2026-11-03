import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { AppNameService, applicationSummary } from "../server/app-name";
import { appNameFault, appNamePreview } from "../shared/app-name";

const repository = path.resolve(__dirname, "../..");
const cache = path.join(repository, ".cache/app-name-tests");
const account = "111122223333";
const appId = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Seen = { name: string; appId?: string; stage?: string };
/** Deploy's discovery as the review sees it: which deployments each profile can find, and which app and stage each says it is. */
function discovery(seen: Record<string, { account: string; deployments: (string | Seen)[] }>) {
  const calls: string[] = [];
  const discover = async (profile: string) => {
    calls.push(profile);
    const found = seen[profile];
    return found
      ? { ok: true as const, value: { context: { account: found.account }, deployments: found.deployments.map((entry) => (typeof entry === "string" ? { name: entry } : entry)) } }
      : { ok: false as const, problem: { message: `The ${profile} session has expired.` } };
  };
  return { discover, calls };
}

function fixture(context: Record<string, unknown>, seen: Record<string, { account: string; deployments: (string | Seen)[] }> = {}) {
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "cdk-app"));
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ app: "npx tsx bin/main.ts", context }, null, 2) + "\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "SECRET=never-leak\n");
  const read = () => JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.json"), "utf8"));
  const aws = discovery(seen);
  return { root, read, aws, service: new AppNameService(root, aws.discover), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const profiles = { dev: "dev-profile", prod: "prod-profile" };

test("a rename moves development, keeps a deployed production as it is deployed, and leaves deployAs and other settings alone", async () => {
  const f = fixture(
    { before: 1, "framework:app": "acme", "framework:appId": appId, "framework:targets": { prod: { account }, staging: { mode: "prod", account, deployAs: "legacy-staging" } }, after: 2 },
    { "dev-profile": { account, deployments: [{ name: "acme-dev", appId, stage: "dev" }] }, "prod-profile": { account, deployments: [{ name: "acme-prod", appId, stage: "prod" }] } },
  );
  try {
    const view = f.service.load();
    assert.equal(view.appId, appId);
    assert.deepEqual(view.stages.map((stage) => [stage.stage, stage.mode, stage.deployAs ?? null, stage.implicit ?? false]), [
      ["dev", "dev", null, true], ["prod", "prod", null, false], ["staging", "prod", "legacy-staging", false],
    ]);
    const review = await f.service.review({ name: "beta", hash: view.hash, profiles });
    assert.deepEqual(review.rows.map((row) => [row.stage, row.before, row.after, row.outcome, row.check ?? null, row.deployed ?? null]), [
      ["dev", "acme-dev", "beta-dev", "follows", "deployed", "acme-dev"],
      ["prod", "acme-prod", "acme-prod", "keeps", "deployed", "acme-prod"],
      ["staging", "legacy-staging", "legacy-staging", "keeps", null, null],
    ]);
    assert.deepEqual(f.aws.calls, ["dev-profile", "prod-profile"], "a stage with deployAs is never looked up");
    assert.deepEqual(review.warnings, [
      "acme-dev keeps running, and billing, until you delete it in Deploy.",
      "Applying edits cdk-app/cdk.json only; nothing is deployed.",
    ]);
    assert.doesNotMatch(JSON.stringify(review), /never-leak/);
    f.service.apply(review.id);
    const after = f.read();
    assert.deepEqual(Object.keys(after.context), ["before", "framework:app", "framework:appId", "framework:targets", "after"], "every other key keeps its place");
    assert.deepEqual([after.context["framework:app"], after.context["framework:appId"]], ["beta", appId], "a rename never changes the app's id");
    assert.deepEqual(after.context["framework:targets"], { prod: { account, deployAs: "acme-prod" }, staging: { mode: "prod", account, deployAs: "legacy-staging" } });
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8"), "SECRET=never-leak\n", "inputs files are never touched");
    assert.equal(f.service.ownWrites.has("cdk-app/cdk.json"), true);
  } finally { f.cleanup(); }
});

test("production is found by its app id and stage under whatever name it is deployed as, never by another app's", async () => {
  const other = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const f = fixture(
    { "framework:app": "acme", "framework:appId": appId, "framework:targets": { prod: { account } } },
    { "prod-profile": { account, deployments: [{ name: "acme-prod", appId: other, stage: "prod" }, { name: "first-name-prod", appId, stage: "prod" }] } },
  );
  try {
    const review = await f.service.review({ name: "beta", hash: f.service.load().hash, profiles: { prod: "prod-profile" } });
    const prod = review.rows.find((row) => row.stage === "prod")!;
    assert.deepEqual([prod.before, prod.after, prod.outcome, prod.deployed], ["acme-prod", "first-name-prod", "keeps", "first-name-prod"], "a name cdk.json had already lost is recovered from AWS");
    f.service.apply(review.id);
    assert.deepEqual(f.read().context["framework:targets"].prod, { account, deployAs: "first-name-prod" });
  } finally { f.cleanup(); }
});

test("a production stage AWS shows undeployed simply follows the new name", async () => {
  const f = fixture({ "framework:app": "acme", "framework:appId": appId, "framework:targets": { prod: { account } } }, { "dev-profile": { account, deployments: [] }, "prod-profile": { account, deployments: [] } });
  try {
    const review = await f.service.review({ name: "beta", hash: f.service.load().hash, profiles });
    assert.deepEqual(review.rows.map((row) => [row.stage, row.after, row.outcome, row.check]), [["dev", "beta-dev", "follows", "absent"], ["prod", "beta-prod", "follows", "absent"]]);
    assert.deepEqual(review.warnings, ["Applying edits cdk-app/cdk.json only; nothing is deployed."]);
    f.service.apply(review.id);
    assert.deepEqual(f.read().context["framework:targets"].prod, { account });
  } finally { f.cleanup(); }
});

test("when AWS cannot be checked, nothing is kept on assumption: the stage follows, says why, and deploying checks again", async () => {
  const f = fixture({ "framework:app": "acme", "framework:appId": appId, "framework:targets": { prod: { account }, staging: { mode: "prod", account: "999999999999" } } }, { "prod-profile": { account, deployments: [] } });
  try {
    const hash = f.service.load().hash;
    const unchecked = await f.service.review({ name: "beta", hash, profiles: { prod: "prod-profile" } });
    const row = (stage: string) => unchecked.rows.find((candidate) => candidate.stage === stage)!;
    assert.deepEqual([row("dev").outcome, row("dev").check, row("dev").reason], ["follows", "unknown", "No Development AWS profile is selected."]);
    assert.deepEqual([row("prod").outcome, row("prod").check], ["follows", "absent"]);
    assert.deepEqual([row("staging").after, row("staging").outcome, row("staging").check, row("staging").reason], ["beta-staging", "follows", "unknown", "The Production profile prod-profile is for account 111122223333, not 999999999999."]);
    assert.deepEqual(unchecked.warnings, [
      "If acme-dev is deployed, it keeps running until you delete it in Deploy.",
      "If production is already deployed, deploying beta-staging stops and offers to keep its name.",
      "Applying edits cdk-app/cdk.json only; nothing is deployed.",
    ]);
    const expired = await f.service.review({ name: "beta", hash, profiles: { prod: "missing-profile" } });
    assert.equal(expired.rows.find((candidate) => candidate.stage === "prod")!.reason, "The missing-profile session has expired.");
    f.service.apply(expired.id);
    assert.equal(f.read().context["framework:targets"].staging.deployAs, undefined);
  } finally { f.cleanup(); }
});

test("naming an app for the first time keeps every target's full name and gives the app its permanent id", async () => {
  const f = fixture({ "framework:targets": { "my-aws-app-prod": { mode: "prod", account } } });
  try {
    assert.deepEqual(applicationSummary(f.root).legacy, true);
    assert.deepEqual(applicationSummary(f.root).needsId, true);
    const review = await f.service.review({ name: "acme", hash: f.service.load().hash });
    assert.equal(review.from, undefined);
    assert.deepEqual(review.rows.map((row) => [row.stage, row.after, row.outcome]), [["dev", "acme-dev", "follows"], ["my-aws-app-prod", "my-aws-app-prod", "keeps"]]);
    assert.deepEqual(f.aws.calls, [], "nothing to look up when nothing had this app's name");
    assert.match(review.warnings.join("\n"), /Adds framework:appId, a permanent id every stack is tagged with/);
    f.service.apply(review.id);
    const after = f.read();
    assert.deepEqual(Object.keys(after.context), ["framework:app", "framework:appId", "framework:targets"]);
    assert.match(after.context["framework:appId"], UUID);
    assert.deepEqual(after.context["framework:targets"]["my-aws-app-prod"], { mode: "prod", account, deployAs: "my-aws-app-prod" });
    assert.deepEqual(applicationSummary(f.root), { name: "acme", appId: after.context["framework:appId"] });
  } finally { f.cleanup(); }
});

test("a named app without an id can be reviewed unchanged, which only adds the id", async () => {
  const f = fixture({ "framework:app": "acme", "framework:targets": { prod: { account } } });
  try {
    const summary = applicationSummary(f.root);
    assert.deepEqual([summary.name, summary.needsId, summary.legacy ?? false], ["acme", true, false]);
    assert.match(summary.problem ?? "", /has no "framework:appId"/);
    const review = await f.service.review({ name: "acme", hash: f.service.load().hash, profiles });
    assert.deepEqual(review.rows.map((row) => [row.stage, row.before, row.after, row.outcome]), [["dev", "acme-dev", "acme-dev", "follows"], ["prod", "acme-prod", "acme-prod", "follows"]]);
    assert.deepEqual(f.aws.calls, [], "an unchanged name moves nothing, so nothing is looked up");
    f.service.apply(review.id);
    assert.deepEqual(Object.keys(f.read().context), ["framework:app", "framework:appId", "framework:targets"]);
  } finally { f.cleanup(); }
});

test("Deploy keeps a stage deploying under the name AWS shows, through its own review", async () => {
  const f = fixture({ "framework:app": "beta", "framework:appId": appId, "framework:targets": { prod: { account } } });
  try {
    const hash = f.service.load().hash;
    const review = f.service.reviewDeployAs({ stage: "prod", deployAs: "acme-prod", hash });
    assert.deepEqual(review.rows.map((row) => [row.stage, row.before, row.after, row.outcome, row.check]), [["prod", "beta-prod", "acme-prod", "keeps", "deployed"]]);
    assert.deepEqual(review.warnings, ["Applying edits cdk-app/cdk.json only; nothing is deployed."]);
    assert.throws(() => f.service.reviewDeployAs({ stage: "staging", deployAs: "x", hash }), /staging is not a stage/);
    assert.throws(() => f.service.reviewDeployAs({ stage: "prod", deployAs: "Bad_Name", hash }), /deployAs must be 1-63 lowercase/);
    assert.throws(() => f.service.reviewDeployAs({ stage: "prod", deployAs: "beta-prod", hash }), /already deploys as beta-prod/);
    f.service.apply(review.id);
    assert.deepEqual(f.read().context["framework:targets"].prod, { account, deployAs: "acme-prod" });
    // The undeclared dev stage gains an entry of its own.
    const dev = f.service.reviewDeployAs({ stage: "dev", deployAs: "acme-dev", hash: f.service.load().hash });
    f.service.apply(dev.id);
    assert.deepEqual(f.read().context["framework:targets"], { prod: { account, deployAs: "acme-prod" }, dev: { deployAs: "acme-dev" } });
  } finally { f.cleanup(); }
});

test("an invalid, unchanged or colliding name, an invalid id, and a changed file are refused without writing", async () => {
  const f = fixture({ "framework:app": "acme", "framework:appId": appId, "framework:targets": { prod: { account, deployAs: "beta-dev" } } });
  try {
    const hash = f.service.load().hash;
    await assert.rejects(f.service.review({ name: "Acme", hash }), /Use lowercase letters/);
    await assert.rejects(f.service.review({ name: "acme", hash }), /already called acme/);
    await assert.rejects(f.service.review({ name: "beta", hash }), /dev and prod stages would both deploy as beta-dev/);
    await assert.rejects(f.service.review({ name: "gamma", hash: "stale" }), (error: { status?: number }) => error.status === 409);
    const review = await f.service.review({ name: "gamma", hash });
    const before = readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8");
    writeFileSync(path.join(f.root, "cdk-app/cdk.json"), before.replace("\n}", ',\n  "edited": true\n}'));
    assert.throws(() => f.service.apply(review.id), /changed after review\. Nothing was written/);
    assert.equal(f.read().context["framework:app"], "acme");
  } finally { f.cleanup(); }
  const broken = fixture({ "framework:app": "acme", "framework:appId": "ACME", "framework:targets": {} });
  try {
    await assert.rejects(broken.service.review({ name: "beta", hash: broken.service.load().hash }), /framework:appId must be a lowercase UUID.*Fix it in cdk-app\/cdk.json/);
  } finally { broken.cleanup(); }
});

test("a typed name's fault is named without repeating the field's rule", () => {
  assert.equal(appNameFault(""), "Enter a name.");
  assert.equal(appNameFault("Acme"), "Use lowercase letters.");
  assert.equal(appNameFault("ac_me app"), "“_”, Spaces can't be used.");
  assert.equal(appNameFault("1acme"), "Start with a letter.");
  assert.equal(appNameFault("acme-"), "Don't end with a hyphen.");
  assert.equal(appNameFault("acme"), undefined);
  const unchanged = appNamePreview({ name: "acme", stages: [{ stage: "dev", mode: "dev", implicit: true }], hash: "x" }, "acme");
  assert.deepEqual([unchanged.unchanged, unchanged.problems], [true, []]);
});
