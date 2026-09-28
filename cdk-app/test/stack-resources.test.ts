import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { defineFrameworkConfig, defineResources, resource, getFrameworkTargets, type FrameworkConfig } from "@repo/framework/config";
import { initializeFrameworkResources, linkResources, finalizeFrameworkResources } from "../lib/framework/framework-resources";
import { attachLambdaResources } from "../lib/framework/framework-cloud";
import { defaults } from "../../framework-config/defaults";

/**
 * A stack whose public fields are its resource catalog.
 *
 * `hidden` is private, so it never reaches the catalog: `keyof` does not offer
 * it. `plain` is a string rather than a construct and is a resource all the
 * same — a stack answers for its computed values too — and `hiddenTopicArn`
 * shows the same for an accessor, which is how a private construct publishes
 * one attribute without publishing itself.
 */
class ExampleStack extends Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly processingQueue: sqs.Queue;
  public readonly plain = "not-a-construct";
  private readonly hidden: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id, { env: { account: "111122223333", region: "eu-west-2" } });
    this.documentsBucket = new s3.Bucket(this, "Documents");
    this.processingQueue = new sqs.Queue(this, "Processing");
    this.hidden = new sns.Topic(this, "Hidden");
    linkResources(this, catalog.referenceExamples);
  }

  public get hiddenTopicArn(): string {
    return this.hidden.topicArn;
  }
}

const catalog = defineResources({
  referenceExamples: resource.stack<ExampleStack>(),
  apiKey: resource.secret(),
});

function config(): FrameworkConfig {
  return defineFrameworkConfig({
    resources: catalog, defaults, http: [{ "/work": {
      directory: "/lambda_functions/http_functions/work", methods: ["POST"], auth: true,
      environment: {
        DOCUMENTS_BUCKET: catalog.referenceExamples.documentsBucket.bucketName,
        QUEUE_URL: catalog.referenceExamples.processingQueue.queueUrl,
      },
      cloud: { bindings: [catalog.referenceExamples.documentsBucket.grantRead("uploads/*")] },
    } }], webSocket: [], services: [], events: [], tasks: [], workflows: [],
  } as never);
}

function setup(configuration = config()) {
  const app = new App();
  initializeFrameworkResources(app, { config: configuration, mode: "dev", deployment: "example", readers: { env: {} } });
  return app;
}

test("a stack's public constructs become the catalog, and reach a workload in another stack", () => {
  const configuration = config();
  const app = setup(configuration);
  const owner = new ExampleStack(app, "Owner");
  const consumer = new Stack(app, "Consumer", { env: { account: "111122223333", region: "eu-west-2" } });
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};") });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0]!, { config: configuration, mode: "dev" });
  finalizeFrameworkResources(app);

  const text = JSON.stringify(Template.fromStack(consumer).toJSON());
  // The bucket name arrives as a cross-stack import, not a hardcoded string.
  assert.match(text, /Fn::ImportValue/);
  assert.match(text, /DOCUMENTS_BUCKET/);
  assert.match(text, /QUEUE_URL/);
  // The grant travelled with the reference, scoped to the prefix it was given.
  assert.match(text, /s3:GetObject/);
  assert.match(text, /uploads\/\*/);
  // Delivering a queue URL is not permission to use the queue.
  assert.doesNotMatch(text, /sqs:SendMessage|sqs:ReceiveMessage/);
  // Exactly the two members a workload asked for are published for local dev,
  // and the private topic is not among them.
  const outputs = Object.values(Template.fromStack(owner).toJSON().Outputs as Record<string, { Description?: string }>)
    .map((output) => output.Description ?? "")
    .filter((description) => description.startsWith("framework:resource:v1:"));
  assert.deepEqual(outputs.sort(), [
    'framework:resource:v1:[["referenceExamples","documentsBucket"],"bucketName"]',
    'framework:resource:v1:[["referenceExamples","processingQueue"],"queueUrl"]',
  ]);
  assert.ok(owner.hiddenTopicArn);
});

test("a reference into an undeclared stack is refused by the catalog", () => {
  const other = defineResources({ referenceExamples: resource.stack<ExampleStack>() });
  assert.throws(
    () => defineFrameworkConfig({
      resources: { apiKey: resource.secret() }, defaults,
      http: [{ "/work": { directory: "/lambda_functions/http_functions/work", methods: ["POST"], auth: true,
        environment: { BUCKET: other.referenceExamples.documentsBucket.bucketName } } }],
      webSocket: [], services: [], events: [], tasks: [], workflows: [],
    } as never),
    /not declared in this config's "resources" catalog/,
  );
});

test("a stack's group is refused a whole-resource link and an empty stack", () => {
  const app = setup();
  const empty = new Stack(app, "Empty", { env: { account: "111122223333", region: "eu-west-2" } });
  assert.throws(
    () => linkResources(empty as never, catalog.referenceExamples),
    /found nothing to link/,
  );
  assert.throws(
    () => linkResources(empty as never, catalog.apiKey as never),
    /takes a resource\.stack\(\) entry/,
  );
});

test("a stack cannot be declared inside a group", () => {
  assert.throws(
    () => defineResources({ nested: { inner: resource.stack<ExampleStack>() } }),
    /declares a stack inside a group/,
  );
});

test("a stack member nobody linked names the stack and linkResources, not the escape hatch", () => {
  const configuration = config();
  const app = setup(configuration);
  // The owning stack is never constructed: the commonest way to get here.
  const consumer = new Stack(app, "Consumer", { env: { account: "111122223333", region: "eu-west-2" } });
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};") });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0]!, { config: configuration, mode: "dev" });
  assert.throws(
    () => finalizeFrameworkResources(app),
    (error: Error) => {
      assert.match(error.message, /resources\.referenceExamples\.documentsBucket.* is not linked/);
      assert.match(error.message, /linkResources\(this, resources\.referenceExamples\)/);
      assert.doesNotMatch(error.message, /linkResource\(scope/);
      return true;
    },
  );
});
