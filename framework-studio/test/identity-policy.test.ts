import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { identityPolicyStatements } from "../shared/identity-policy";
import { identityPolicySource, planIdentityPolicy, readIdentityPolicyEdit } from "../server/identity-policy-source";
import { IdentityPolicyService } from "../server/identity-policy";
import type { StudioState } from "../server/snapshot";
import type { CommandSpec, Runner } from "../server/deploy/process";

const root = path.resolve(__dirname, "../.."); const cache = path.join(root, ".cache/identity-policy-tests"); mkdirSync(cache, { recursive: true });
const bucket = "arn:aws:s3:::policy-fixture/tenant/*";
const statements = identityPolicyStatements([{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: [bucket] }, { Effect: "Deny", Action: ["s3:PutObject"], Resource: ["arn:aws:s3:::policy-fixture/tenant/protected/*"] }]);
function fixture(custom = false) {
  const directory = mkdtempSync(path.join(cache, "case-")); mkdirSync(path.join(directory, "cdk-app/lib/app"), { recursive: true }); writeFileSync(path.join(directory, "package.json"), '{"private":true}');
  for (const file of ["identity-pool-access.ts", "identity-policy.ts"]) cpSync(path.join(root, "cdk-app/lib/app", file), path.join(directory, "cdk-app/lib/app", file));
  const relative = "cdk-app/lib/app/access-stack.ts"; const file = path.join(directory, relative);
  writeFileSync(file, `import { identityPoolAccess } from "./identity-pool-access";\n// preserve unrelated comment\nexport class AccessStack { constructor(props:any) { const access = identityPoolAccess(this, { userPool: props.userPool, userPoolClient: props.userPoolClient, groupName: "reader", ${custom ? `readerPolicyStatements: ${JSON.stringify(statements)}, allowUnauthenticated: true` : `readBucketArn: "arn:aws:s3:::policy-fixture", readPrefix: "tenant/"`} }); } }\n`);
  const resource = { id: "resource:access", path: ["access"], kind: "stack" }; const catalog = new Map([["access", { stack: { className: "AccessStack", location: { file: relative }, members: ["identityPool", "authenticatedRole", "readerRole", "readerGroup"].map(name => ({ name })) } }]]);
  const state = { snapshot: { revision: "revision", models: { dev: { resources: [resource] }, prod: { resources: [resource] } } }, built: { catalog } } as unknown as StudioState;
  return { directory, file, state, cleanup: () => { assert.ok(directory.startsWith(cache + path.sep)); rmSync(directory, { recursive: true }); } };
}
test("bounded statement grammar rejects admin, wildcard accounts/actions, wrong service and competing model keys", () => {
  for (const policy of [
    [{ Effect: "Allow", Action: ["iam:PassRole"], Resource: ["arn:aws:iam::111122223333:role/admin"] }],
    [{ Effect: "Allow", Action: ["s3:*"], Resource: [bucket] }],
    [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] }],
    [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::*/tenant/*"] }],
    [{ Effect: "Allow", Action: ["dynamodb:GetItem"], Resource: [bucket] }],
    [{ Effect: "Allow", Action: ["dynamodb:GetItem"], Resource: ["arn:aws:dynamodb:us-east-1:111122223333:table/*"] }],
    [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: ["arn:aws:secretsmanager:us-east-1:111122223333:secret:private"] }],
    [{ Effect: "Deny", Action: ["s3:PutObject"], Resource: [bucket], Principal: "*" }],
  ]) assert.throws(() => identityPolicyStatements(policy));
  assert.deepEqual(identityPolicyStatements(statements), statements); assert.deepEqual(identityPolicyStatements([]), []);
});
test("recognized native literal edit preserves unrelated bytes and has one policy authority; computed/custom source refuses", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.file, "utf8"); const source = identityPolicySource(f.directory, f.state, "resource:access");
    assert.deepEqual(source.statements, [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: [bucket] }]);
    const edits = new Map<string, string>(); const plan = planIdentityPolicy(f.directory, f.state, { kind: "identityPolicy", target: "resource:access", statements, allowUnauthenticated: true }, edits);
    assert.equal(readFileSync(f.file, "utf8"), before, "planning never writes source");
    const after = edits.get(plan.file)!; assert.match(after, /preserve unrelated comment/); assert.doesNotMatch(after, /readBucketArn|readPrefix/); assert.match(after, /allowUnauthenticated: true/);
    assert.deepEqual(identityPolicySource(f.directory, f.state, "resource:access", edits).statements, statements);
    assert.equal(Object.keys(plan.hashes).length, 3, "native source/helper/validator bytes expire stale reviews");
    writeFileSync(f.file, before.replace('readPrefix: "tenant/"', 'readPrefix: /* keep this scope explanation */ "tenant/"'));
    assert.throws(() => planIdentityPolicy(f.directory, f.state, { kind: "identityPolicy", target: "resource:access", statements, allowUnauthenticated: false }, new Map()), /authored comments/);
    writeFileSync(f.file, before.replace('readPrefix: "tenant/"', "...customOptions"));
    assert.throws(() => identityPolicySource(f.directory, f.state, "resource:access"), /spreads.*source review/);
    writeFileSync(f.file, before.replace("constructor(props:any)", "constructor(props:any, identityPoolAccess:any)"));
    assert.throws(() => identityPolicySource(f.directory, f.state, "resource:access"), /shadowed.*custom source/);
    assert.throws(() => readIdentityPolicyEdit({ kind: "identityPolicy", target: "../../secrets", statements, allowUnauthenticated: true }), /Select a generated/);
  } finally { f.cleanup(); }
});
test("IAM simulation is read-only, account-bound, source-bound and reports explicit deny and missing-group no-grant separately", async () => {
  const f = fixture(true); const calls: CommandSpec[] = [];
  const run: Runner = async spec => {
    calls.push(spec); const args = spec.args; const operation = args[1];
    if (operation === "get-caller-identity") return { code: 0, stderr: "", stdout: JSON.stringify({ Account: "111122223333" }) };
    assert.equal(operation, "simulate-custom-policy");
    const policy = JSON.parse(args[args.indexOf("--policy-input-list") + 1]!); assert.deepEqual(policy.Statement, statements);
    const actionNames = args.slice(args.indexOf("--action-names") + 1, args.indexOf("--resource-arns"));
    const resourceNames = args.slice(args.indexOf("--resource-arns") + 1, args.indexOf("--profile"));
    const EvaluationResults = actionNames.flatMap(action => resourceNames.map(resource => {
      const matches = statements.filter(statement => statement.Action.includes(action) && statement.Resource.some(pattern => pattern.endsWith("*") ? resource.startsWith(pattern.slice(0, -1)) : resource === pattern));
      return { EvalActionName: action, EvalResourceName: resource, EvalDecision: matches.some(statement => statement.Effect === "Deny") ? "explicitDeny" : matches.some(statement => statement.Effect === "Allow") ? "allowed" : "implicitDeny" };
    }));
    return { code: 0, stderr: "", stdout: JSON.stringify({ EvaluationResults }) };
  };
  try {
    const service = new IdentityPolicyService(f.directory, () => f.state, run);
    const input = { target: "resource:access", revision: "revision", profile: "dev", account: "111122223333", region: "us-east-1", role: "reader", actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], resources: ["arn:aws:s3:::policy-fixture/tenant/protected/example.json"] };
    const result = await service.simulate(input); assert.equal(result.engine, "aws-iam"); assert.deepEqual(result.results.map(row => row.decision), ["allowed", "explicitDeny", "implicitDeny"]); assert.match(result.limitations.join(" "), /boundaries.*SCPs.*resource policies/);
    const missing = await service.simulate({ ...input, role: "default" }); assert.equal(missing.engine, "source-empty-policy"); assert.ok(missing.results.every(row => row.decision === "implicitDeny"));
    const before = calls.length; await assert.rejects(service.simulate({ ...input, account: "999988887777" }), /different account/); assert.equal(calls.length, before + 1, "wrong-account refusal sends STS only");
    await assert.rejects(service.simulate({ ...input, revision: "stale" }), /Source changed/);
    const changesHelper: Runner = async (spec, options) => {
      const result = await run(spec, options);
      if (spec.args.includes("simulate-custom-policy")) writeFileSync(path.join(f.directory, "cdk-app/lib/app/identity-pool-access.ts"), readFileSync(path.join(f.directory, "cdk-app/lib/app/identity-pool-access.ts"), "utf8") + "\n// changed while simulation was running\n");
      return result;
    };
    await assert.rejects(new IdentityPolicyService(f.directory, () => f.state, changesHelper).simulate(input), /Source changed during simulation/);
    assert.ok(calls.every(call => call.args.includes("get-caller-identity") || call.args.includes("simulate-custom-policy")), "no IAM/resource mutation operation exists");
  } finally { f.cleanup(); }
});
