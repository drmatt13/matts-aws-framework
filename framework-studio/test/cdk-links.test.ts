import assert from "./support/assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { scanCdkLinks } from "../server/source/cdk-links";
import type { SourceLocation } from "../shared/model";

function scan(body: string, linked = true, extraImports = "", constructorParameters = "") {
  const cache = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "scan-"));
  const text = `import { SqsSubscription as Sub, LambdaSubscription as LambdaSub } from "aws-cdk-lib/aws-sns-subscriptions";
    import { eventFunction as eventFn } from "./cdk-app/lib/framework/framework-events";
    import * as cognito from "aws-cdk-lib/aws-cognito";
    import { SqsEventSource, DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
    import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
    import { Rule } from "aws-cdk-lib/aws-events";
    import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
    ${extraImports}
    class Stack { constructor(${constructorParameters}) { ${body}\nlinkResources(this, resources.example); } }`;
  const file = "stack.ts";
  const location: SourceLocation = { file, line: 1, column: 1, start: 0, end: 0 };
  const start = text.indexOf("linkResources(");
  const link = { ...location, start, end: text.indexOf(";", start) };
  writeFileSync(path.join(root, file), text);
  try {
    return scanCdkLinks(root, new Map([["example", { key: location, value: location, stack: {
      className: "Stack", location, members: ["topic", "queue", "dlq", "pool", "bucket", "table", "bus"].map((name) => ({ name, typeText: "unknown", category: "construct" as const, location })),
    } }]]), linked ? { example: [link] } : {});
  } finally { rmSync(root, { recursive: true }); }
}

test("CDK scan resolves named import aliases and const member aliases", () => {
  const result = scan("const target = this.queue; this.topic.addSubscription(new Sub(target));");
  assert.deepEqual(result.edges.map(({ from, to, label }) => ({ from, to, label })), [
    { from: "resource:example.topic", to: "resource:example.queue", label: "SNS subscription" },
  ]);
  assert.deepEqual(result.edges[0]!.permissionContext, { kind: "subscription", protocol: "sqs" });
});

test("native Cognito hooks resolve event aliases and a local constructor published later", () => {
  const result = scan(`
    const fn = eventFn(this, "signup");
    const pool = new cognito.UserPool(this, "pool", { lambdaTriggers: {
      preSignUp: fn, customMessage: eventFn(this, "message"),
    } });
    this.pool = pool;
  `);
  assert.deepEqual(result.edges.filter((edge) => edge.relation === "trigger").map((edge) => [edge.from, edge.to, edge.label]).sort(), [
    ["resource:example.pool", "lambda:message", "customMessage"], ["resource:example.pool", "lambda:signup", "preSignUp"],
  ]);
  assert.ok(result.edges.every((edge) => edge.sourceConstruct === "cdk.aws_cognito.UserPool"));
  assert.equal(result.manualWiring.length, 0);
});

test("trigger constructor provenance resolves CDK import aliases to canonical names", () => {
  for (const [imports, constructor] of [
    ['import { UserPool as AuthDirectory } from "aws-cdk-lib/aws-cognito";', "AuthDirectory"],
    ['import { aws_cognito as identity } from "aws-cdk-lib";', "identity.UserPool"],
    ['import * as infrastructure from "aws-cdk-lib";', "infrastructure.aws_cognito.UserPool"],
  ]) {
    const result = scan(`this.pool = new ${constructor}(this, "pool", {
      lambdaTriggers: { preSignUp: eventFn(this, "signup") },
    });`, true, imports);
    assert.equal(result.edges.find((edge) => edge.relation === "trigger")?.sourceConstruct, "cdk.aws_cognito.UserPool");
  }
});

test("method trigger provenance uses an actual constructor and omits unknown constructors", () => {
  const result = scan(`this.pool = new cognito.UserPool(this, "pool", {});
    this.pool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, eventFn(this, "signup"));`);
  assert.equal(result.edges.find((edge) => edge.relation === "trigger")?.sourceConstruct, "cdk.aws_cognito.UserPool");
  const unknown = scan('this.pool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, eventFn(this, "signup"));');
  assert.equal(unknown.edges.find((edge) => edge.relation === "trigger")?.sourceConstruct, undefined);
  const custom = scan('this.pool = new CustomPool(this, "pool", { lambdaTriggers: { preSignUp: eventFn(this, "signup") } });',
    true, 'import { CustomPool } from "./application-pool";');
  assert.equal(custom.edges.find((edge) => edge.relation === "trigger")?.sourceConstruct, undefined);
});

test("constructor provenance omits imports shadowed by parameters or local declarations", () => {
  const hooks = '{ lambdaTriggers: { preSignUp: eventFn(this, "signup") } }';
  const cases = [
    scan(`this.pool = new cognito.UserPool(this, "pool", ${hooks});`, true, "", "cognito: CustomConstructs"),
    scan(`this.pool = new cognito.UserPool(this, "pool", ${hooks});`, true, "", "{ cognito }: CustomConstructs"),
    scan(`const cognito = customConstructs; this.pool = new cognito.UserPool(this, "pool", ${hooks});`),
    scan(`const Pool = CustomPool; this.pool = new Pool(this, "pool", ${hooks});`, true,
      'import { UserPool as Pool } from "aws-cdk-lib/aws-cognito";'),
  ];
  for (const result of cases) {
    const triggers = result.edges.filter((edge) => edge.relation === "trigger");
    assert.equal(triggers.length, 1, "constructor display metadata does not change existing trigger discovery");
    assert.equal(triggers[0]!.sourceConstruct, undefined);
    assert.ok(triggers[0]!.removal, "existing removal evidence is preserved");
  }
});

test("native SNS, queues, streams, S3 notifications and EventBridge rules have directed event edges", () => {
  for (const [body, member, label, sourceConstruct] of [
    ['this.topic.addSubscription(new LambdaSub(eventFn(this, "event")));', "topic", "SNS subscription", "cdk.aws_sns_subscriptions.LambdaSubscription"],
    ['const fn = eventFn(this, "event"); fn.addEventSource(new SqsEventSource(this.queue));', "queue", "SQS", "cdk.aws_lambda_event_sources.SqsEventSource"],
    ['eventFn(this, "event").addEventSource(new DynamoEventSource(this.table, {}));', "table", "DynamoDB stream", "cdk.aws_lambda_event_sources.DynamoEventSource"],
    ['this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new LambdaDestination(eventFn(this, "event")));', "bucket", "s3.EventType.OBJECT_CREATED", "cdk.aws_s3_notifications.LambdaDestination"],
    ['new Rule(this, "rule", { eventBus: this.bus, eventPattern: { source: ["fixture"] }, targets: [new LambdaFunction(eventFn(this, "event"))] });', "bus", "EventBridge rule", "cdk.aws_events.Rule"],
  ]) {
    const result = scan(body!);
    assert.deepEqual(result.edges.filter((edge) => edge.relation === "trigger").map((edge) => [edge.from, edge.to, edge.label]), [[`resource:example.${member}`, "lambda:event", label]]);
    assert.ok(result.edges[0]?.source?.line);
    assert.equal(result.edges.find(edge => edge.relation === "trigger")?.permissionContext?.kind, "trigger", "native adapter evidence survives source scanning");
    assert.equal(result.edges.find(edge => edge.relation === "trigger")?.sourceConstruct, sourceConstruct);
    assert.equal(result.manualWiring.length, 0);
  }
});

test("unknown native ownership and conditional wiring remain manual rather than free slots", () => {
  for (const body of [
    'this.pool = new cognito.UserPool(this, "pool", { lambdaTriggers: { preSignUp: helper() } });',
    'if (enabled) this.pool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, eventFn(this, "event"));',
    'const fn = eventFn(this, "event"); fn.addEventSource(helper(this.queue));',
    'this.bucket.addEventNotification(type, helper());',
    'wireNativeHook(this.pool, eventFn(this, "event"));',
  ]) {
    const result = scan(body);
    assert.equal(result.edges.filter((edge) => edge.relation === "trigger").length, 0);
    assert.ok(result.manualWiring.length, body);
    assert.ok(result.manualWiring.every((item) => item.reason === "Manual wiring, review required" && item.source.file === "stack.ts"));
  }
});

test("CDK scan omits unlinked, conditional, private, dynamic and unknown subscription relationships", () => {
  assert.equal(scan("this.topic.addSubscription(new Sub(this.queue));", false).edges.length, 0);
  assert.equal(scan(`
    if (enabled) this.topic.addSubscription(new Sub(this.queue));
    const helper = () => this.topic.addSubscription(new Sub(this.queue));
    this.topic.addSubscription(new Unknown(this.queue));
    this.topic.addSubscription(new Sub(this.privateQueue));
    this.topic.addSubscription(new Sub(this[name]));
  `).edges.length, 0);
});

test("CDK scan keeps source evidence without copying values into its JSON", () => {
  const result = scan('this.queue = new Queue(this, "queue", { deadLetterQueue: { queue: this.dlq }, token: "DO_NOT_COPY" });');
  assert.equal(result.edges[0]?.label, "Dead-letter queue");
  assert.equal(result.edges[0]?.source?.file, "stack.ts");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_COPY"));
  assert.equal(Object.values(result.files)[0]?.length, 64);
});
