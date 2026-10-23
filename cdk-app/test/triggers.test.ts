import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack, CfnResource } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as kms from "aws-cdk-lib/aws-kms";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineResources, resource, trigger, type EventTrigger, type FrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { initializeFrameworkResources, linkResource, finalizeFrameworkResources } from "../lib/framework/framework-resources";
import { appEventRegistry } from "../lib/framework/framework-events";

const env = { account: "111122223333", region: "us-east-1" };
const catalog = defineResources({ pool: resource.cdk<cognito.IUserPool>(), bus: resource.cdk<events.IEventBus>(), dlq: resource.cdk<sqs.IQueue>() });
function setup(triggers: readonly EventTrigger[] = [], mode: "dev" | "prod" = "dev", native = false) {
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources: catalog, defaults, http: [], services: [], webSocket: [], events: [{ event: { directory: "/test/fixtures/workload-handler", triggers } }] }) as unknown as FrameworkConfig;
  const app = new App();
  initializeFrameworkResources(app, { config, mode, deployment: "test", readers: { env: {} } });
  const compute = new Stack(app, "AsynchronousLambdaFunctionsStack", { env });
  const owner = new Stack(app, "Owner", { env });
  const fn = new lambda.Function(compute, "Event", { code: lambda.Code.fromInline("exports.handler = async e => e"), handler: "index.handler", runtime: lambda.Runtime.NODEJS_24_X });
  appEventRegistry(app).lambda("event", fn);
  const pool = new cognito.UserPool(owner, "Pool", native ? { lambdaTriggers: { preSignUp: fn } } : {});
  linkResource(owner, catalog.pool, pool);
  const bus = new events.EventBus(owner, "Bus");
  linkResource(owner, catalog.bus, bus);
  const dlq = new sqs.Queue(owner, "DeadLetters", { encryptionMasterKey: new kms.Key(owner, "DlqKey") });
  linkResource(owner, catalog.dlq, dlq);
  return { app, owner, compute, fn, pool, bus };
}

test("Cognito descriptors use eventFunction and preserve native identity, permission scope and dependencies in both modes", () => {
  for (const mode of ["dev", "prod"] as const) {
    const declared = setup([trigger.cognito(catalog.pool, { id: "signup", operation: "preSignUp", accepts: "cognito" })], mode);
    const native = setup([], mode, true);
    finalizeFrameworkResources(declared.app);
    finalizeFrameworkResources(native.app);
    for (const key of ["owner", "compute"] as const) assert.deepEqual(Template.fromStack(declared[key]).toJSON(), Template.fromStack(native[key]).toJSON());
    assert.equal(declared.fn.node.path, "AsynchronousLambdaFunctionsStack/Event");
    assert.deepEqual(declared.owner.dependencies.map((stack) => stack.node.id), native.owner.dependencies.map((stack) => stack.node.id));
    assert.deepEqual(declared.compute.dependencies.map((stack) => stack.node.id), native.compute.dependencies.map((stack) => stack.node.id));
    declared.app.synth();
  }
});

test("native hooks, imported pools, unknown ownership and missing actual resources reject before attachments", () => {
  const descriptors = [trigger.cognito(catalog.pool, { id: "signup", operation: "preSignUp", accepts: "cognito" })];
  const occupied = setup(descriptors, "dev", true);
  assert.throws(() => finalizeFrameworkResources(occupied.app), /occupied by native wiring/);
  const imported = setup(descriptors);
  const pool = cognito.UserPool.fromUserPoolId(imported.owner, "Imported", "us-east-1_fixture");
  // Exercise the adapter directly with a linked imported pool in an isolated app.
  const { attachFrameworkTriggers } = require("../lib/framework/framework-triggers") as typeof import("../lib/framework/framework-triggers");
  const otherCatalog = defineResources({ imported: resource.cdk<cognito.IUserPool>() });
  const config = { ...defineFrameworkConfig({ networks: [fixtureVpc], resources: otherCatalog, defaults, http: [], webSocket: [], services: [], events: [] }), events: { event: { triggers: [trigger.cognito(otherCatalog.imported, { id: "signup", operation: "preSignUp", accepts: "cognito" })] } } } as unknown as FrameworkConfig;
  assert.throws(() => attachFrameworkTriggers(imported.app, config), /not linked in this graph/);
  linkResource(imported.owner, otherCatalog.imported, pool);
  assert.throws(() => attachFrameworkTriggers(imported.app, config), /imported pools do not support mutation/);
  const unknown = setup(descriptors);
  (unknown.pool.node.defaultChild as cognito.CfnUserPool).lambdaConfig = { "Fn::If": ["Condition", {}, {}] } as never;
  assert.throws(() => finalizeFrameworkResources(unknown.app), /unknown native ownership|occupied/);
});

test("EventBridge rules attach in the existing function owner, grant scoped invocation and synthesize without cycles", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([trigger.eventbridge(catalog.bus, { id: "orders", accepts: "eventbridge", eventPattern: { source: ["orders"] }, retryAttempts: 2, enabled: false, deadLetterQueue: catalog.dlq })], mode);
    finalizeFrameworkResources(current.app);
    current.fn.addEnvironment("SOURCE_BUS", current.bus.eventBusName);
    const template = Template.fromStack(current.compute);
    template.hasResourceProperties("AWS::Events::Rule", { State: "DISABLED", EventPattern: { source: ["orders"] } });
    const assembly = current.app.synth();
    const all = JSON.stringify(assembly.stacks.map((stack) => stack.template));
    assert.match(all, /events.amazonaws.com/);
    assert.match(all, /SourceArn/);
    assert.match(all, /DeadLetterConfig/);
    assert.match(all, /sqs:SendMessage/);
    assert.match(all, /kms:GenerateDataKey/);
    assert.match(all, /kms:Decrypt/);
    const name = Object.values(template.findResources("AWS::Events::Rule"))[0]!.Properties.Name;
    const policy = JSON.stringify(Template.fromStack(current.owner).findResources("AWS::SQS::QueuePolicy"));
    assert.ok(policy.includes(`:rule/${name}`));
    assert.ok(!policy.includes("Fn::ImportValue"), "a queue policy does not depend back on the rule stack");
    assert.doesNotMatch(all, /lambda:\*/);
    const rule = current.compute.node.findAll().find((node) => node instanceof CfnResource && node.cfnResourceType === "AWS::Events::Rule");
    assert.match(rule?.node.path ?? "", /^AsynchronousLambdaFunctionsStack\/FrameworkTrigger-[a-f0-9]+-orders\/Resource$/);
  }
});

test("changing the destination within an event owner preserves rule logical and physical identities", () => {
  const build = (destination: "first" | "second") => {
    const descriptor = trigger.eventbridge(catalog.bus, { id: "orders", accepts: "eventbridge", eventPattern: { source: ["orders"] } });
    const config = defineFrameworkConfig({ networks: [fixtureVpc], resources: catalog, defaults, http: [], webSocket: [], services: [], events: [{
      first: { directory: "/test/fixtures/workload-handler", triggers: destination === "first" ? [descriptor] : [] },
      second: { directory: "/test/fixtures/caller", triggers: destination === "second" ? [descriptor] : [] },
    }] }) as unknown as FrameworkConfig;
    const app = new App(); initializeFrameworkResources(app, { config, mode: "dev", deployment: "test", readers: { env: {} } });
    const owner = new Stack(app, "Owner", { env }), compute = new Stack(app, "AsynchronousLambdaFunctionsStack", { env });
    for (const id of ["first", "second"]) appEventRegistry(app).lambda(id, new lambda.Function(compute, id, { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = async e => e") }));
    linkResource(owner, catalog.bus, new events.EventBus(owner, "Bus"));
    finalizeFrameworkResources(app);
    return Template.fromStack(compute).findResources("AWS::Events::Rule");
  };
  const first = build("first"), second = build("second");
  assert.deepEqual(Object.keys(first), Object.keys(second));
  assert.equal(Object.values(first)[0]!.Properties.Name, Object.values(second)[0]!.Properties.Name);
  assert.notDeepEqual(Object.values(first)[0]!.Properties.Targets, Object.values(second)[0]!.Properties.Targets);
});

test("validation is atomic and imported buses cannot silently cross accounts", () => {
  const { attachFrameworkTriggers } = require("../lib/framework/framework-triggers") as typeof import("../lib/framework/framework-triggers");
  const descriptors = [trigger.eventbridge(catalog.bus, { id: "orders", accepts: "eventbridge", eventPattern: { source: ["orders"] } }), trigger.cognito(catalog.pool, { id: "signup", accepts: "cognito", operation: "preSignUp" })];
  const current = setup(descriptors, "dev", true);
  assert.throws(() => finalizeFrameworkResources(current.app), /occupied/);
  assert.equal(current.app.node.findAll().filter((node) => node instanceof CfnResource && node.cfnResourceType === "AWS::Events::Rule").length, 0);
  const imported = defineResources({ foreign: resource.cdk<events.IEventBus>() });
  const foreign = events.EventBus.fromEventBusArn(current.owner, "Foreign", "arn:aws:events:us-east-1:999999999999:event-bus/foreign");
  linkResource(current.owner, imported.foreign, foreign);
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources: imported, defaults, http: [], services: [], webSocket: [], events: [{ event: { directory: "/test/fixtures/workload-handler", triggers: [trigger.eventbridge(imported.foreign, { id: "foreign", accepts: "eventbridge", eventPattern: { source: ["orders"] } })] } }] }) as unknown as FrameworkConfig;
  assert.throws(() => attachFrameworkTriggers(current.app, config), /same explicit account and region/);
});
