import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

test("every feature schema is registered and has a neighboring executable-schema test", () => {
  const infrastructure = new Set(["index.ts", "builder.ts", "errors.ts"]);
  const features = readdirSync(__dirname).filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !infrastructure.has(name),
  );
  const source = ts.createSourceFile(
    "index.ts",
    readFileSync(join(__dirname, "index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set(
    source.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (node) =>
          node.importClause === undefined &&
          ts.isStringLiteral(node.moduleSpecifier),
      )
      .map((node) => (node.moduleSpecifier as ts.StringLiteral).text),
  );
  assert.ok(features.length > 0);
  for (const file of features) {
    const name = file.slice(0, -3);
    assert.ok(
      imports.has(`./${name}`),
      `${file} must be statically registered in schema/index.ts`,
    );
    assert.ok(
      existsSync(join(__dirname, `${name}.test.ts`)),
      `${file} requires ${name}.test.ts with executable-schema behavior tests`,
    );
  }
});
