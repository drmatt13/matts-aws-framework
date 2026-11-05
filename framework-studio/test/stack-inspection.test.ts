import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StackInspector, redactTemplate } from "../server/deploy/stack-inspection";
import { Tools, type Runner } from "../server/deploy/process";
import { DeployService } from "../server/deploy/service";
import type { StackInspectionRequest } from "../shared/stack-inspection";

const account = "123456789012";
const stackId = `arn:aws:cloudformation:us-east-1:${account}:stack/example-dev-CognitoStack/immutable-1`;
const changeSetId = `arn:aws:cloudformation:us-east-1:${account}:changeSet/current/change-1`;
const identity = { version: 1, deployment: "example-dev", mode: "dev", account, region: "us-east-1" };
const request: StackInspectionRequest = { profile: "test", deployment: "example-dev", mode: "dev", account, region: "us-east-1", stack: "example-dev-CognitoStack", section: "overview" };
const withStack = { ...request, stackId };
const secret = "sensitive-noecho-default";
function fixture(overrides: Record<string, (input: any) => any> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "studio-stack-inspection-"));
  const config = path.join(directory, "config"), credentials = path.join(directory, "credentials");
  writeFileSync(config, "[profile test]\nregion = us-east-1\ncli_history = enabled\n");
  writeFileSync(credentials, "[test]\naws_access_key_id = fixture\naws_secret_access_key = fixture\n");
  const env = { ...process.env, AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_ACCESS_KEY_ID: "ambient-sentinel", AWS_SECRET_ACCESS_KEY: "ambient-sentinel" };
  const calls: { service: string; verb: string; input: any }[] = [];
  let actor = `arn:aws:iam::${account}:user/developer`;
  let described: any = {
    StackId: stackId, StackName: request.stack, StackStatus: "CREATE_COMPLETE", Description: "Deployed stack", CreationTime: "2026-11-05T12:00:00Z", EnableTerminationProtection: true,
    Outputs: [{ OutputKey: "Identity", OutputValue: JSON.stringify(identity), Description: "framework:deployment:v1" }, { OutputKey: "Export", OutputValue: "public-value", ExportName: "shared-export" }],
    Tags: [{ Key: "project", Value: "example" }],
    Parameters: [{ ParameterKey: "Password", ParameterValue: secret, ResolvedValue: secret }, { ParameterKey: "Public", ParameterValue: "public-name", ResolvedValue: "public-value" }],
    Capabilities: ["CAPABILITY_IAM"], NotificationARNs: ["arn:aws:sns:us-east-1:123456789012:events"], DriftInformation: { StackDriftStatus: "IN_SYNC", LastCheckTimestamp: "2026-11-05T12:01:00Z" },
    RollbackConfiguration: { MonitoringTimeInMinutes: 5, RollbackTriggers: [{ Arn: "alarm", Type: "AWS::CloudWatch::Alarm" }] },
  };
  const defaults: Record<string, (input: any) => any> = {
    "get-caller-identity": () => ({ Account: account, Arn: actor }),
    "describe-stacks": () => ({ Stacks: [described] }), "get-stack-policy": () => ({}),
    "list-stack-resources": input => ({ StackResourceSummaries: [{ LogicalResourceId: input.NextToken ? "Second" : "First", ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "function", ResourceStatus: "CREATE_COMPLETE", DriftInformation: { StackResourceDriftStatus: "IN_SYNC" } }], ...(input.NextToken ? {} : { NextToken: "raw-resource-page" }) }),
    "describe-stack-events": () => ({ StackEvents: [{ EventId: "event-1", Timestamp: "2026-11-05", LogicalResourceId: "Lambda", ResourceType: "AWS::Lambda::Function", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "Reason", ResourceProperties: { Secret: secret }, ClientRequestToken: "operation" }] }),
    "get-template-summary": () => ({ Parameters: [{ ParameterKey: "Password", ParameterType: "String", NoEcho: true }, { ParameterKey: "Public", ParameterType: "AWS::SSM::Parameter::Value<String>", NoEcho: false }] }),
    "get-template": () => ({ TemplateBody: { Parameters: { Password: { Type: "String", NoEcho: true, Default: secret }, Public: { Type: "String", Default: "visible" } }, Resources: {}, Outputs: { Imported: { Value: { "Fn::ImportValue": "upstream" } } } }, StagesAvailable: ["Original", "Processed"] }),
    "list-change-sets": () => ({ Summaries: [{ ChangeSetId: changeSetId, ChangeSetName: "current", Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" }] }),
    "describe-change-set": () => ({ ChangeSetId: changeSetId, ChangeSetName: "current", StackId: stackId, Status: "CREATE_COMPLETE", Parameters: described.Parameters, Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "Lambda", BeforeContext: JSON.stringify({ Secret: secret }), AfterContext: "unknown-sensitive-material", Details: [{ Target: { Name: "Environment", Path: "/Properties/Environment", BeforeValue: secret, AfterValue: "unknown-sensitive-material" } }] } }] }),
    "list-imports": input => ({ Imports: [input.NextToken ? "consumer-two" : "consumer-one"], ...(input.NextToken ? {} : { NextToken: "raw-import-page" }) }),
  };
  const run: Runner = async spec => {
    assert.equal(spec.env.AWS_ACCESS_KEY_ID, undefined); assert.match(readFileSync(spec.env.AWS_CONFIG_FILE!, "utf8"), /cli_history = disabled/); assert.ok(spec.args.includes("--no-paginate"));
    const [service, verb] = spec.args; const input = JSON.parse(spec.args[spec.args.indexOf("--cli-input-json") + 1]!); calls.push({ service: service!, verb: verb!, input });
    assert.ok(/^(?:get|describe|list)-/.test(verb!), "inspector only uses read APIs");
    try { return { code: 0, stdout: JSON.stringify(await (overrides[verb!] ?? defaults[verb!]!)(input)), stderr: "" }; }
    catch (error) { return { code: 1, stdout: "", stderr: String(error) }; }
  };
  const inspector = new StackInspector(new Tools(path.resolve(".."), env), run, env);
  return { inspector, calls, setActor: (value: string) => { actor = value; }, replaceStack: (value: any) => { described = value; }, stack: () => described, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("overview verifies immutable identity, snapshots the profile, and isolates policy denial", async () => {
  const f = fixture({ "get-stack-policy": () => { throw new Error("AccessDenied secret-provider-output"); } });
  try { const result = await f.inspector.inspect({ ...request, section: "overview" }); assert.ok(result.ok); if (!result.ok) return;
    assert.equal(result.value.stackId, stackId); assert.equal(result.value.terminationProtection, true); assert.equal(result.value.drift.status, "IN_SYNC"); assert.equal(result.value.rollback.monitoringMinutes, 5);
    assert.equal(result.value.policy.ok, false); assert.doesNotMatch(JSON.stringify(result.value), /secret-provider-output/); assert.deepEqual(f.calls.map(item => item.verb), ["get-caller-identity", "describe-stacks", "get-stack-policy"]);
  } finally { f.dispose(); }
});

test("resource cursors page raw service tokens and cannot cross sections or actors", async () => {
  const f = fixture(); try { const first = await f.inspector.inspect({ ...withStack, section: "resources" }); assert.ok(first.ok); if (!first.ok) return;
    assert.equal(first.value.items[0]?.logicalId, "First"); assert.ok(first.value.nextCursor); assert.doesNotMatch(first.value.nextCursor!, /raw-resource-page/);
    const second = await f.inspector.inspect({ ...withStack, section: "resources", cursor: first.value.nextCursor }); assert.ok(second.ok); if (second.ok) assert.equal(second.value.items[0]?.logicalId, "Second"); assert.equal(f.calls.at(-1)?.input.NextToken, "raw-resource-page");
    await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "events", cursor: first.value.nextCursor }), /another stack, connection, or section/);
    f.setActor(`arn:aws:iam::${account}:user/other`); await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "resources", cursor: first.value.nextCursor }), /another stack, connection, or section/);
    await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "resources", cursor: first.value.nextCursor + "tamper" }), /invalid/);
  } finally { f.dispose(); }
});

test("cached sections require fresh identity and ownership checks; force and changed actor bypass cache", async () => {
  const f = fixture(); try { await f.inspector.inspect({ ...withStack, section: "resources" }); await f.inspector.inspect({ ...withStack, section: "resources" });
    assert.equal(f.calls.filter(item => item.verb === "list-stack-resources").length, 1); assert.equal(f.calls.filter(item => item.verb === "describe-stacks").length, 2);
    f.setActor(`arn:aws:iam::${account}:user/other`); await f.inspector.inspect({ ...withStack, section: "resources" }); assert.equal(f.calls.filter(item => item.verb === "list-stack-resources").length, 2);
    await f.inspector.inspect({ ...withStack, section: "resources" }, true); assert.equal(f.calls.filter(item => item.verb === "list-stack-resources").length, 3);
    f.replaceStack({ ...f.stack(), StackId: stackId.replace("immutable-1", "replacement") }); await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "resources" }), /replaced/);
  } finally { f.dispose(); }
});

test("wrong account, mode, unowned stacks, and arbitrary section reads are refused", async () => {
  const f = fixture(); try { await assert.rejects(() => f.inspector.inspect({ ...request, section: "resources" }), /overview/);
    await assert.rejects(() => f.inspector.inspect({ ...request, section: "overview", account: "999999999999" }), /identity changed/);
    await assert.rejects(() => f.inspector.inspect({ ...request, mode: "prod", section: "overview" }), /matching framework/);
    f.replaceStack({ ...f.stack(), Outputs: [], Tags: [] }); await assert.rejects(() => f.inspector.inspect({ ...request, section: "overview" }), /matching framework/);
    assert.equal(f.calls.some(item => item.verb === "get-stack-policy"), false);
  } finally { f.dispose(); }
});

test("explicit foreign application lineage and undeclared source targets are refused", async () => {
  const f = fixture(); try {
    f.replaceStack({ ...f.stack(), Tags: [{ Key: "framework:owner", Value: "matts-aws-framework" }, { Key: "framework:deployment", Value: "example-dev" }, { Key: "framework:mode", Value: "dev" }, { Key: "framework:app-id", Value: "foreign-app" }, { Key: "framework:stage", Value: "dev" }] });
    await assert.rejects(() => f.inspector.inspect({ ...request, section: "overview" }, false, { appId: "expected-app", stage: "dev" }), /different application's/);
    let invoked = false;
    const service = { targets: () => [{ name: "declared-dev", mode: "dev", account, region: "us-east-1" }], stackInspector: { inspect: () => { invoked = true; } } };
    assert.throws(() => DeployService.prototype.inspectStack.call(service as any, request, false), /declared deployment/);
    assert.throws(() => DeployService.prototype.inspectStack.call(service as any, { ...request, deployment: "declared-dev", region: "us-west-2" }, false), /declared deployment/); assert.equal(invoked, false);
  } finally { f.dispose(); }
});

test("a legacy failed-create stack can prove ownership from its deployed identity output template", async () => {
  const f = fixture({ "get-template": () => ({ TemplateBody: { Outputs: { FrameworkDeployment: { Description: "framework:deployment:v1", Value: JSON.stringify(identity) } } } }) });
  try {
    f.replaceStack({ ...f.stack(), StackStatus: "ROLLBACK_COMPLETE", Outputs: [], Tags: [] });
    const result = await f.inspector.inspect({ ...request, section: "overview" }, false, { appId: "source-app", stage: "dev" });
    assert.ok(result.ok); if (result.ok) assert.equal(result.value.status, "ROLLBACK_COMPLETE");
  } finally { f.dispose(); }
});

test("events omit resource properties and preserve diagnostic metadata", async () => {
  const f = fixture(); try { const result = await f.inspector.inspect({ ...withStack, section: "events" }); assert.ok(result.ok); if (!result.ok) return; assert.equal(result.value.items[0]?.reason, "Reason"); assert.equal(result.value.items[0]?.clientRequestToken, "operation"); assert.doesNotMatch(JSON.stringify(result), /sensitive-noecho|ResourceProperties/); } finally { f.dispose(); }
});

test("NoEcho and unknown parameter definitions mask both parameter and SSM resolved values", async () => {
  const f = fixture(); try { const result = await f.inspector.inspect({ ...withStack, section: "parameters" }); assert.ok(result.ok); if (!result.ok) return; assert.equal(result.value.items[0]?.masked, true); assert.doesNotMatch(JSON.stringify(result), /sensitive-noecho/); assert.equal(result.value.items[1]?.resolvedValue, "public-value"); } finally { f.dispose(); }
  const denied = fixture({ "get-template-summary": () => { throw new Error("AccessDenied"); } }); try { const result = await denied.inspector.inspect({ ...withStack, section: "parameters" }); assert.ok(result.ok); if (!result.ok) return; assert.ok(result.value.maskingProblem); assert.ok(result.value.items.every(item => item.masked)); assert.doesNotMatch(JSON.stringify(result), /public-name|public-value|sensitive-noecho/); } finally { denied.dispose(); }
});

test("JSON and YAML NoEcho defaults are redacted while dynamic references remain unresolved", async () => {
  const json = redactTemplate({ Parameters: { Password: { Type: "String", NoEcho: true, Default: secret } }, Resources: { Config: { Value: "{{resolve:secretsmanager:example}}" } } }); assert.doesNotMatch(json.body, /sensitive-noecho/); assert.match(json.body, /\{\{resolve:secretsmanager:example\}\}/); assert.deepEqual(json.redactedDefaults, ["Password"]);
  const yaml = redactTemplate(`Parameters:\n  Password:\n    Type: String\n    NoEcho: true\n    Default: ${secret}\nOutputs:\n  Ref:\n    Value: !Ref Password\n`); assert.doesNotMatch(yaml.body, /sensitive-noecho/); assert.match(yaml.body, /!Ref Password/);
  const f = fixture(); try { const value = await f.inspector.inspect({ ...withStack, section: "template", stage: "Processed" }); assert.ok(value.ok); if (value.ok) assert.equal(value.value.stage, "Processed"); assert.equal(f.calls.at(-1)?.input.TemplateStage, "Processed"); assert.doesNotMatch(JSON.stringify(value), /sensitive-noecho/); } finally { f.dispose(); }
});

test("change-set membership precedes reads and sensitive property contexts are redacted", async () => {
  const f = fixture(); try { const result = await f.inspector.inspect({ ...withStack, section: "change-set", changeSetId }); assert.ok(result.ok); if (!result.ok) return;
    assert.equal(result.value.summary.id, changeSetId); assert.doesNotMatch(JSON.stringify(result), /sensitive-noecho|unknown-sensitive-material/); assert.match(JSON.stringify(result), /Environment/);
    assert.ok(f.calls.findIndex(item => item.verb === "list-change-sets") < f.calls.findIndex(item => item.verb === "describe-change-set")); assert.equal(f.calls.some(item => item.verb === "get-template-summary" && item.input.ChangeSetName), false);
    await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "change-set", changeSetId: changeSetId.replace("change-1", "unrelated") }), /does not belong/); assert.equal(f.calls.filter(item => item.verb === "describe-change-set").length, 1);
  } finally { f.dispose(); }
});

test("NoEcho defaults protect change-set contexts even before AWS returns parameter values", async () => {
  const f = fixture({ "describe-change-set": () => ({ ChangeSetId: changeSetId, StackId: stackId, Parameters: [], Changes: [{ ResourceChange: { BeforeContext: secret, AfterContext: "unknown-sensitive-material" } }] }) });
  try { const result = await f.inspector.inspect({ ...withStack, section: "change-set", changeSetId }); assert.ok(result.ok); assert.doesNotMatch(JSON.stringify(result), /sensitive-noecho|unknown-sensitive-material/); } finally { f.dispose(); }
});

test("dependencies load importers only when an owned export is selected", async () => {
  const f = fixture(); try { const dependencies = await f.inspector.inspect({ ...withStack, section: "dependencies" }); assert.ok(dependencies.ok); if (!dependencies.ok) return; assert.deepEqual(dependencies.value.imports, ["upstream"]); assert.equal(f.calls.some(item => item.verb === "list-imports"), false);
    const first = await f.inspector.inspect({ ...withStack, section: "export-imports", exportName: "shared-export" }); assert.ok(first.ok); if (!first.ok) return; assert.deepEqual(first.value.items, ["consumer-one"]); assert.ok(first.value.nextCursor);
    const second = await f.inspector.inspect({ ...withStack, section: "export-imports", exportName: "shared-export", cursor: first.value.nextCursor }); assert.ok(second.ok); if (second.ok) assert.deepEqual(second.value.items, ["consumer-two"]);
    await assert.rejects(() => f.inspector.inspect({ ...withStack, section: "export-imports", exportName: "other-export" }), /does not belong/);
  } finally { f.dispose(); }
});

test("YAML shorthand imports preserve literal names and unresolved Sub/Join expressions", async () => {
  const f = fixture({ "get-template": () => ({ TemplateBody: "Resources:\n  Example:\n    Properties:\n      First: !ImportValue direct-upstream\n      Second:\n        Fn::ImportValue: !Sub '${Stage}-upstream'\n      Third: !ImportValue\n        Fn::Join: ['-', ['other', 'upstream']]\n" }) });
  try {
    const result = await f.inspector.inspect({ ...withStack, section: "dependencies" });
    assert.ok(result.ok); if (!result.ok) return;
    assert.ok(result.value.imports.includes("direct-upstream"));
    assert.ok(result.value.imports.some(item => item.includes("${Stage}-upstream")));
    assert.ok(result.value.imports.some(item => item.includes("Fn::Join")));
    assert.equal(f.calls.some(item => item.verb === "list-imports"), false);
  } finally { f.dispose(); }
});

test("an export with no importing stacks is an empty result rather than an AWS failure", async () => {
  const f = fixture({ "list-imports": () => { throw new Error("ValidationError: Export shared-export is not imported by any stack."); } });
  try { const result = await f.inspector.inspect({ ...withStack, section: "export-imports", exportName: "shared-export" }); assert.ok(result.ok); if (result.ok) assert.deepEqual(result.value.items, []); } finally { f.dispose(); }
});

test("oversized and denied responses fail without reflecting CLI credential text", async () => {
  const f = fixture({ "list-stack-resources": () => ({ excessive: "a".repeat(2 * 1024 * 1024) }) }); try { const result = await f.inspector.inspect({ ...withStack, section: "resources" }); assert.equal(result.ok, false); if (!result.ok) assert.match(result.problem.message, /more data/); } finally { f.dispose(); }
  const denied = fixture({ "describe-stacks": () => { throw new Error("AccessDenied provider-credential-sentinel"); } }); try { const result = await denied.inspector.inspect({ ...withStack, section: "outputs" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.problem.kind, "denied"); assert.doesNotMatch(JSON.stringify(result), /provider-credential-sentinel/); } finally { denied.dispose(); }
});
