import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { insertProperty, removeProperty, replaceValue } from "../server/edits/splice";
import { findProperty, parse, unwrap } from "../server/source/syntax";

/**
 * The three text operations, on source written the way this repository writes
 * it. Each asserts the whole output, so anything outside the intended span
 * changing — a comment, a blank line, a quote — fails the test.
 */

function objectIn(text: string, name = "entry"): { sourceFile: ts.SourceFile; object: ts.ObjectLiteralExpression } {
  const sourceFile = parse("fixture.ts", text);
  let object: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (object) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(value)) object = value;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(object, `fixture declares ${name}`);
  return { sourceFile, object };
}

const ENTRY = `export const entry = {
  directory: "/lambda_functions/http_functions/x",
  methods: ["POST"],
  // The AWS SDK's first ECS call is not free on a cold start.
  memorySize: 256, // tuned
  timeoutSeconds: 15,
  userPool: true,
  environment: { ...shared },
  cloud: {
    bindings: [runsTask("t")],
  },
} satisfies HttpSection;
`;

test("replacing a literal changes only the literal", () => {
  const { sourceFile, object } = objectIn(ENTRY);
  const property = findProperty(object, "memorySize").property as ts.PropertyAssignment;
  assert.equal(replaceValue(ENTRY, sourceFile, property, 512), ENTRY.replace("memorySize: 256,", "memorySize: 512,"));
});

test("replacing a string keeps the file's quote and a trailing `as const`", () => {
  const text = `const entry = { deploy: 'local-only' as const };\n`;
  const { sourceFile, object } = objectIn(text);
  const property = findProperty(object, "deploy").property as ts.PropertyAssignment;
  assert.equal(replaceValue(text, sourceFile, property, "both"), `const entry = { deploy: 'both' as const };\n`);
});

test("inserting after an anchor lands on its own line, below any trailing comment", () => {
  const { sourceFile, object } = objectIn(ENTRY);
  const result = insertProperty(ENTRY, sourceFile, object, ["deploy"], "both", { after: ["memorySize", "timeoutSeconds"], before: ["userPool"] });
  assert.equal(
    result,
    ENTRY.replace("  timeoutSeconds: 15,\n", '  timeoutSeconds: 15,\n  deploy: "both",\n'),
  );
});

test("inserting before an anchor goes above the anchor's own comments", () => {
  const text = `const entry = {
  directory: "/x",
  // Whoever reads this needs the pool.
  userPool: true,
};
`;
  const { sourceFile, object } = objectIn(text);
  const result = insertProperty(text, sourceFile, object, ["deploy"], "none", { after: [], before: ["userPool"] });
  assert.equal(result, text.replace("  // Whoever", '  deploy: "none",\n  // Whoever'));
});

test("inserting after a last property without a trailing comma keeps that style", () => {
  const text = `const entry = {\n  directory: "/x",\n  memorySize: 256\n};\n`;
  const { sourceFile, object } = objectIn(text);
  const result = insertProperty(text, sourceFile, object, ["timeoutSeconds"], 30, { after: ["memorySize"], before: [] });
  assert.equal(result, `const entry = {\n  directory: "/x",\n  memorySize: 256,\n  timeoutSeconds: 30\n};\n`);
});

test("inserting into a one-line object stays on one line", () => {
  const text = `const entry = { directory: "/x", cpu: 256 };\n`;
  const { sourceFile, object } = objectIn(text);
  assert.equal(
    insertProperty(text, sourceFile, object, ["subnet"], "private", { after: ["cpu"], before: [] }),
    `const entry = { directory: "/x", cpu: 256, subnet: "private" };\n`,
  );
});

test("a missing parent object is created around the property", () => {
  const text = `const entry = {\n  deploy: "both",\n};\n`;
  const { sourceFile, object } = objectIn(text);
  assert.equal(
    insertProperty(text, sourceFile, object, ["cloud", "subnet"], "private", { after: ["deploy"], before: [] }),
    `const entry = {\n  deploy: "both",\n  cloud: { subnet: "private" },\n};\n`,
  );
});

test("inserting into an empty object writes it on one line", () => {
  const text = `const entry = {};\n`;
  const { sourceFile, object } = objectIn(text);
  assert.equal(insertProperty(text, sourceFile, object, ["deploy"], "none", { after: [], before: [] }), `const entry = { deploy: "none" };\n`);
});

test("inserting into an empty commented object refuses without discarding authored prose", () => {
  for (const text of ["const entry = { /* preserve this policy */ };\n", "const entry = {\n  // Reserved for production settings.\n};\n"]) {
    const { sourceFile, object } = objectIn(text);
    assert.throws(() => insertProperty(text, sourceFile, object, ["deploy"], "none", { after: [], before: [] }), /comment/i);
  }
});

test("removing a property takes its whole line and nothing else", () => {
  const text = `const entry = {\n  directory: "/x",\n  timeoutSeconds: 15,\n  userPool: true,\n};\n`;
  const { sourceFile, object } = objectIn(text);
  const property = findProperty(object, "timeoutSeconds").property as ts.PropertyAssignment;
  assert.equal(removeProperty(text, sourceFile, object, property), `const entry = {\n  directory: "/x",\n  userPool: true,\n};\n`);
});

test("removing a commented property is refused, so the author's prose is never dropped", () => {
  const { sourceFile, object } = objectIn(ENTRY);
  const property = findProperty(object, "memorySize").property as ts.PropertyAssignment;
  assert.throws(() => removeProperty(ENTRY, sourceFile, object, property), /comment/);
});

test("removing from a one-line object removes the separator with it", () => {
  const text = `const entry = { cpu: 256, subnet: "private", memoryMiB: 512 };\n`;
  const { sourceFile, object } = objectIn(text);
  const property = findProperty(object, "subnet").property as ts.PropertyAssignment;
  assert.equal(removeProperty(text, sourceFile, object, property), `const entry = { cpu: 256, memoryMiB: 512 };\n`);
  const only = `const entry = { subnet: "private" };\n`;
  const single = objectIn(only);
  const onlyProperty = findProperty(single.object, "subnet").property as ts.PropertyAssignment;
  assert.equal(removeProperty(only, single.sourceFile, single.object, onlyProperty), `const entry = {};\n`);
});
