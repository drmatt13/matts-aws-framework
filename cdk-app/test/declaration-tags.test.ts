import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack, CfnOutput, CfnResource, TagManager, Tags } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { defineDatabase, defineFrameworkConfig, defineNetwork, defineResources, resource, trigger, type FrameworkConfig, type DeclarationTags } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { applyFrameworkTags } from "../lib/framework/framework-tags";
import { initializeFrameworkResources, finalizeFrameworkResources, linkResource, linkResources } from "../lib/framework/framework-resources";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import { markInfrastructure } from "../lib/framework/framework-inventory";
import { appEventRegistry } from "../lib/framework/framework-events";
import { attachFrameworkTriggers } from "../lib/framework/framework-triggers";

const configuration = (resources: FrameworkConfig["resources"], extra = {}): FrameworkConfig => defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], services: [], events: [], ...extra } as never);
const tagsOf = (template: Template, type: string) => Object.values(template.findResources(type)).map((entry: any) => Object.fromEntries((entry.Properties?.Tags ?? []).map((tag: any) => [tag.Key, tag.Value])));

test("stack tags reach owned primary and supporting resources; member overrides preserve logical IDs", () => {
  class Data extends Stack {
    readonly bucket = new s3.Bucket(this, "Bucket");
    readonly queue = new sqs.Queue(this, "Queue");
    readonly external = s3.Bucket.fromBucketArn(this, "External", "arn:aws:s3:::external-example");
    readonly endpoint = "public-configuration";
  }
  const catalog = defineResources({ data: resource.stack<Data>({ tags: { area: "data", owner: "infra" }, members: { bucket: { tags: { area: "billing" } }, external: { tags: { area: "outside" } }, endpoint: { tags: { area: "logical" } } } }) });
  const app = new App(); const stack = new Data(app, "Data");
  new CfnOutput(stack, "Endpoint", { value: stack.endpoint });
  linkResources(stack, catalog.data);
  const before = [stack.getLogicalId(stack.bucket.node.defaultChild as CfnResource)];
  applyFrameworkTags(app, configuration(catalog));
  const template = Template.fromStack(stack);
  assert.deepEqual(Object.keys(template.findResources("AWS::S3::Bucket")), before);
  assert.deepEqual(tagsOf(template, "AWS::S3::Bucket"), [{ area: "billing", owner: "infra" }]);
  assert.deepEqual(tagsOf(template, "AWS::SQS::Queue"), [{ area: "data", owner: "infra" }]);
  assert.equal(Object.keys(template.findResources("AWS::S3::Bucket")).length, 1);
  assert.equal(Object.keys(template.findResources("Custom::AWS")).length, 0);
  assert.deepEqual(stack.tags.tagValues(), { area: "data", owner: "infra" });
});

test("consumer tags stay on compute and supporting role without traversing a grant to its producer", () => {
  const catalog = defineResources({ bucket: resource.cdk<s3.Bucket>({ tags: { area: "producer" } }) });
  const config = configuration(catalog, { http: [{ "/consume": { directory: "/lambda_functions/http_functions/consume", methods: ["GET"], tags: { area: "consumer" } } }] });
  const app = new App(); const stack = new Stack(app, "Application");
  const bucket = new s3.Bucket(stack, "Bucket"); linkResource(stack, catalog.bucket, bucket);
  const fn = new lambda.Function(stack, "Consumer", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=()=>{}") });
  new FrameworkTargetRegistry().lambda("consume", fn); bucket.grantRead(fn);
  applyFrameworkTags(app, config);
  const template = Template.fromStack(stack);
  assert.deepEqual(tagsOf(template, "AWS::S3::Bucket"), [{ area: "producer" }]);
  assert.deepEqual(tagsOf(template, "AWS::Lambda::Function"), [{ area: "consumer" }]);
  assert.deepEqual(tagsOf(template, "AWS::IAM::Role"), [{ area: "consumer" }]);
});

test("aliases of one native resource must agree regardless of catalog or linking order", () => {
  for (const reverse of [false, true]) {
    const catalog = defineResources({ first: resource.cdk<s3.Bucket>({ tags: { area: "first" } }), second: resource.cdk<s3.Bucket>({ tags: { area: "second" } }) });
    const app = new App(); const stack = new Stack(app, "Data"); const bucket = new s3.Bucket(stack, "Bucket");
    for (const ref of reverse ? [catalog.second, catalog.first] : [catalog.first, catalog.second]) linkResource(stack, ref, bucket);
    assert.throws(() => applyFrameworkTags(app, configuration(catalog)), /shared native resource.*explicit tag owner/);
  }
});

test("the database primary overrides catalog tags and RDS rejects service-reserved keys and values", () => {
  type Data = { readonly database: { readonly node: { readonly id: string; readonly path: string }; readonly connections: object } };
  for (const own of [{ area: "database" }, { "rds:reserved": "value" }, { area: "aws:reserved" }, { area: "" }] as DeclarationTags[]) {
    const catalog = defineResources({ data: resource.stack<Data>({ tags: { area: "stack", owner: "data" } }) });
    const network = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
    if (own.area !== "database") {
      assert.throws(() => defineDatabase({ id: "application", resource: catalog.data.database, vpc: network, tags: own }), /RDS tag/);
      continue;
    }
    const database = defineDatabase({ id: "application", resource: catalog.data.database, vpc: network, tags: own });
    const app = new App(); const stack = new Stack(app, "Data");
    const instance = new rds.CfnDBInstance(stack, "Database", { engine: "postgres", storageEncrypted: true });
    markInfrastructure(instance, "resource:data.database");
    const config = configuration(catalog, { networks: [network], database });
    if (own.area === "database") {
      applyFrameworkTags(app, config);
      assert.deepEqual(tagsOf(Template.fromStack(stack), "AWS::RDS::DBInstance"), [{ area: "database", owner: "data" }]);
    } else assert.throws(() => applyFrameworkTags(app, config), /RDS tag/);
  }
});


test("AWS tag limits include native keys and all missing deployment identity tags", () => {
  const authored = Object.fromEntries(Array.from({ length: 46 }, (_, index) => [`key${index}`, "value"]));
  const catalog = defineResources({ bucket: resource.cdk<s3.Bucket>({ tags: authored }) });
  const app = new App(); const stack = new Stack(app, "Data"); const bucket = new s3.Bucket(stack, "Bucket");
  TagManager.of(bucket.node.defaultChild as CfnResource)!.setTag("native", "keep");
  linkResource(stack, catalog.bucket, bucket);
  applyFrameworkTags(app, configuration(catalog));
  assert.throws(() => app.synth(), /47 native\/declaration tags plus 4 reserved deployment tags/);
});

test("higher-priority native CDK tags cannot silently disagree with declaration metadata", () => {
  const catalog = defineResources({ bucket: resource.cdk<s3.Bucket>({ tags: { area: "declared" } }) });
  const app = new App(); const stack = new Stack(app, "Data"); const bucket = new s3.Bucket(stack, "Bucket");
  linkResource(stack, catalog.bucket, bucket);
  Tags.of(bucket).add("area", "native", { priority: 1000 });
  applyFrameworkTags(app, configuration(catalog));
  assert.throws(() => app.synth(), /native CDK tagging overrides declaration tag "area"/);
});

test("native CDK overrides cannot corrupt protected stack or resource deployment identity", () => {
  for (const onStack of [false, true]) {
    const catalog = defineResources({ bucket: resource.cdk<s3.Bucket>() });
    const app = new App(); const stack = new Stack(app, "Data"); const bucket = new s3.Bucket(stack, "Bucket");
    initializeFrameworkResources(app, { config: configuration(catalog), mode: "prod", deployment: "example" });
    linkResource(stack, catalog.bucket, bucket);
    Tags.of(onStack ? stack : bucket).add("framework:owner", "different-owner", { priority: 1000 });
    finalizeFrameworkResources(app);
    assert.throws(() => app.synth(), /native tag "framework:owner" conflicts with protected framework deployment ownership/);
  }
});

test("an unsupported Scheduler schedule preserves its template while owned Lambda and role tags propagate", () => {
  const config = configuration(undefined, { events: [{ scheduled: { tags: { area: "workflows" }, triggers: [
    trigger.schedule({ id: "hourly", accepts: "schedule", expression: "rate(1 hour)" }),
    trigger.schedule({ id: "daily", accepts: "schedule", expression: "rate(1 day)" }),
  ] } }] });
  const app = new App(); const stack = new Stack(app, "Scheduled");
  const fn = new lambda.Function(stack, "Handler", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=()=>{}") });
  appEventRegistry(app).lambda("scheduled", fn);
  attachFrameworkTriggers(app, config);
  const schedules = stack.node.findAll().filter((node): node is scheduler.CfnSchedule => node instanceof scheduler.CfnSchedule);
  const nativeTemplates = () => schedules.map(native => stack.resolve(native._toCloudFormation()));
  const before = nativeTemplates();
  const logicalIds = () => stack.node.findAll().filter(CfnResource.isCfnResource).map(resource => stack.getLogicalId(resource)).sort();
  const originalIds = logicalIds();

  applyFrameworkTags(app, config);
  const template = Template.fromStack(stack);
  assert.deepEqual(nativeTemplates(), before, "schedule identity, target, timing and other properties stay equivalent");
  assert.deepEqual(logicalIds(), originalIds, "tagging creates no infrastructure");
  template.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
  assert.ok(!Object.values(template.toJSON().Resources).some((resource: any) => resource.Type.startsWith("Custom::") || resource.Type === "AWS::CloudFormation::CustomResource"), "no tagging API custom resource is introduced");
  assert.deepEqual(tagsOf(template, "AWS::Scheduler::Schedule"), [{}, {}], "individual schedules have no independently supported AWS tags");
  assert.deepEqual(tagsOf(template, "AWS::Lambda::Function"), [{ area: "workflows" }]);
  const roleTags = tagsOf(template, "AWS::IAM::Role");
  assert.equal(roleTags.length, 2, "both schedules keep CDK's existing shared invocation role");
  assert.ok(roleTags.every(tags => tags.area === "workflows"), "both workload and scheduler invocation roles retain their owner's tags");
});
