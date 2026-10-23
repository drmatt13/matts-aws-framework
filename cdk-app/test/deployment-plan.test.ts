import assert from "node:assert/strict";
import test from "node:test";
import { changedExports, confirmationLevel, staleness, templateChanges } from "../../scripts/deployment-plan";

const deployed = {
  Resources: {
    Pool: { Type: "AWS::Cognito::UserPool", Properties: { UserPoolName: "a" } },
    Fn: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "old.zip" } } },
    Gone: { Type: "AWS::SQS::Queue", Properties: {} },
    Kept: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain", Properties: {} },
  },
  Outputs: { UserPoolId: { Value: { Ref: "Pool" }, Export: { Name: "app-CognitoStack:UserPoolId" } }, Old: { Value: "x", Export: { Name: "app-CognitoStack:Old" } } },
};
const synthesized = {
  Resources: {
    Pool: { Type: "AWS::Cognito::UserPool", Properties: { UserPoolName: "b" } },
    Fn: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "new.zip" } } },
    Added: { Type: "AWS::SNS::Topic", Properties: {} },
  },
  Outputs: { UserPoolId: { Value: { "Fn::GetAtt": ["Pool", "Arn"] }, Export: { Name: "app-CognitoStack:UserPoolId" } } },
};

test("a template comparison lists additions, modifications and removals with their deletion policy", () => {
  const changes = templateChanges(deployed, synthesized);
  assert.deepEqual(changes.map((change) => [change.action, change.logicalId, change.stateful, change.deletionPolicy]), [
    ["add", "Added", false, undefined],
    ["modify", "Fn", false, undefined],
    ["modify", "Pool", true, undefined],
    ["remove", "Gone", false, "Delete"],
    ["remove", "Kept", true, "Retain"],
  ]);
  assert.deepEqual(templateChanges(synthesized, synthesized), [], "an identical template changes nothing");
  assert.equal(templateChanges(undefined, synthesized).every((change) => change.action === "add"), true, "a new stack only adds");
});

test("exports another stack may import are flagged when removed or changed", () => {
  assert.deepEqual(changedExports(deployed, synthesized), [
    { exportName: "app-CognitoStack:UserPoolId", change: "changed" },
    { exportName: "app-CognitoStack:Old", change: "removed" },
  ]);
});

test("development always pauses, including routine and uncertain stateful changes", () => {
  const modify = templateChanges({ Resources: { Fn: deployed.Resources.Fn } }, { Resources: { Fn: synthesized.Resources.Fn } });
  assert.equal(confirmationLevel({ mode: "dev", firstDeploy: true, iamBroadening: false, changes: modify, exportsInUse: [] }).level, "click");
  assert.equal(confirmationLevel({ mode: "dev", firstDeploy: false, iamBroadening: true, changes: modify, exportsInUse: [] }).level, "click");
  assert.equal(confirmationLevel({ mode: "dev", firstDeploy: false, iamBroadening: false, changes: templateChanges(deployed, synthesized), exportsInUse: [] }).level, "click");
});

test("production always pauses, and consequential changes need the typed name", () => {
  const routine = templateChanges({ Resources: { Fn: deployed.Resources.Fn } }, { Resources: { Fn: synthesized.Resources.Fn } });
  assert.deepEqual(confirmationLevel({ mode: "prod", firstDeploy: false, iamBroadening: false, changes: routine, exportsInUse: [] }), { level: "click", reasons: [] });
  const stateful = confirmationLevel({ mode: "prod", firstDeploy: false, iamBroadening: false, changes: templateChanges({ Resources: { Pool: deployed.Resources.Pool } }, { Resources: { Pool: synthesized.Resources.Pool } }), exportsInUse: [] });
  assert.equal(stateful.level, "name");
  assert.match(stateful.reasons.join(), /stateful resources changed: Pool/);
  const replaced = [{ logicalId: "Fn", type: "AWS::Lambda::Function", action: "modify" as const, replacement: "Conditional" as const, stateful: false }];
  assert.equal(confirmationLevel({ mode: "prod", firstDeploy: false, iamBroadening: false, changes: replaced, exportsInUse: [] }).level, "name");
  assert.equal(confirmationLevel({ mode: "prod", firstDeploy: true, iamBroadening: false, changes: [], exportsInUse: [] }).level, "name");
  assert.equal(confirmationLevel({ mode: "prod", firstDeploy: false, iamBroadening: false, changes: [], exportsInUse: [{ stack: "a", exportName: "x", change: "removed", importers: ["b"] }] }).level, "name");
});

test("a plan is stale once any stack it reviewed has changed", () => {
  const planned = { a: { exists: true, status: "UPDATE_COMPLETE", updated: "t1" }, b: { exists: false } };
  assert.equal(staleness(planned, { a: { exists: true, status: "UPDATE_COMPLETE", updated: "t1" }, b: { exists: false } }), undefined);
  assert.match(staleness(planned, { a: { exists: true, status: "UPDATE_COMPLETE", updated: "t2" }, b: { exists: false } }) ?? "", /a changed since the review/);
  assert.match(staleness(planned, { a: { exists: true, status: "UPDATE_COMPLETE", updated: "t1" }, b: { exists: true, status: "CREATE_IN_PROGRESS", updated: "t3" } }) ?? "", /b changed since the review \(absent then/);
  assert.match(staleness({ a: { ...planned.a, stackId: "original" } }, { a: { ...planned.a, stackId: "replacement" } }) ?? "", /a changed since the review/, "same name/status/time cannot hide replacement identity");
});
