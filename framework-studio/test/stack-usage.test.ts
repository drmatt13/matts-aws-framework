import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readStackUsage } from "../server/source/stack-usage";
import type { CatalogEntrySource } from "../server/source/catalog";

function fixture(app: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.resolve(__dirname, "../../.cache/stack-usage-"));
  const files = { "cdk-app/cdk.json": JSON.stringify({ app: "npx tsx bin/main.ts" }), "cdk-app/bin/main.ts": app, "cdk-app/lib/stack.ts": "export class ExampleStack {}", ...extra };
  for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
  const location = { file: "cdk-app/lib/stack.ts", line: 1, column: 1, start: 0, end: 1 };
  const catalog = new Map<string, CatalogEntrySource>([["example", { key: location, value: location, stack: { className: "ExampleStack", location, members: [] } }]]);
  return { read: () => readStackUsage(root, catalog).get("example")!, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("catalog/type imports and unused stack files do not instantiate a stack", () => {
  const item = fixture('import type { ExampleStack } from "../lib/stack";', { "cdk-app/bin/unused.ts": 'import { ExampleStack } from "../lib/stack"; new ExampleStack();' });
  try { assert.deepEqual(item.read(), { status: "unreferenced", sites: [] }); } finally { item.dispose(); }
});

test("runtime require, constructor aliases and reexports retain source evidence without evaluating conditions", () => {
  const item = fixture('require("./application");', { "cdk-app/bin/application.ts": 'import { Renamed as ApplicationStack } from "../lib/barrel"; if (false) new ApplicationStack();', "cdk-app/lib/barrel.ts": 'export { ExampleStack as Renamed } from "./stack";' });
  try { assert.equal(item.read().status, "referenced"); assert.equal(item.read().sites[0]?.file, "cdk-app/bin/application.ts"); } finally { item.dispose(); }
});

test("namespace and default imports resolve to the actual class", () => {
  for (const [source, declaration] of [['import * as stacks from "../lib/stack"; new stacks.ExampleStack();', "export class ExampleStack {}"], ['import Stack from "../lib/stack"; new Stack();', "export default class ExampleStack {}"]]) {
    const item = fixture(source!, { "cdk-app/lib/stack.ts": declaration! });
    try { assert.equal(item.read().status, "referenced"); } finally { item.dispose(); }
  }
});

test("an unresolved app module reports uncertainty instead of claiming the stack is unused", () => {
  const item = fixture('require("./missing");');
  try { assert.equal(item.read().status, "unknown"); } finally { item.dispose(); }
});

test("type-only reexports do not pull constructor calls into the runtime graph", () => {
  const item = fixture('import "../lib/barrel";', { "cdk-app/lib/barrel.ts": 'export { type ExampleStack } from "./stack";', "cdk-app/lib/stack.ts": "export class ExampleStack {} new ExampleStack();" });
  try { assert.equal(item.read().status, "unreferenced"); } finally { item.dispose(); }
});
