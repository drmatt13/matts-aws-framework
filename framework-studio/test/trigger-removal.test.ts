import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import type { ModelEdge } from "../shared/model";
import type { TriggerBinding } from "../shared/triggers";
import { triggerGuide, triggerGuideSummary } from "../shared/trigger-guide";

const repository = path.resolve(__dirname, "../..");
let root: string, builder: SnapshotBuilder, edits: EditService, stackFile: string, firstFile: string;
const native = () => builder.current!.snapshot.source.cdkLinks.edges.filter((edge) => edge.relation === "trigger" && edge.provenance === "source");
const find = (label: string, to?: string): ModelEdge => native().find((edge) => edge.label === label && (!to || edge.to === to))!;
const plan = (ids: readonly string[]) => edits.planBatch(ids.map((edge) => ({ kind: "nativeTrigger" as const, edge })), builder.current!.snapshot.revision);
const signature = (mode: "dev" | "prod") => builder.current!.snapshot.models[mode].edges.filter((edge) => edge.relation === "trigger" && edge.provenance === "source").map((edge) => `${edge.from}|${edge.to}|${edge.label}`).sort();

before(async () => {
  const cache = path.join(repository, ".cache/framework-studio"); mkdirSync(cache, { recursive: true }); root = mkdtempSync(path.join(cache, "trigger-removal-"));
  for (const directory of ["framework-config", "cdk-app/lib/framework", "cdk-app/bin"]) mkdirSync(path.join(root, directory), { recursive: true });
  cpSync(path.join(repository, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config"; import { defaults } from "./framework-config/defaults"; import { resources } from "./framework-config/resources"; import { first } from "./framework-config/first"; import { second } from "./framework-config/second"; export default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], services: [], events: [first, second] });');
  writeFileSync(path.join(root, "framework-config/resources.ts"), 'import { defineResources, resource } from "@repo/framework/config"; import type { Wired } from "../cdk-app/lib/stacks"; export const resources = defineResources({ wired: resource.stack<Wired>() });');
  stackFile = path.join(root, "cdk-app/lib/stacks.ts");
  writeFileSync(stackFile, `import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import { eventFunction } from "./framework/framework-events";
import { linkResources } from "./framework/framework-resources";
import { resources } from "../../framework-config/resources";
throw new Error("Stack source must never execute");
export class Wired extends cdk.Stack {
  public readonly pool: cognito.UserPool;
  public readonly queue: sqs.Queue;
  public readonly topic: sns.Topic;
  public readonly kept: sns.Topic;
  public readonly bus: events.EventBus;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.pool = new cognito.UserPool(this, "Pool", {
      selfSignUpEnabled: true,
      lambdaTriggers: {
        preSignUp: eventFunction(this, "first"),
        postConfirmation: eventFunction(this, "second"),
      },
    });
    this.queue = new sqs.Queue(this, "Queue", { visibilityTimeout: cdk.Duration.minutes(5) });
    this.topic = new sns.Topic(this, "Topic");
    this.kept = new sns.Topic(this, "Kept");
    this.bus = new events.EventBus(this, "Bus");
    eventFunction(this, "second").addEventSource(new sources.SqsEventSource(this.queue));
    this.topic.addSubscription(new subscriptions.LambdaSubscription(eventFunction(this, "first")));
    const nested = this.kept.addSubscription(new subscriptions.LambdaSubscription(eventFunction(this, "second")));
    new events.Rule(this, "Rule", { eventBus: this.bus, eventPattern: { source: ["orders"] }, targets: [new targets.LambdaFunction(eventFunction(this, "first")), new targets.LambdaFunction(eventFunction(this, "second"))] });
    linkResources(this, resources.wired);
  }
}
`);
  writeFileSync(path.join(root, "cdk-app/lib/framework/framework-resources.ts"), "export function linkResources(scope: unknown, reference: unknown) {}");
  writeFileSync(path.join(root, "cdk-app/lib/framework/framework-events.ts"), "export function eventFunction(scope: unknown, id: string): any { return undefined; }");
  writeFileSync(path.join(root, "cdk-app/bin/main.ts"), 'import { App } from "aws-cdk-lib"; import { Wired } from "../lib/stacks"; const app = new App(); new Wired(app, "Wired");');
  writeFileSync(path.join(root, "cdk-app/cdk.json"), '{"app":"tsx bin/main.ts"}');
  firstFile = path.join(root, "framework-config/first.ts");
  writeFileSync(firstFile, 'export const first = { first: { directory: "/lambda_functions/first" } } as const;\n');
  writeFileSync(path.join(root, "framework-config/second.ts"), 'export const second = { second: { directory: "/lambda_functions/second" } } as const;\n');
  builder = new SnapshotBuilder(root); edits = new EditService(root, builder); await builder.refresh();
});
after(async () => { await builder?.dispose(); assert.ok(root.startsWith(path.join(repository, ".cache/framework-studio") + path.sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test("each recognized native shape carries an exact removal span; nested wiring is refused with a reason", () => {
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
  const kinds = Object.fromEntries(native().map((edge) => [`${edge.label}->${edge.to}${edge.from.endsWith("kept") ? " (kept)" : ""}`, edge.removal && ("kind" in edge.removal ? edge.removal.kind : edge.removal.refused)]));
  assert.deepEqual(kinds, {
    "preSignUp->lambda:first": "property", "postConfirmation->lambda:second": "property",
    "SQS->lambda:second": "statement", "SNS subscription->lambda:first": "statement",
    "SNS subscription->lambda:second (kept)": "This wiring is part of a larger expression or assignment; edit it in source.",
    "EventBridge rule->lambda:first": "element", "EventBridge rule->lambda:second": "element",
  });
  for (const mode of ["dev", "prod"] as const) assert.ok(builder.current!.snapshot.models[mode].edges.some((edge) => edge.relation === "trigger" && edge.removal && "kind" in edge.removal), mode);
});

test("removing one Cognito hook deletes only its entry, warns, and undoes exact bytes", async () => {
  const original = readFileSync(stackFile, "utf8"), before = signature("dev");
  const review = await plan([find("preSignUp").id]);
  assert.equal(review.ok, true, JSON.stringify(review.preflight));
  assert.equal(readFileSync(stackFile, "utf8"), original, "review is offline");
  assert.deepEqual(review.changes.map((change) => change.file), ["cdk-app/lib/stacks.ts"]);
  assert.ok(review.impact.some((line) => /Removes native preSignUp .* cdk-app\/lib\/stacks\.ts:\d+/.test(line)), review.impact.join("\n"));
  assert.ok(review.impact.some((line) => line.startsWith("⚠ Cognito stops calling preSignUp")));
  assert.equal((await edits.applyBatch(review.planId)).status, "applied");
  const written = readFileSync(stackFile, "utf8");
  assert.doesNotMatch(written, /preSignUp/);
  assert.match(written, /lambdaTriggers: \{\n\s+postConfirmation: eventFunction\(this, "second"\),\n\s+\},/);
  for (const mode of ["dev", "prod"] as const) assert.deepEqual(signature(mode), before.filter((item) => !item.endsWith("|preSignUp")), mode);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(stackFile, "utf8"), original);
  assert.deepEqual(signature("dev"), before);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(stackFile, "utf8"), written);
  assert.equal((await edits.undo()).status, "applied");
});

test("removing every hook drops lambdaTriggers; statements, subscriptions and rule targets prune unused imports", async () => {
  const original = readFileSync(stackFile, "utf8");
  const review = await plan([find("preSignUp").id, find("postConfirmation").id, find("SQS").id, find("SNS subscription", "lambda:first").id, find("EventBridge rule", "lambda:second").id]);
  assert.equal(review.ok, true, JSON.stringify(review.preflight));
  assert.equal((await edits.applyBatch(review.planId)).status, "applied");
  const written = readFileSync(stackFile, "utf8");
  assert.doesNotMatch(written, /lambdaTriggers|addEventSource|SqsEventSource|import \* as sources/);
  assert.match(written, /this\.pool = new cognito\.UserPool\(this, "Pool", \{\n\s+selfSignUpEnabled: true,\n\s+\}\);/);
  assert.match(written, /targets: \[new targets\.LambdaFunction\(eventFunction\(this, "first"\)\)\]/);
  assert.match(written, /import \* as subscriptions/, "still used by the nested subscription");
  assert.deepEqual(signature("prod"), ["resource:wired.bus|lambda:first|EventBridge rule", "resource:wired.kept|lambda:second|SNS subscription"]);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(stackFile, "utf8"), original);
});

test("refused, stale or vanished native wiring is never written", async () => {
  const original = readFileSync(stackFile, "utf8");
  const kept = native().find((edge) => edge.from === "resource:wired.kept")!;
  await assert.rejects(plan([kept.id]), /part of a larger expression/);
  await assert.rejects(plan(["trigger:resource:wired.queue->lambda:first#cdk-app/lib/stacks.ts:1:SQS"]), /no longer in source/);
  const review = await plan([find("SQS").id]);
  assert.equal(review.ok, true);
  writeFileSync(stackFile, `${original}\n// concurrent edit\n`);
  try { await assert.rejects(edits.applyBatch(review.planId), /changed/); }
  finally { writeFileSync(stackFile, original); await builder.refresh(); }
  assert.equal(readFileSync(stackFile, "utf8"), original);
});

test("removing a framework trigger's last binding deletes the triggers property and the imports Studio added", async () => {
  const original = readFileSync(firstFile, "utf8");
  const binding: TriggerBinding = { event: "first", id: "orders", key: "wired.queue/orders", adapter: "sqs", resource: "resource:wired.queue", accepts: "sqs-batch", options: {} };
  // The queue already has a native consumer; remove it in the same review to free it.
  const add = await edits.planBatch([{ kind: "nativeTrigger", edge: find("SQS").id }], builder.current!.snapshot.revision);
  assert.equal((await edits.applyBatch(add.planId)).status, "applied");
  const declared = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [binding] }], builder.current!.snapshot.revision);
  assert.equal(declared.ok, true, JSON.stringify(declared.preflight));
  assert.equal((await edits.applyBatch(declared.planId)).status, "applied");
  assert.match(readFileSync(firstFile, "utf8"), /studioTrigger\.adapter\("sqs"/);
  const removal = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [] }], builder.current!.snapshot.revision);
  assert.equal(removal.ok, true, JSON.stringify(removal.preflight));
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.equal(readFileSync(firstFile, "utf8"), original, "no empty triggers array or dead import remains");
  for (let index = 0; index < 3; index++) assert.equal((await edits.undo()).status, "applied");
});

test("the guide covers every adapter with requirements, a snippet and candidates for this event", () => {
  const snapshot = builder.current!.snapshot;
  assert.deepEqual(triggerGuideSummary(snapshot, "first").map((item) => item.kind), ["cognito", "eventbridge", "sqs", "dynamodb", "sns", "s3", "schedule"]);
  assert.deepEqual(triggerGuideSummary(snapshot, "first").find((item) => item.kind === "schedule"), { kind: "schedule", label: "Schedule", usable: 1, resourceless: true });
  const sqs = triggerGuide(snapshot, "sqs", "first")!;
  assert.ok(sqs.requirements.some((line) => line === "first times out after 10s, so the queue visibility timeout must be at least 10s (AWS recommends 60s or more)."), sqs.requirements.join("\n"));
  assert.match(sqs.snippet, /public readonly queue: sqs\.Queue;\n[\s\S]*this\.queue = new sqs\.Queue\(this, "Queue", \{ visibilityTimeout: cdk\.Duration\.seconds\(60\) \}\);/);
  assert.match(sqs.catalogSnippet, /resource\.stack<MyStack>\(\)/);
  assert.match(sqs.candidates.find((item) => item.name === "queue")!.reason!, /native Lambda consumer/);
  assert.equal(triggerGuide(snapshot, "sns", "first")!.candidates.filter((item) => !item.reason).map((item) => item.name).sort().join(), "kept,topic");
  assert.equal(triggerGuide(snapshot, "dynamodb")!.candidates.length, 0);
  assert.match(triggerGuide(snapshot, "s3")!.snippet, /eventBridgeEnabled: true/);
});
