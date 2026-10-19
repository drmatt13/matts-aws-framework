import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AuthoredSource, sourceEvidence } from "../server/source/evidence";
import { SourceFiles } from "../server/source";
import ts from "typescript";

test("evidence follows imported groups and overriding object spreads to the authored property", () => {
  const cache = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "evidence-"));
  try {
    writeFileSync(path.join(root, "group.ts"), "export const group = { environment: { NAME: resources.first.value } };\n");
    const file = path.join(root, "config.ts");
    writeFileSync(file, 'import { group as defaults } from "./group";\nconst entry = { ...defaults, environment: { ...defaults.environment, NAME: resources.second.value } };');
    const files = new SourceFiles();
    const source = files.get(file);
    const declaration = source.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer!;
    const authored = new AuthoredSource(files);
    assert.equal(authored.at(declaration, ["environment", "NAME"])!.getText(), "resources.second.value");
    writeFileSync(file, 'import { group as defaults } from "./group";\nconst entry = { ...defaults };');
    const inheritedFiles = new SourceFiles();
    const inherited = inheritedFiles.get(file).statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer!;
    const property = new AuthoredSource(inheritedFiles).at(inherited, ["environment", "NAME"])!;
    assert.equal(property.getText(), "resources.first.value");
    assert.equal(path.resolve(property.getSourceFile().fileName), path.join(root, "group.ts"));
  } finally { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
});

test("excerpts accept only TypeScript and redact literals, templates and comments on the entire line", () => {
  const root = path.resolve(__dirname);
  const file = path.join(root, "redaction.ts");
  const text = 'const KEY = resource.secret("KEY").default("PRIVATE_DEFAULT"); // PRIVATE_COMMENT\nthis.field = `PRIVATE_TEMPLATE${secret}`;\nconst settings = { a: "PRIVATE_VALUE", n: 123456, regex: /PRIVATE_REGEX/ };';
  const files = new SourceFiles(new Map([[file, text]]));
  const evidence = [0, text.indexOf("this.field"), text.indexOf("const settings")].map((start) => sourceEvidence(root, files, "catalog", { file: "redaction.ts", line: 1, column: 1, start, end: start + 1 }));
  const serialized = JSON.stringify(evidence);
  for (const value of ["PRIVATE_DEFAULT", "PRIVATE_COMMENT", "PRIVATE_TEMPLATE", "PRIVATE_VALUE", "123456", "PRIVATE_REGEX"]) assert.ok(!serialized.includes(value), value);
  assert.ok(serialized.includes('secret(\\"KEY\\")'));
  for (const file of [".env", ".env.ts", "secret.json", "../outside.ts"]) assert.equal(sourceEvidence(root, files, "catalog", { file, line: 1, column: 1, start: 0, end: 1 }), undefined);
});
