import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import type { DeployOverview, DiscoveryView, JobView, PlanView, StatusView, TeardownPlanView } from "../shared/deploy";
import { deployRouter } from "../server/deploy/routes";
import { DeployService } from "../server/deploy/service";
import { fakeAccount, frameworkStack, READ_VERB, REGION, type FakeAccount } from "../../cdk-app/test/support/fake-aws-state";

/**
 * Deploy & Run's routes end to end on a simulated machine: the real repository
 * scripts run against fake-aws (AWS), fake-cdk (the CDK CLI) and fake-docker
 * (the engine), so every path from a request to AWS and back is the real one.
 * Studio's own state lives in a scratch directory.
 */

const root = path.resolve(__dirname, "..", "..");
const FAKE_CDK = path.join(root, "cdk-app", "test", "support", "fake-cdk.mjs");
const FAKE_DOCKER = path.join(__dirname, "support", "fake-docker.mjs");
const SECRET_VALUE = "sentinel-openai-value-never-shown";

let account: FakeAccount;
let service: DeployService;
let server: Server;
let base: string;
const events: { event: string; data: any }[] = [];
let dockerState: string;
let exportDirectory: string;

before(async () => {
  account = fakeAccount({
    allowWrites: true,
    outputValues: {
      UserPoolId: "us-east-1_fakepool", UserPoolClientId: "fakeclient", UserPoolDomainUrl: "https://my-aws-app-dev.auth.us-east-1.amazoncognito.com",
      ReplayBucketName: "fake-replay-bucket", ReplayQueueUrl: "https://sqs.us-east-1.amazonaws.com/734849394764/fake-replay", ReplayQueueArn: "arn:aws:sqs:us-east-1:734849394764:fake-replay",
    },
    regions: { [REGION]: { stacks: [frameworkStack("alex-dev", "CognitoStack", "dev")] } },
  });
  exportDirectory = path.join(account.directory, "export");
  mkdirSync(path.join(exportDirectory, "client-app"), { recursive: true });
  const inputs = path.join(account.directory, "inputs.env");
  writeFileSync(inputs, [
    "CDK_APP_NAME=my-aws-app", "LOCAL_DEV_URL=http://localhost:3000", "LOCAL_AWS_REGION=us-east-1",
    "LOCAL_API_DEV_SERVER_HOST_PORT=8080", "LOCAL_WS_DEV_SERVER_HOST_PORT=8081", "LOCAL_INVOCATION_RUNNER_HOST_PORT=8090",
    "WS_TESTER_HOST_PORT=3001", "POSTGRES_HOST_PORT=5432", "PGADMIN_HOST_PORT=5050",
    "USE_FRONTEND_CUSTOM_DOMAIN=false", "USE_COGNITO_CUSTOM_DOMAIN=false", `OPENAI_API_KEY=${SECRET_VALUE}`, "",
  ].join("\n"));
  dockerState = path.join(account.directory, "docker.json");
  writeFileSync(dockerState, JSON.stringify({ engine: "stopped", desktop: true, compose: "5.1.0", services: [{ name: "postgres", health: "healthy" }, { name: "prisma-migrate", oneShot: true }, { name: "api-dev-server" }] }));
  const env: NodeJS.ProcessEnv = {
    ...account.env,
    FRAMEWORK_INPUTS_FILE: inputs,
    FRAMEWORK_CDK_CLI: FAKE_CDK,
    FRAMEWORK_DOCKER_CLI: FAKE_DOCKER,
    FAKE_DOCKER_STATE: dockerState,
    FRAMEWORK_EXPORT_DIRECTORY: exportDirectory,
    FRAMEWORK_POLL_MS: "20",
  };
  const idle = { file: process.execPath, args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], cwd: root, display: "idle" };
  service = new DeployService(root, (event, data) => events.push({ event, data }), {
    env, stateDirectory: path.join(account.directory, "studio"),
    managed: { "local-client": (childEnv) => ({ ...idle, env: childEnv, display: "npm --workspace client-app run dev" }) },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/deploy", deployRouter(service));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/deploy`;
});

after(async () => {
  await service.dispose();
  server.close();
  account.dispose();
});

async function get<T>(route: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() as T };
}

async function post<T>(route: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}

async function operate(kind: string, params: Record<string, unknown>): Promise<JobView> {
  const started = await post<JobView & { error?: string }>("/operations", { kind, params });
  assert.equal(started.status, 200, started.body.error);
  return service.jobs.wait(started.body.id);
}

function logOf(job: JobView): string {
  return service.jobs.log(job.id).lines.map((line) => line.text).join("\n");
}

test("the overview names this repository's targets, this machine's tools and the profiles, never a credential", async () => {
  const { status, body } = await get<DeployOverview>("/overview");
  assert.equal(status, 200);
  assert.deepEqual(body.targets.map((entry) => [entry.name, entry.mode, entry.origin]), [["my-aws-app", "dev", "personal"], ["my-aws-app-prod", "prod", "declared"]]);
  assert.deepEqual(body.profiles.map((profile) => profile.name).sort(), ["default", "dev"]);
  assert.equal(body.prerequisites.find((item) => item.id === "docker")?.status, "warn");
  assert.equal(body.local.docker.engine, "stopped");
  assert.equal(body.local.startedBy, "none");
  assert.doesNotMatch(JSON.stringify(body), /sentinel/);
});

test("discovery resolves the profile's account and finds every deployment by its own records, reading only", async () => {
  const { body } = await get<{ ok: boolean; value: DiscoveryView }>("/discover?profile=dev");
  assert.equal(body.ok, true);
  assert.deepEqual([body.value.context.account, body.value.context.region], ["734849394764", REGION]);
  assert.deepEqual(body.value.deployments.map((entry) => [entry.name, entry.mode]), [["alex-dev", "dev"]]);
  assert.deepEqual(body.value.targets.map((entry) => [entry.name, entry.status]), [["my-aws-app", "absent"], ["my-aws-app-prod", "absent"]]);
  assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), []);
});

test("an expired session is a classified problem the page can act on", async () => {
  const state = account.read();
  account.write({ ...state, failures: { "sts get-caller-identity": "expired" } });
  try {
    const { body } = await get<{ ok: boolean; problem: { kind: string } }>("/discover?profile=dev&force=1");
    assert.deepEqual([body.ok, body.problem.kind], [false, "expired"]);
  } finally {
    account.write({ ...account.read(), failures: {} });
  }
});

test("operations are validated before anything runs", async () => {
  assert.equal((await post("/operations", { kind: "deploy-plan", params: { deployment: "my-aws-app", profile: "nobody" } })).status, 400);
  assert.match((await post<{ error: string }>("/operations", { kind: "deploy-plan", params: { deployment: "alex-dev", profile: "dev" } })).body.error, /not a deployment this repository declares/);
  assert.match((await post<{ error: string }>("/operations", { kind: "deploy-plan", params: { deployment: "my-aws-app-prod", profile: "dev", autoApply: true } })).body.error, /applied only after its review/);
  assert.equal((await post("/operations", { kind: "destroy", params: { deployment: "alex-dev", mode: "dev", profile: "dev", confirm: "alex" } })).status, 428);
  assert.equal((await post("/operations", { kind: "rm -rf", params: {} })).status, 404);
  for (const kind of ["constructor", "toString", "__proto__"]) assert.equal((await post("/operations", { kind, params: {} })).status, 404, kind);
  assert.equal((await post("/operations", { kind: "local-start", params: { deployment: "my-aws-app-prod", profile: "dev" } })).status, 400);
});

test("Deploy development plans, applies a plan that needs no confirmation, verifies and exports", async () => {
  const job = await operate("deploy-plan", { deployment: "my-aws-app", profile: "dev", autoApply: true });
  assert.equal(job.status, "succeeded", logOf(job));
  assert.deepEqual(job.steps?.map((step) => step.status), ["done", "done"]);
  assert.match(job.summary ?? "", /deployed and verified/);
  const plan = await get<PlanView>(`/plans/${job.planId}`);
  assert.equal(plan.body.result?.status, "succeeded");
  assert.ok(plan.body.secrets.some((secret) => secret.name.endsWith("OPENAI_API_KEY")), "secrets are named");
  assert.doesNotMatch(JSON.stringify(plan.body), new RegExp(SECRET_VALUE), "and never valued");
  assert.doesNotMatch(logOf(job), new RegExp(SECRET_VALUE));
  assert.match(readFileSync(path.join(exportDirectory, ".env"), "utf8"), /LOCAL_FRAMEWORK_DEPLOYMENT=my-aws-app/);
  assert.ok(events.some((entry) => entry.event === "deploy-changed" && entry.data.deployment === "my-aws-app"));

  const status = await get<{ ok: boolean; value: StatusView }>("/status?profile=dev&deployment=my-aws-app&force=1");
  assert.equal(status.body.value.detail?.state.kind, "ready");
  assert.equal(status.body.value.detail?.local?.exported.fresh, true);
});

test("a production plan waits for review, and applying it needs the typed name", async () => {
  // A change set can reference only a secret that exists: creating it is asked for, not assumed.
  const first = await operate("deploy-plan", { deployment: "my-aws-app-prod", profile: "dev" });
  assert.equal(first.status, "succeeded", logOf(first));
  const waiting = (await get<PlanView>(`/plans/${first.planId}`)).body;
  assert.equal(waiting.status, "needs-secrets");
  assert.equal((await post("/operations", { kind: "deploy-apply", params: { plan: waiting.key, profile: "dev" } })).status, 409);
  assert.equal((await operate("deploy-discard", { plan: waiting.key, profile: "dev" })).status, "succeeded");

  const job = await operate("deploy-plan", { deployment: "my-aws-app-prod", profile: "dev", createSecrets: true });
  assert.equal(job.status, "succeeded", logOf(job));
  const plan = (await get<PlanView>(`/plans/${job.planId}`)).body;
  assert.deepEqual([plan.status, plan.review, plan.identity.mode, plan.confirmation.level], ["ready", "change-set", "prod", "name"]);
  assert.ok(plan.uncertainties.some((line) => /Created before review/.test(line)), "the secret it created is disclosed");
  const refused = await post<{ error: string }>("/operations", { kind: "deploy-apply", params: { plan: plan.key, profile: "dev" } });
  assert.equal(refused.status, 428);
  assert.match(refused.body.error, /Type my-aws-app-prod/);
  const discarded = await operate("deploy-discard", { plan: plan.key, profile: "dev" });
  assert.equal(discarded.status, "succeeded", logOf(discarded));
  assert.equal((await get(`/plans/${plan.key}`)).status, 404);
});

test("a production plan that fails part-way stays listed, unfinished, until it is discarded", async () => {
  account.write({ ...account.read(), fakeCdk: { failPrepare: ["my-aws-app-prod-NetworkStack"] } });
  try {
    const job = await operate("deploy-plan", { deployment: "my-aws-app-prod", profile: "dev" });
    assert.equal(job.status, "failed");
    const plans = (await get<{ key: string; status: string }[]>("/plans")).body;
    const unfinished = plans.find((plan) => plan.key === job.planId);
    assert.equal(unfinished?.status, "unfinished", "what it prepared in AWS is not forgotten");
    assert.ok(account.read().regions[REGION].stacks.some((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS"));
    const discarded = await operate("deploy-discard", { plan: job.planId, profile: "dev" });
    assert.equal(discarded.status, "succeeded", logOf(discarded));
    assert.equal((await get<{ key: string }[]>("/plans")).body.some((plan) => plan.key === job.planId), false);
    assert.equal(account.read().regions[REGION].stacks.some((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS"), false, "the empty stacks it created are gone");
  } finally {
    account.write({ ...account.read(), fakeCdk: {} });
  }
});

test("starting development needs Docker, starts the stack detached, then watches it; stopping stops all of it", async () => {
  const refused = await operate("local-start", { deployment: "my-aws-app", profile: "dev" });
  assert.equal(refused.status, "failed");
  assert.match(refused.summary ?? "", /Docker is not running/);

  const started = await operate("docker-start", {});
  assert.equal(started.status, "succeeded", logOf(started));

  const job = await operate("local-start", { deployment: "my-aws-app", profile: "dev" });
  assert.equal(job.status, "succeeded", logOf(job));
  const overview = (await get<DeployOverview>("/overview?force=1")).body;
  assert.equal(overview.local.startedBy, "studio");
  assert.equal(overview.local.watch.running, true);
  assert.equal(overview.local.client.running, true);
  assert.equal(overview.local.exported.deployment, "my-aws-app");
  assert.deepEqual(overview.local.services.map((entry) => [entry.name, entry.state, entry.oneShot]), [["api-dev-server", "running", false], ["postgres", "running", false], ["prisma-migrate", "exited", true]]);
  assert.equal(overview.local.services.find((entry) => entry.name === "postgres")?.health, "healthy");
  const up = readFileSync(`${dockerState}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((call: any) => call.args.join(" ") === "compose up --detach --build --remove-orphans");
  assert.equal(up.profile, "dev");

  const logs = await get<{ text: string }>("/local/logs?service=postgres");
  assert.match(logs.body.text, /listening/);

  const stopped = await operate("local-stop", {});
  assert.equal(stopped.status, "succeeded", logOf(stopped));
  const after = (await get<DeployOverview>("/overview?force=1")).body;
  assert.deepEqual([after.local.startedBy, after.local.watch.running, after.local.client.running], ["none", false, false]);
});

test("deleting needs the typed name; the teardown plan reads only, and the deletion follows it", async () => {
  const writesBefore = account.calls().filter((call) => !READ_VERB.test(call.key)).length;
  const teardown = await get<{ ok: boolean; value: TeardownPlanView }>("/teardown?profile=dev&deployment=my-aws-app&mode=dev");
  assert.equal(teardown.body.ok, true);
  assert.ok(teardown.body.value.stacks.length >= 3);
  assert.equal(account.calls().filter((call) => !READ_VERB.test(call.key)).length, writesBefore, "the teardown plan wrote nothing");

  const job = await operate("destroy", { deployment: "my-aws-app", mode: "dev", profile: "dev", confirm: "my-aws-app" });
  assert.equal(job.status, "succeeded", logOf(job));
  const remaining = account.read().regions[REGION].stacks.filter((stack: any) => stack.StackStatus !== "DELETE_COMPLETE").map((stack: any) => stack.StackName);
  assert.deepEqual(remaining.filter((name: string) => name.startsWith("my-aws-app-")), [], "no development stack remains");
  assert.ok(remaining.includes("alex-dev-CognitoStack"), "another deployment is untouched");
});

test("a job's log is replayable from any line, and preferences remember the profile per deployment", async () => {
  const job = service.jobs.list().find((entry) => entry.kind === "destroy")!;
  const all = (await get<{ lines: { seq: number }[] }>(`/jobs/${job.id}/log`)).body.lines;
  const rest = (await get<{ lines: { seq: number }[] }>(`/jobs/${job.id}/log?after=${all[2]!.seq}`)).body.lines;
  assert.deepEqual(rest.map((line) => line.seq), all.slice(3).map((line) => line.seq));
  const saved = await post<{ profiles: Record<string, string> }>("/preferences", { deployment: "my-aws-app-prod", profile: "dev" });
  assert.equal(saved.body.profiles["my-aws-app-prod"], "dev");
  assert.equal((await post("/preferences", { profile: "../../etc" })).status, 400);
});
