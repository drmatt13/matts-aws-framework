import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_OUTPUT_DESCRIPTION,
  identityFromOutputs,
  identityFromTemplate,
  parseIdentity,
  stackLocation,
} from "@repo/framework/deploy";

const identity = { deployment: "app", mode: "dev", account: "111122223333", region: "eu-west-2" } as const;
const raw = (value: Record<string, unknown>) => JSON.stringify({ version: 1, ...identity, ...value });

test("parseIdentity accepts the v1 deployment identity", () => {
  assert.deepEqual(parseIdentity(raw({})), identity);
  assert.equal(DEPLOYMENT_OUTPUT_DESCRIPTION, "framework:deployment:v1");
});

test("parseIdentity refuses anything that is not a complete v1 identity", () => {
  for (const value of [raw({ version: 2 }), raw({ mode: "staging" }), raw({ account: "123" }), raw({ region: undefined }), raw({ deployment: "" }), "not json", "[]"]) {
    assert.throws(() => parseIdentity(value), /Invalid deployment metadata/, value);
  }
});

test("identityFromOutputs reads the identity output and nothing else", () => {
  assert.equal(identityFromOutputs({ Outputs: [{ Description: "something else", OutputValue: raw({}) }] }), undefined);
  assert.equal(identityFromOutputs({}), undefined);
  assert.deepEqual(identityFromOutputs({ Outputs: [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: raw({}) }] }), identity);
  assert.throws(() => identityFromOutputs({ StackName: "app-Stack", Outputs: [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: "{}" }] }), /Invalid deployment metadata in app-Stack/);
});

test("identityFromTemplate recovers the identity a stack without outputs was created from", () => {
  const template = { Resources: {}, Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: raw({}) } } };
  assert.deepEqual(identityFromTemplate(template), identity);
  assert.deepEqual(identityFromTemplate(JSON.stringify(template)), identity);
  assert.equal(identityFromTemplate({ Resources: {} }), undefined);
  assert.equal(identityFromTemplate({ Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: { "Fn::Join": ["", []] } } } }), undefined);
  assert.equal(identityFromTemplate("Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n"), undefined);
  assert.equal(identityFromTemplate(undefined), undefined);
});

test("stackLocation reads the account and region from a stack ARN", () => {
  assert.deepEqual(stackLocation("arn:aws:cloudformation:eu-west-2:111122223333:stack/App/id"), { account: "111122223333", region: "eu-west-2" });
  assert.equal(stackLocation("not-an-arn"), undefined);
  assert.equal(stackLocation(undefined), undefined);
});

test("contract 2: the identity is read from stack tags, metadata or outputs, and they must agree", async () => {
  const { DEPLOYMENT_METADATA_KEY, FRAMEWORK_OWNER, identityFromMetadata, identityFromTags, stackEvidence } = await import("@repo/framework/deploy");
  const arn = "arn:aws:cloudformation:eu-west-2:111122223333:stack/app-CognitoStack/id";
  const tags = [
    { Key: "framework:owner", Value: FRAMEWORK_OWNER }, { Key: "framework:deployment", Value: "app" },
    { Key: "framework:mode", Value: "dev" }, { Key: "framework:contract", Value: "2" },
  ];
  assert.deepEqual(identityFromTags({ StackId: arn, Tags: tags }), { ...identity, contract: 2 });
  assert.equal(identityFromTags({ StackId: arn, Tags: tags.slice(1) }), undefined, "tags without the framework owner are not ours");
  assert.equal(identityFromTags({ StackId: arn }), undefined);
  const metadata = { contract: 2, owner: FRAMEWORK_OWNER, deployment: "app", mode: "dev", account: "111122223333", region: "eu-west-2", stack: "CognitoStack" };
  assert.deepEqual(identityFromMetadata(metadata), { ...identity, contract: 2, stack: "CognitoStack" });
  assert.equal(identityFromMetadata({ ...metadata, owner: "someone-else" }), undefined);
  assert.deepEqual(identityFromTemplate({ Metadata: { [DEPLOYMENT_METADATA_KEY]: metadata } }), { ...identity, contract: 2, stack: "CognitoStack" });

  const output = [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: raw({}) }];
  assert.deepEqual(stackEvidence({ StackName: "app-CognitoStack", StackId: arn, Tags: tags, Outputs: output }), { identity: { ...identity, contract: 2 }, evidence: "tags" });
  assert.deepEqual(stackEvidence({ StackName: "app-CognitoStack", StackId: arn, Outputs: output }), { identity: { ...identity, contract: 1 }, evidence: "output" });
  assert.deepEqual(stackEvidence({ StackName: "app-CognitoStack", StackId: arn }, { Metadata: { [DEPLOYMENT_METADATA_KEY]: metadata } }), { identity: { ...identity, contract: 2, stack: "CognitoStack" }, evidence: "template" });
  assert.deepEqual(stackEvidence({ StackName: "app-CognitoStack", StackId: arn }), { evidence: "none" });
  const disagreeing = stackEvidence({ StackName: "app-CognitoStack", StackId: arn, Tags: tags, Outputs: [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: raw({ mode: "prod" }) }] });
  assert.equal(disagreeing.evidence, "none");
  assert.match(disagreeing.problem ?? "", /tags say app \(dev\) but its identity output says app \(prod\)/);
});
