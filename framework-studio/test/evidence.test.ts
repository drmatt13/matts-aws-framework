import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AuthoredSource, sourceEvidence, withConnectionEvidence } from "../server/source/evidence";
import { SourceFiles } from "../server/source";
import ts from "typescript";
import type { ModeModel, ModelEdge, SourceIndex } from "../shared/model";

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

test("binding editability comes from literal syntax rather than sanitized line text", () => {
  const root = path.resolve(__dirname), file = path.join(root, "binding-fixture.ts");
  for (const field of ["database", "userPool"] as const) for (const authored of [`${field}: true,`, `"${field}": true,`, `${field}: enabled,`, `${field}: false,`, `...{ ${field}: true },`]) {
    const text = `const entry = { ${authored} timeoutSeconds: 10 };`;
    const files = new SourceFiles(new Map([[file, text]]));
    const expression = files.get(file).statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer!;
    const location = { file: "binding-fixture.ts", line: 1, column: 1, start: expression.getStart(), end: expression.end };
    const source = { entities: { "lambda:caller": { origin: "http", key: location, value: location } }, links: {} } as unknown as SourceIndex;
    const link: ModelEdge = { id: "binding", relation: field === "database" ? "database" : "env", from: "lambda:caller", to: "resource:destination", provenance: "derived", label: "USER_POOL_ID" };
    const model = { edges: [link], targets: [{ ref: "lambda:caller", role: "http" }] } as unknown as ModeModel;
    const edge = withConnectionEvidence(root, model, source, new Map(), files).edges[0]!;
    assert.equal(edge.bindingSetting?.field, authored.includes("true") && !authored.startsWith("...") ? field : undefined, authored);
    if (edge.bindingSetting) {
      assert.equal(edge.bindingSetting.value, true);
      assert.equal(text.slice(edge.bindingSetting.source.start, edge.bindingSetting.source.end), authored.startsWith("...") ? `${field}: true` : authored.slice(0, -1));
    }
    assert.ok(edge.evidence?.[0]?.excerpt?.startsWith("const entry"), "whole-line evidence is independent from literal binding facts");
  }
});
