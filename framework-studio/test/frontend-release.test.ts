import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";
import { FrontendReleaseService, frontendSettings, frontendPath } from "../server/frontend-release";
import { DeploymentIdentityService } from "../server/deployment-identities";
import { DEFAULT_FRONTEND_RELEASE } from "../shared/frontend-release";

const repository = path.resolve(__dirname, "../..");
const cache = path.join(repository, ".cache/frontend-release-tests"); mkdirSync(cache, { recursive: true });
const account = "111122223333"; const region = "us-east-1";
function fixture(mode: "dev" | "prod" = "prod") {
  const root = mkdtempSync(path.join(cache, "case-"));
  for (const directory of ["cdk-app", "framework-config", "scripts", "web"]) mkdirSync(path.join(root, directory));
  writeFileSync(path.join(root, "package.json"), '{"private":true}');
  writeFileSync(path.join(root, "scripts/export-cdk-outputs.mjs"), `import ${JSON.stringify(pathToFileURL(path.join(repository, "scripts/export-cdk-outputs.mjs")).href)};`);
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:targets": { [`fixture-${mode}`]: { mode, account, region, inputs: "cdk-app/.env.staging" } } } }));
  writeFileSync(path.join(root, "cdk-app/.env.staging"), `PUBLIC_SETTING=public-from-target\nPRIVATE_SECRET=never-leak-secret\n`);
  writeFileSync(path.join(root, "cdk-app/.env.prod"), "PUBLIC_SETTING=wrong-conventional-file\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "CDK_APP_NAME=old-dev\nPUBLIC_SETTING=wrong-development-file\nSECRET=preserve-me\n# human comment\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev.template"), "PUBLIC_SETTING=template-dev\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod.template"), "PUBLIC_SETTING=template-prod\n");
  const binding = { kind: "input", name: "PUBLIC_SETTING" };
  writeFileSync(path.join(root, "framework-config/client-environment.ts"), `export const clientEnvironment = ${JSON.stringify({ VITE_PUBLIC: { dev: binding, prod: binding } })} as const;`);
  const settings = { ...DEFAULT_FRONTEND_RELEASE, projectDirectory: "web", prefix: "app/" };
  writeFileSync(path.join(root, "framework-config/frontend-release.json"), JSON.stringify(settings));
  writeFileSync(path.join(root, "web/package.json"), JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }));
  writeFileSync(path.join(root, "web/build.mjs"), `import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const env=readFileSync('.env.${mode === "prod" ? "production" : "development"}.local','utf8');
if(!env.includes('public-from-target')||env.includes('never-leak-secret'))throw new Error('wrong public env');
mkdirSync('dist/assets',{recursive:true});writeFileSync('dist/assets/app.js','console.log("fixture")');writeFileSync('dist/index.html','<!doctype html><title>Alternate frontend</title>');writeFileSync('dist/.env.secret','never-publish');writeFileSync('dist/assets/app.js.map','never-publish-map');`);
  const identity = { version: 1, deployment: `fixture-${mode}`, mode, account, region };
  const stack = { StackName: `${identity.deployment}-FrontendWebsiteS3Stack`, StackId: `arn:aws:cloudformation:${region}:${account}:stack/${identity.deployment}-FrontendWebsiteS3Stack/id`, StackStatus: "UPDATE_COMPLETE", Outputs: [
    { Description: "framework:deployment:v1", OutputValue: JSON.stringify(identity) },
    { OutputKey: "FrontendWebsiteBucketName", OutputValue: "fixture-owned-website" }, { OutputKey: "CloudFrontId", OutputValue: "EFIXTURE1234" }, { OutputKey: "CloudFrontUrl", OutputValue: "https://127.0.0.1:1" },
  ] };
  const state = path.join(root, "aws-state.json"); writeFileSync(state, JSON.stringify({ account, stack, failInvalidation: false, calls: [] }));
  const fake = path.join(root, "fake-aws.mjs");
  writeFileSync(fake, `import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.RELEASE_FAKE_STATE;const state=JSON.parse(readFileSync(file,'utf8'));const args=process.argv.slice(2);state.calls.push(args);writeFileSync(file,JSON.stringify(state));
const send=x=>console.log(JSON.stringify(x));const key=args.slice(0,2).join(' ');
if(key==='sts get-caller-identity')send({Account:state.account});
else if(key==='cloudformation describe-stacks')send({Stacks:[state.stack]});
else if(key==='cloudformation list-stack-resources')send({StackResourceSummaries:[{ResourceType:'AWS::S3::Bucket',PhysicalResourceId:'fixture-owned-website'},{ResourceType:'AWS::CloudFront::Distribution',PhysicalResourceId:'EFIXTURE1234'}]});
else if(key==='s3api head-bucket')send({});
else if(key==='cloudfront get-distribution')send({ETag:'fixture-etag',Distribution:{ARN:'arn:aws:cloudfront::111122223333:distribution/EFIXTURE1234',DistributionConfig:{Enabled:true,Origins:{Items:[{DomainName:state.origin??'fixture-owned-website.s3.us-east-1.amazonaws.com'}]}}}});
else if(key==='s3api list-objects-v2')send({Contents:[{Key:'app/old.js',ETag:'old'},{Key:'unrelated/keep',ETag:'keep'}]});
else if(key==='s3api put-object'||key==='s3api delete-object')send({});
else if(key==='cloudfront create-invalidation'){if(state.failInvalidation){console.error('injected failure');process.exit(1)}send({Invalidation:{Id:'I123FIXTURE',Status:'InProgress'}})}
else{console.error('unsupported fake command '+key);process.exit(2)}`);
  const service = new FrontendReleaseService(root, { env: { ...process.env, FRAMEWORK_INPUTS_FILE: undefined, FRAMEWORK_AWS_CLI: fake, RELEASE_FAKE_STATE: state, AWS_PROFILE: "should-be-replaced" } });
  return { root, service, state, input: { deployment: identity.deployment, profile: "dev", region }, settings,
    load: () => JSON.parse(readFileSync(state, "utf8")), save: (value: any) => writeFileSync(state, JSON.stringify(value)),
    cleanup: () => { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); } };
}

test("real public client export uses the named target inputs without Docker or control outputs", async () => {
  for (const mode of ["dev", "prod"] as const) {
    const fixtureCase = fixture(mode);
    try {
      const generated = await fixtureCase.service.generateEnvironment(fixtureCase.input);
      const contents = readFileSync(path.join(fixtureCase.root, generated.file), "utf8");
      assert.equal(parseEnv(contents).VITE_PUBLIC, "public-from-target");
      assert.doesNotMatch(contents, /never-leak-secret|wrong-conventional|wrong-development/);
      assert.equal(existsSync(path.join(fixtureCase.root, ".env")), false);
      assert.equal(existsSync(path.join(fixtureCase.root, ".framework/local/resources.json")), false);
      assert.ok(fixtureCase.load().calls.every((args: string[]) => !["s3", "cloudfront", "docker"].includes(args[0]!)));
    } finally { fixtureCase.cleanup(); }
  }
});

test("alternate frontend builds fresh, excludes secrets/maps, binds approval and retries failed invalidation", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "web/dist")); writeFileSync(path.join(f.root, "web/dist/stale.html"), "old artifact");
    const current = f.service.settings(); const settingsReview = f.service.settingsReview({ ...f.settings, deleteRemote: true }, current.hash);
    assert.equal(readFileSync(path.join(f.root, "framework-config/frontend-release.json"), "utf8"), JSON.stringify(f.settings), "settings review does not write");
    f.service.settingsApply(settingsReview.id);
    const review = await f.service.build(f.input);
    assert.deepEqual(review.files.map(file => file.path), ["assets/app.js", "index.html"]);
    assert.deepEqual(review.deleteKeys, ["app/old.js"]);
    assert.ok(existsSync(path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "previous-output/stale.html")));
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)), "build never publishes");
    await assert.rejects(f.service.publish(review.id, "Publish wrong bucket"), /exact.*approval/);
    const state = f.load(); state.failInvalidation = true; f.save(state);
    const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
    await assert.rejects(f.service.publish(review.id, approval), /No automatic rollback/);
    assert.equal(f.service.result(review.id).phase, "failed");
    assert.equal(f.service.result(review.id).uploaded.length, 2);
    const afterFailure = f.load(); afterFailure.failInvalidation = false; f.save(afterFailure);
    const result = await f.service.publish(review.id, approval);
    assert.equal(result.phase, "complete"); assert.equal(result.invalidationStatus, "InProgress");
    assert.match(result.message, /cache completion need separate verification/);
    const calls = f.load().calls as string[][];
    assert.equal(calls.filter(args => args[1] === "put-object").length, 2, "retry skips confirmed uploads");
    assert.ok(calls.filter(args => args[1] === "put-object").every(args => args[args.indexOf("--expected-bucket-owner") + 1] === account), "every upload pins bucket owner");
    assert.ok(calls.filter(args => args[1] === "put-object").every(args => args.includes("--checksum-sha256")), "S3 validates exact reviewed bytes even if a staged file changes during transport");
    const invalidations = calls.filter(args => args[1] === "create-invalidation");
    assert.equal(invalidations.length, 2); assert.equal(invalidations[0]![invalidationIndex(invalidations[0]!)], invalidations[1]![invalidationIndex(invalidations[1]!)], "retry preserves idempotency token");
    assert.ok(calls.findIndex(args => args[1] === "create-invalidation") > calls.findIndex(args => args[1] === "delete-object"));
    assert.ok(!JSON.stringify(review).includes("never-leak-secret"));
    await assert.rejects(f.service.publish(review.id, approval), /complete/);
  } finally { f.cleanup(); }
});
const invalidationIndex = (args: string[]) => args.indexOf("--invalidation-batch") + 1;

test("release refuses changed account, output identity, artifact bytes and no-op builds", async () => {
  const f = fixture();
  try {
    const state = f.load(); state.account = "999988887777"; f.save(state);
    await assert.rejects(f.service.generateEnvironment(f.input), /profile\/account\/region/);
    state.account = account; f.save(state);
    const review = await f.service.build(f.input);
    const staged = path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "assets/index.html");
    writeFileSync(staged, "changed");
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /artifact changed/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
    writeFileSync(path.join(f.root, "web/build.mjs"), "console.log('no output');");
    rmSync(path.join(f.root, "web/dist/.env.secret"));
    await assert.rejects(f.service.build(f.input), /without producing/);
    assert.throws(() => frontendSettings({ ...f.settings, outputDirectory: "../outside" }), /relative path/);
    assert.throws(() => frontendPath(f.root, "../outside"), /relative path/);
  } finally { f.cleanup(); }
});

test("source folders and changed public input sources are refused before publication", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "web/src")); writeFileSync(path.join(f.root, "web/src/main.ts"), "keep-source");
    const current = f.service.settings();
    assert.throws(() => f.service.settingsReview({ ...f.settings, outputDirectory: "src" }, current.hash), /generated build output folder/);
    assert.equal(f.service.settings().hash, current.hash, "an invalid output is rejected before saving or reading AWS");
    assert.equal(f.load().calls.length, 0);
    assert.equal(readFileSync(path.join(f.root, "web/src/main.ts"), "utf8"), "keep-source");
    const safe = f.service.settingsReview(f.settings, f.service.settings().hash); f.service.settingsApply(safe.id);
    const review = await f.service.build(f.input);
    writeFileSync(path.join(f.root, "cdk-app/.env.staging"), "PUBLIC_SETTING=changed-after-build\n");
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /mapping\/input sources/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
    const restarted = new FrontendReleaseService(f.root);
    assert.equal(restarted.result(review.id).phase, "failed", "durable results survive service restart");
    writeFileSync(path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "result.json"), "{broken");
    assert.throws(() => restarted.history(), /effects are unknown/);
  } finally { f.cleanup(); }
});

test("website output ownership and actual distribution origin are verified before builds or publication", async () => {
  const f = fixture();
  try {
    const state = f.load(); const bucket = state.stack.Outputs.find((output: any) => output.OutputKey === "FrontendWebsiteBucketName"); bucket.OutputValue = "unowned-other-bucket"; f.save(state);
    await assert.rejects(f.service.build(f.input), /not the bucket and distribution owned/);
    bucket.OutputValue = "fixture-owned-website"; state.origin = "unrelated-bucket.s3.us-east-1.amazonaws.com"; f.save(state);
    await assert.rejects(f.service.build(f.input), /no S3 origin for the reviewed bucket/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
  } finally { f.cleanup(); }
});

test("fresh dev/prod identity reviews preserve old target identities, comments and secrets and reject stale edits", () => {
  const f = fixture();
  try {
    const service = new DeploymentIdentityService(f.root);
    const beforeEnv = readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8");
    const original = JSON.parse(readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8"));
    const review = service.review({ mode: "dev", name: "campaign-dev", account, region }, service.load().hash);
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8"), beforeEnv);
    assert.doesNotMatch(JSON.stringify(review), /preserve-me/);
    service.apply(review.id);
    const after = readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8");
    assert.match(after, /CDK_APP_NAME=.?campaign-dev/); assert.match(after, /SECRET=preserve-me\n# human comment/);
    const targets = JSON.parse(readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8")).context["framework:targets"];
    assert.deepEqual(targets["fixture-prod"], original.context["framework:targets"]["fixture-prod"]);
    assert.deepEqual(targets["old-dev"], { mode: "dev", inputs: "cdk-app/.env.dev" }, "previous personal identity remains selectable");
    assert.throws(() => service.review({ mode: "dev", name: "campaign-dev", account, region }, service.load().hash), /already exists/);
    const prodBefore = readFileSync(path.join(f.root, "cdk-app/.env.prod"), "utf8");
    const prod = service.review({ mode: "prod", name: "campaign-prod", account, region }, service.load().hash);
    service.apply(prod.id); assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.prod"), "utf8"), prodBefore, "prod target key is authoritative; no competing env value");
    const stale = service.review({ mode: "dev", name: "campaign-next", account, region }, service.load().hash);
    writeFileSync(path.join(f.root, "cdk-app/.env.dev"), after + "HUMAN_CHANGE=keep\n");
    assert.throws(() => service.apply(stale.id), /Nothing was written/);
  } finally { f.cleanup(); }
});
