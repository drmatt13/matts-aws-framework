import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack, SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Template } from "aws-cdk-lib/assertions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { EcsServicesStack } from "../lib/framework/ecs-services-stack";
import { defineFrameworkConfig, defineResources, resource, getFrameworkTargets, dynamodb as workflowDynamodb, sequence, sqs as workflowSqs, workflow, type FrameworkConfig } from "@repo/framework/config";
import { createFrameworkWorkflows } from "../lib/framework/framework-composition";
import { initializeFrameworkResources, linkResource, finalizeFrameworkResources, resolveLinkedResource, applyNativeGrant, resolveDeploymentSecret } from "../lib/framework/framework-resources";
import { attachLambdaResources } from "../lib/framework/framework-cloud";
import { defaults } from "../../framework-config/defaults";

class CustomIdentifier extends Construct { public readonly identifier = new sqs.CfnQueue(this, "NativeIdentifier").attrArn; public readonly privateValue = SecretValue.unsafePlainText("sentinel-never-export"); }
const catalog = defineResources({
  queue: resource.cdk<sqs.IQueue>(), topic: resource.cdk<sns.ITopic>(),
  bus: resource.cdk<events.IEventBus>(), bucket: resource.cdk<s3.IBucket>(), table: resource.cdk<dynamodb.ITable>(),
  custom: resource.cdk<CustomIdentifier>(), apiKey: resource.secret(), optionalKey: resource.secret(),
});
const env = { account: "111122223333", region: "eu-west-2" };
function config(environment: Record<string, unknown> = {}): FrameworkConfig {
  return defineFrameworkConfig({ resources: catalog, defaults, http: [{ "/work": {
    directory: "/lambda_functions/http_functions/work", methods: ["POST"], auth: true, environment,
    cloud: { bindings: [catalog.queue.grantSendMessages(), catalog.bucket.grantRead("incoming/*")] },
  } }], webSocket: [], services: [], events: [], tasks: [], workflows: [] } as never);
}
function setup(configuration = config(), mode: "dev" | "prod" = "dev") {
  const app = new App();
  initializeFrameworkResources(app, { config: configuration, mode, deployment: "example", readers: { env: {} } });
  return { app, owner: new Stack(app, "Owner", { env }), consumer: new Stack(app, "Consumer", { env }) };
}

test("native constructs, a custom identifier and typed workflow queues share one late-linked catalog", () => {
  const configuration = config({ QUEUE_URL: catalog.queue.queueUrl, BUCKET: catalog.bucket.bucketName, CUSTOM: catalog.custom.identifier });
  const { app, owner, consumer } = setup(configuration);
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};" ) });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0], { config: configuration, mode: "dev" });
  const key = new kms.Key(owner, "Key");
  const queue = linkResource(owner, catalog.queue, new sqs.Queue(owner, "Jobs", { encryptionMasterKey: key }));
  linkResource(owner, catalog.bucket, new s3.Bucket(owner, "Uploads"));
  linkResource(owner, catalog.topic, new sns.Topic(owner, "Updates"));
  linkResource(owner, catalog.bus, new events.EventBus(owner, "Events"));
  linkResource(owner, catalog.table, new dynamodb.Table(owner, "Table", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } }));
  linkResource(owner, catalog.custom, new CustomIdentifier(owner, "Custom"));
  // A workflow reaching this queue resolves it through the same link, so there
  // is no separate integration binding to assert here.
  const role = new iam.Role(consumer, "Additional", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  for (const grant of [catalog.topic.grantPublish(), catalog.bus.grantPutEventsTo(), catalog.table.grantReadData()]) applyNativeGrant(consumer, role, grant, "lambda:work");
  for (const ref of [catalog.topic.topicArn, catalog.bus.eventBusName, catalog.table.tableName]) assert.equal(typeof resolveLinkedResource(consumer, ref, "lambda:work"), "string");
  finalizeFrameworkResources(app);
  const template = Template.fromStack(consumer).toJSON();
  const text = JSON.stringify(template);
  assert.match(text, /Fn::ImportValue/);
  assert.match(text, /sqs:SendMessage/);
  assert.match(text, /kms:GenerateDataKey/);
  assert.match(text, /kms:Decrypt/);
  assert.match(text, /incoming\/\*/);
  assert.doesNotMatch(text, /sqs:\*|sentinel-never-export/);
  assert.equal(queue.node.id, "Jobs");
  const outputs = Object.values(Template.fromStack(owner).toJSON().Outputs) as { Description?: string }[];
  assert.equal(outputs.filter(output => output.Description?.startsWith("framework:resource:v1:")).length, 3);
});

test("missing, duplicate, unavailable and invalid resource links fail with catalog context", () => {
  const { app, owner, consumer } = setup();
  assert.throws(() => resolveLinkedResource(consumer, catalog.queue.queueArn, "lambda:work"), /lambda:work.*resources.queue.queueArn.*not linked/);
  linkResource(owner, catalog.custom, new CustomIdentifier(owner, "Custom"));
  assert.throws(() => linkResource(owner, catalog.custom, new CustomIdentifier(owner, "Duplicate")), /linked twice.*Owner/);
  assert.throws(() => resolveLinkedResource(consumer, { ...catalog.custom.identifier, attribute: "privateValue" }, "lambda:work"), /not a public string/);
  assert.throws(() => resolveLinkedResource(consumer, { ...catalog.custom.identifier, absent: true }, "lambda:work", true), /declares it as undefined/);
  const role = new iam.Role(consumer, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  assert.throws(() => applyNativeGrant(consumer, role, { capability: "nativeGrant", resource: catalog.custom, method: "grantBogus", arguments: [] }, "lambda:work"), /lambda:work.*no grantBogus/);
  finalizeFrameworkResources(app);
});

test("resource-induced cycles name workloads and native owners", () => {
  const { app, owner, consumer } = setup();
  linkResource(owner, catalog.custom, new CustomIdentifier(owner, "Custom"));
  linkResource(consumer, catalog.queue, new sqs.Queue(consumer, "Queue"));
  resolveLinkedResource(consumer, catalog.custom.identifier, "lambda:one");
  resolveLinkedResource(owner, catalog.queue.queueUrl, "lambda:two");
  assert.throws(() => finalizeFrameworkResources(app), /Resource dependency cycle:.*lambda:two.*lambda:one/);
});

test("offline synthesis creates only required secret ARN parameters and no secret values", () => {
  const { app, owner } = setup(config(), "prod");
  assert.equal(resolveDeploymentSecret(owner, catalog.optionalKey), undefined);
  const secret = resolveDeploymentSecret(owner, catalog.apiKey, true);
  assert.ok(secret?.secretArn);
  finalizeFrameworkResources(app);
  const template = Template.fromStack(owner).toJSON();
  assert.equal(Object.values(template.Parameters).filter((parameter: any) => parameter.Description?.includes("Managed resource ARN")).length, 1);
  assert.doesNotMatch(JSON.stringify(template), /SecretString|sentinel-never-export|\.secret-bindings/);
});

test("concrete imported identifiers do not invent stack dependencies", () => {
  const { app, owner, consumer } = setup();
  owner.addStackDependency(consumer);
  linkResource(owner, catalog.topic, sns.Topic.fromTopicArn(owner, "Imported", "arn:aws:sns:eu-west-2:111122223333:existing"));
  resolveLinkedResource(consumer, catalog.topic.topicArn, "lambda:work");
  assert.doesNotThrow(() => finalizeFrameworkResources(app));
});

test("identifier delivery alone does not grant AWS service access", () => {
  const configuration = defineFrameworkConfig({ ...config(), http: [{ "/read": { directory: "/lambda_functions/http_functions/read", methods: ["GET"], auth: true, environment: { QUEUE: catalog.queue.queueUrl } } }] });
  const { app, owner, consumer } = setup(configuration, "prod");
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};" ) });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0], { config: configuration, mode: "prod" });
  linkResource(owner, catalog.queue, new sqs.Queue(owner, "Queue"));
  finalizeFrameworkResources(app);
  assert.doesNotMatch(JSON.stringify(Template.fromStack(consumer).toJSON()), /sqs:SendMessage|sqs:ReceiveMessage/);
});

test("conditional secret parameters and linked encryption permissions attach to ECS execution roles", () => {
  class CredentialsStack extends Stack { public readonly credentials!: secretsmanager.ISecret; }
  const resources = defineResources({ provider: resource.fromEnv().enum("native", "external").default("native"), apiKey: resource.secret(), vault: resource.stack<CredentialsStack>() });
  for (const provider of ["native", "external"]) {
    const configuration = defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], events: [], tasks: [], workflows: [], services: [{ "/example/*": {
      directory: "/ecs_containers/services/langgraph", port: 5000, auth: true, methods: "*", deploy: "both", environment: { PROVIDER: resources.provider },
      secrets: { API_KEY: resources.apiKey, CREDENTIALS: resources.vault.credentials.value },
      cloud: { requirements: [{ when: { resource: resources.provider, equals: "external" }, require: [resources.apiKey] }] },
    } }] });
    const app = new App(); initializeFrameworkResources(app, { config: configuration, mode: "prod", deployment: "example", readers: { env: { PROVIDER: provider } } });
    const stack = new EcsServicesStack(app, `Services${provider}`, { env, config: configuration, cloud: { mode: "prod" } });
    const owner = new Stack(app, `Resources${provider}`, { env });
    linkResource(owner, resources.vault.credentials, new secretsmanager.Secret(owner, "Credentials", { encryptionKey: new kms.Key(owner, "Key") }));
    finalizeFrameworkResources(app);
    const template = Template.fromStack(stack).toJSON();
    const params = Object.values(template.Parameters ?? {}).filter((value: any) => value.Description?.includes("Managed resource ARN"));
    assert.equal(params.length, provider === "external" ? 1 : 0);
    const policies = Object.values(template.Resources).filter((resource: any) => resource.Type === "AWS::IAM::Policy") as any[];
    const reads = policies.filter(policy => JSON.stringify(policy.Properties.PolicyDocument).includes("secretsmanager:GetSecretValue"));
    assert.ok(reads.length);
    for (const policy of reads) assert.match(JSON.stringify(policy.Properties.Roles), /ExecutionRole/);
    assert.match(JSON.stringify(reads), /kms:Decrypt/);
    assert.doesNotMatch(JSON.stringify(template), /sentinel-raw-secret|SecretString/);
  }
});

// These compile-time assertions are part of cdk-app's required typecheck.
function typeBoundaries(scope: Stack, queue: sqs.IQueue, bucket: s3.IBucket): void {
  linkResource(scope, catalog.queue, queue);
  // @ts-expect-error A bucket cannot satisfy a queue reference.
  linkResource(scope, catalog.queue, bucket);
  // @ts-expect-error Construct object attributes cannot be workload strings.
  catalog.queue.node;
  // @ts-expect-error Native grant argument types are preserved.
  catalog.queue.grantSendMessages(123);
  // @ts-expect-error SecretValue is not a public string attribute.
  catalog.custom.privateValue;
  // @ts-expect-error Arbitrary construct methods are not exposed.
  catalog.bucket.addEventNotification;
}

test("a development deployment publishes the tables and queues its local workflows reach", () => {
  const configuration = defineFrameworkConfig({ ...config(), workflows: [{ "local-flow": workflow<{ id: string }>(({ input }) => sequence(
    workflowDynamodb.put(catalog.table, { item: { pk: input.id } }),
    workflowSqs.request<{ id: string }, { ok: boolean }>(catalog.queue, { id: input.id }, { timeoutSeconds: 60 }),
  ), { timeoutSeconds: 300, deploy: "local-only" }) }] } as never);
  const { app, owner } = setup(configuration);
  createFrameworkWorkflows(app, { env, stackId: (name) => name, config: configuration, mode: "dev" });
  // Linked after the workflows are composed, as an application stack may be.
  linkResource(owner, catalog.queue, new sqs.Queue(owner, "Approvals"));
  linkResource(owner, catalog.table, new dynamodb.Table(owner, "Ledger", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } }));
  finalizeFrameworkResources(app);
  const outputs = Object.values(Template.fromStack(owner).toJSON().Outputs) as { Description?: string }[];
  const published = outputs.map((output) => output.Description ?? "").filter((description) => description.startsWith("framework:workflow-integration:"));
  assert.deepEqual(published.sort(), ["framework:workflow-integration:queue:queue", "framework:workflow-integration:table:table"]);
  // No state machine exists in development, so nothing is granted either.
  assert.equal(app.node.findAll().some((construct) => construct.node.id === "WorkflowsStack"), false);
});
