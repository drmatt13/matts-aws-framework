import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { triggerAdapters } from "../../packages/framework/src/config/triggers";
import { discoverCapabilities } from "../server/source/capabilities";
import type { CatalogEntrySource } from "../server/source/catalog";

test("native interface fields remain mutable while explicit Cognito references, imports and unresolved lifecycle source remain protected", () => {
  const cache = path.resolve(__dirname, "../../.cache"); mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "lifecycle-trigger-capabilities-"));
  try {
    mkdirSync(path.join(root, "framework-config")); mkdirSync(path.join(root, "cdk-app/lib/app"), { recursive: true });
    const source = 'import { resource } from "@repo/framework/config"; import type { CognitoStack, GenericStack, DynamicStack } from "../cdk-app/lib/app/cognito-stack"; export const resources = { cognito: resource.stack<CognitoStack>(), generic: resource.stack<GenericStack>(), dynamic: resource.stack<DynamicStack>() };';
    const catalog = new Map<string, CatalogEntrySource>([["cognito", "CognitoStack"], ["generic", "GenericStack"], ["dynamic", "DynamicStack"]].map(([name, type]) => {
      const expression = `resource.stack<${type}>()`, start = source.indexOf(expression);
      const location = { file: "framework-config/resources.ts", line: 1, column: start + 1, start, end: start + expression.length };
      return [name!, { key: location, value: location }];
    }));
    writeFileSync(path.join(root, "framework-config/resources.ts"), source);
    const stackFile = path.join(root, "cdk-app/lib/app/cognito-stack.ts");
    const nativeSource = `import { Stack } from "aws-cdk-lib";
import { UserPool, type IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
throw new Error("Private source sentinel must never execute or enter capability metadata");
export class CognitoStack extends Stack {
  public readonly userPool: IUserPool;
  public readonly imported: IUserPool;
  constructor(scope: Construct, id: string, props: { reference?: { userPoolId: string } }) {
    super(scope, id);
    if (props.reference) { this.userPool = UserPool.fromUserPoolId(this, "Reference", props.reference.userPoolId); return; }
    const userPool = new UserPool(this, "Pool");
    this.userPool = userPool;
    this.imported = UserPool.fromUserPoolId(this, "Imported", "us-east-1_Imported");
  }
}
export class GenericStack extends Stack {
  public readonly conditional: IUserPool;
  public readonly initialized: IUserPool = new UserPool(this, "Initial");
  public readonly repeated: IUserPool;
  public readonly unconditional: IUserPool;
  public mutable: IUserPool;
  constructor(scope: Construct, id: string, props: { reference?: { userPoolId: string } }) {
    super(scope, id);
    if (props.reference) { this.conditional = UserPool.fromUserPoolId(this, "ConditionalReference", props.reference.userPoolId); return; }
    const native = new UserPool(this, "ConditionalNative");
    this.conditional = native;
    this.initialized = UserPool.fromUserPoolId(this, "InitialReplacement", "us-east-1_Imported");
    this.repeated = new UserPool(this, "RepeatedNative");
    this.repeated = UserPool.fromUserPoolId(this, "RepeatedReference", "us-east-1_Imported");
    this.unconditional = new UserPool(this, "Unconditional");
    this.mutable = new UserPool(this, "MutableNative");
    this.switchPool();
  }
  private switchPool() { this.mutable = UserPool.fromUserPoolId(this, "MethodReplacement", "us-east-1_Imported"); }
}
export class DynamicStack extends Stack {
  public mutable: IUserPool;
  constructor(scope: Construct, id: string, key: string) {
    super(scope, id);
    this.mutable = new UserPool(this, "DynamicNative");
    this[key] = UserPool.fromUserPoolId(this, "DynamicReference", "us-east-1_Imported");
    Object.assign(this, { mutable: UserPool.fromUserPoolId(this, "AssignedReference", "us-east-1_Imported") });
  }
}
`;
    writeFileSync(stackFile, nativeSource);
    const policy = path.join(root, "framework-config/stateful-resources.ts");
    writeFileSync(policy, "export const statefulResources = {dev:{},prod:{}};");
    const scan = () => discoverCapabilities(root, catalog, triggerAdapters()).capabilities;
    const managed = scan();
    assert.equal(managed.find(item => item.name === "userPool")?.owned, true);
    assert.equal(managed.find(item => item.name === "userPool")?.adapters.find(item => item.kind === "cognito")?.reason, undefined);
    assert.equal(managed.find(item => item.name === "imported")?.owned, false);
    assert.match(managed.find(item => item.name === "imported")!.adapters.find(item => item.kind === "cognito")!.reason!, /Imported or immutable/);
    for (const name of ["conditional", "initialized", "repeated", "mutable"]) assert.equal(managed.find(item => item.resource === `resource:generic.${name}`)?.owned, false, `Generic ${name} has alternative writes and cannot prove ownership.`);
    assert.equal(managed.find(item => item.resource === "resource:generic.unconditional")?.owned, true, "One unambiguous generic native initializer remains usable.");
    assert.equal(managed.find(item => item.resource === "resource:dynamic.mutable")?.owned, false, "Unknown computed writes and Object.assign cannot prove ownership.");
    writeFileSync(stackFile, nativeSource.replace("if (props.reference) { this.userPool", "if (props.otherReference) { this.userPool"));
    assert.equal(scan().find(item => item.name === "userPool")?.owned, false, "The canonical exception cannot hide an unrelated conditional import.");
    writeFileSync(stackFile, nativeSource);
    writeFileSync(policy, 'export const statefulResources = {dev:{},prod:{cognito:{reference:{userPoolId:"private-reference-sentinel"}}}};');
    const referenced = scan(), pool = referenced.find(item => item.name === "userPool")!;
    assert.equal(pool.owned, false);
    assert.match(pool.adapters.find(item => item.kind === "cognito")!.reason!, /externally referenced in prod/);
    assert.doesNotMatch(JSON.stringify(referenced), /private-reference-sentinel|Private source sentinel/);
    writeFileSync(policy, "export const statefulResources = loadPolicy();");
    const unresolved = scan().find(item => item.name === "userPool")!;
    assert.equal(unresolved.owned, false);
    assert.match(unresolved.adapters.find(item => item.kind === "cognito")!.reason!, /ownership is unresolved/);
    writeFileSync(policy, "export const statefulResources = {dev:{},prod:{}};");
    assert.equal(scan().find(item => item.name === "userPool")?.owned, true, "A policy change invalidates cached ownership evidence.");
  } finally { assert.ok(path.resolve(root).startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
});
