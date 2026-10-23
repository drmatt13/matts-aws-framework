import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { nativeVpcReferences } from "../server/source/networks";

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "studio-vpc-source-"));
  try {
    for (const id of ["alpha", "beta"]) {
      const directory = path.join(root, `framework-config/networks/${id}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "index.ts"), `import { defineNetwork } from "@repo/framework/config";\nexport const ${id}Vpc = defineNetwork({ id: "${id}", cidr: "10.0.0.0/16", zones: 2 });`);
    }
    writeFileSync(path.join(root, "framework.config.ts"), 'import { alphaVpc } from "./framework-config/networks/alpha"; import { betaVpc } from "./framework-config/networks/beta"; defineFrameworkConfig({ networks: [alphaVpc, betaVpc] });');
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const source = (root: string, body: string) => ts.createSourceFile(path.join(root, "cdk-app/lib/app/example-stack.ts"), `import { frameworkVpc as selectVpc } from "../framework/framework-network"; import { alphaVpc as primary } from "../../../framework-config/networks/alpha"; ${body}`, ts.ScriptTarget.Latest, true);

test("native VPC source evidence follows direct imported references and simple const aliases", () => fixture(root => {
  const file = source(root, 'const network = primary; class Example { constructor() { const selected = network; const vpc = selectVpc(this, selected); const alias = vpc; this.database = new Database(this, "Db", { vpc: alias }); } }');
  const evidence = nativeVpcReferences(root, file);
  let alias: ts.Expression | undefined;
  const visit = (node: ts.Node): void => { if (ts.isPropertyAssignment(node) && node.name.getText(file) === "vpc") alias = node.initializer; ts.forEachChild(node, visit); };
  visit(file);
  assert.equal(evidence.resolve(alias), "alpha");
  assert.deepEqual([...evidence.used], ["alpha"]);
}));

test("unregistered, mutable, computed and shadowed native VPC references stay unresolved", () => fixture(root => {
  for (const body of [
    'class Example { constructor() { selectVpc(this, notImported); } }',
    'class Example { constructor(primary: unknown) { selectVpc(this, primary); } }',
    'class Example { constructor(selectVpc: Function) { selectVpc(this, primary); } }',
    'class Example { constructor() { selectVpc(this, computed()); } }',
  ]) assert.equal(nativeVpcReferences(root, source(root, body)).used.size, 0);
  const file = source(root, 'class Example { constructor() { let vpc = selectVpc(this, primary); this.database = new Database(this, "Db", { vpc }); } }');
  let value: ts.Expression | undefined;
  const visit = (node: ts.Node): void => { if (ts.isShorthandPropertyAssignment(node)) value = node.name; ts.forEachChild(node, visit); };
  visit(file);
  assert.equal(nativeVpcReferences(root, file).resolve(value), undefined);
  const unrelated = ts.createSourceFile(file.fileName, file.text.replace('../framework/framework-network', '../other/framework-network'), ts.ScriptTarget.Latest, true);
  assert.equal(nativeVpcReferences(root, unrelated).used.size, 0);
  for (const body of [
    'class Example { constructor() { const vpc = selectVpc(this, primary); } attach(vpc: unknown) { this.database = new Database(this, "Db", { vpc }); } }',
    'class Example { constructor() { { const vpc = selectVpc(this, primary); } this.database = new Database(this, "Db", { vpc }); } }',
    'class Example { constructor() { const vpc = selectVpc(this, primary); for (const vpc of otherVpcs) { this.database = new Database(this, "Db", { vpc }); } } }',
  ]) {
    const file = source(root, body);
    let value: ts.Expression | undefined;
    const visit = (node: ts.Node): void => { if (ts.isShorthandPropertyAssignment(node)) value = node.name; ts.forEachChild(node, visit); };
    visit(file);
    assert.equal(nativeVpcReferences(root, file).resolve(value), undefined);
  }
}));

test("native VPC evidence recognizes TypeScript imports written with runtime .js extensions", () => fixture(root => {
  const file = source(root, 'class Example { constructor() { selectVpc(this, primary); } }');
  const runtimeImports = ts.createSourceFile(file.fileName, file.text.replace('"../../../framework-config/networks/alpha"', '"../../../framework-config/networks/alpha/index.js"'), ts.ScriptTarget.Latest, true);
  assert.deepEqual([...nativeVpcReferences(root, runtimeImports).used], ["alpha"]);
}));

test("VPC setting edits preserve unchanged literals and comments inside endpoint settings", async () => {
  const { planNetwork } = await import("../server/edits/networks");
  const { SourceFiles } = await import("../server/source");
  fixture(root => {
    const file = path.join(root, "framework-config/networks/alpha/index.ts");
    const before = `import { defineNetwork } from "@repo/framework/config";
export const alphaVpc = defineNetwork({
  id: "alpha", cidr: "10.0.0.0/16", zones: 2,
  natGateway: false,
  gatewayEndpoints: {
    // Keep S3 traffic private.
    s3: true,
    dynamodb: true,
  },
});\n`;
    writeFileSync(file, before);
    const network = { id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: false, egressOnlyInternetGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: [] };
    const state = { snapshot: { models: { dev: { networks: [network] }, prod: { networks: [network] } } } } as unknown as import("../server/snapshot").StudioState;
    const settings = { cidr: network.cidr, zones: 2 as const, nat: true, ipv6: true, s3: true, dynamodb: true, endpoints: [] };
    assert.equal(planNetwork(root, state, "alpha", settings, new SourceFiles()).after, before.replace("natGateway: false", "natGateway: true"));
    assert.equal(planNetwork(root, state, "alpha", { ...settings, nat: false, s3: false }, new SourceFiles()).after, before.replace("s3: true", "s3: false"));
  });
});

test("VPC setting edits follow the registered declaration in cohesive modules and official aliases", async () => {
  const { planNetwork } = await import("../server/edits/networks");
  const { SourceFiles } = await import("../server/source");
  fixture(root => {
    const file = path.join(root, "framework-config/networks/alpha/index.ts");
    const network = { id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: false, egressOnlyInternetGateway: true, gatewayEndpoints: [], interfaceEndpoints: [] };
    const state = { snapshot: { models: { dev: { networks: [network] }, prod: { networks: [network] } } } } as unknown as import("../server/snapshot").StudioState;
    const settings = { cidr: network.cidr, zones: 2 as const, nat: true, ipv6: true, s3: false, dynamodb: false, endpoints: [] };
    for (const helper of ["defineNetwork", "network"]) {
      const before = `import { defineNetwork as ${helper} } from "@repo/framework/config";\nexport const unrelated = ${helper}({ id: "spare", cidr: "10.1.0.0/16", zones: 2, natGateway: false });\nexport const alphaVpc = ${helper}({ id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: false });\n`;
      writeFileSync(file, before);
      assert.equal(planNetwork(root, state, "alpha", settings, new SourceFiles()).after, before.replace('id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: false', 'id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: true'));
    }
  });
});

test("VPC setting edits refuse to erase comments inside a changed literal", async () => {
  const { planNetwork } = await import("../server/edits/networks");
  const { SourceFiles } = await import("../server/source");
  fixture(root => {
    const file = path.join(root, "framework-config/networks/alpha/index.ts");
    const network = { id: "alpha", cidr: "10.0.0.0/16", zones: 2, natGateway: false, egressOnlyInternetGateway: true, gatewayEndpoints: [], interfaceEndpoints: ["logs"] };
    const state = { snapshot: { models: { dev: { networks: [network] }, prod: { networks: [network] } } } } as unknown as import("../server/snapshot").StudioState;
    const before = 'import { defineNetwork } from "@repo/framework/config";\nexport const alphaVpc = defineNetwork({ id: "alpha", cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: [/* log delivery */ "logs"] });\n';
    writeFileSync(file, before);
    assert.throws(() => planNetwork(root, state, "alpha", { cidr: network.cidr, zones: 2, nat: false, ipv6: true, s3: false, dynamodb: false, endpoints: ["logs", "ssm"] }, new SourceFiles()), /comment/i);
  });
});

test("unused VPC removal handles registry separators and refuses custom modules or surviving references", async () => {
  const { planNetworkRemoval } = await import("../server/edits/networks");
  const { SourceFiles } = await import("../server/source");
  const { locateConfigSource } = await import("../../packages/framework/scripts/config-source");
  fixture(root => {
    const config = path.join(root, "framework.config.ts");
    const state = { snapshot: { models: Object.fromEntries(["dev", "prod"].map(mode => [mode, { networks: ["alpha", "beta"].map(id => ({ id })), targets: [] }])) } } as unknown as import("../server/snapshot").StudioState;
    for (const registry of ["alphaVpc, betaVpc", "alphaVpc, betaVpc,", "\n  alphaVpc,\n  betaVpc,\n"]) {
      writeFileSync(config, `import { alphaVpc } from "./framework-config/networks/alpha";\nimport { betaVpc } from "./framework-config/networks/beta";\ndefineFrameworkConfig({ networks: [${registry}] });`);
      for (const removed of ["alpha", "beta"]) {
        const changes = planNetworkRemoval(root, state, removed, new SourceFiles());
        const rootChange = changes.find(change => change.file === config)!;
        assert.equal(changes.find(change => change.file === path.join(root, `framework-config/networks/${removed}/index.ts`))!.after, null);
        const overlay = new Map([[config, rootChange.after!]]);
        assert.deepEqual(locateConfigSource(config, { repositoryRoot: root, host: new SourceFiles(overlay).host() }).networks.map(network => network.id), [removed === "alpha" ? "beta" : "alpha"]);
      }
    }
    const consumer = path.join(root, "native.ts");
    for (const reference of [
      'export { alphaVpc as sharedNetwork } from "./framework-config/networks/alpha";',
      'export { alphaVpc as sharedNetwork } from "./framework-config/networks/alpha/index.js";',
      'export const load = () => import("./framework-config/networks/alpha/index.js");',
    ]) {
      writeFileSync(consumer, reference);
      assert.throws(() => planNetworkRemoval(root, state, "alpha", new SourceFiles()), /native\.ts/);
    }
    rmSync(consumer);
    const declaration = path.join(root, "framework-config/networks/alpha/index.ts");
    writeFileSync(declaration, 'import { defineNetwork } from "@repo/framework/config";\nexport const alphaVpc = defineNetwork({ id: "alpha", cidr: "10.0.0.0/16", zones: 2 });\nexport const unrelated = true;');
    assert.throws(() => planNetworkRemoval(root, state, "alpha", new SourceFiles()), /other declarations or custom code/);
  });
});
