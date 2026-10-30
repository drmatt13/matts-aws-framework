import assert from "./support/assert";
import { test } from "node:test";
import { parseDisplayNames, remapNamingMetadata, rewriteDisplayName } from "../server/naming-metadata";
import { parseDescriptions } from "../server/descriptions";
import { DESCRIPTION_FILE, connectionDescriptionId } from "../shared/descriptions";
import { DISPLAY_NAMES_FILE, displayNameError } from "../shared/naming";
import { withCommentReview, reviewedComments } from "../server/edits/comments";

test("display names are literal, trimmed, single-line labels with duplicate values allowed", () => {
  const text = 'export const displayNames = { "resource:one": "Same", "resource:two": "Same" } as const;';
  assert.equal(parseDisplayNames(text).values["resource:one"], "Same");
  for (const value of ["x".repeat(121), "a\nb", "a\tb", "a\u2028b", "a\u2029b", "\0"]) assert.ok(displayNameError(value));
  for (const text of ['export const displayNames = { ...other };', 'export const displayNames = { a: run() };', 'export const displayNames = { a: "b", a: "c" };', 'export const displayNames = { a: `a${run()}` };', 'export const displayNames = { a: " " };']) assert.throws(() => parseDisplayNames(text));
  const created = rewriteDisplayName(null, "resource:one", "  Friendly name  ");
  assert.equal(parseDisplayNames(created).values["resource:one"], "Friendly name");
  assert.equal(parseDisplayNames(rewriteDisplayName(created, "resource:one", null)).values["resource:one"], undefined);
});

test("display-label editing preserves comments and clearing shares comment review", () => {
  const source = '// header\nexport const displayNames = {\n  "resource:one": "Before", // human context\n};\n';
  assert.equal(rewriteDisplayName(source, "resource:one", "After"), source.replace('"Before"', '"After"'));
  withCommentReview(process.cwd(), undefined, () => {
    const cleared = rewriteDisplayName(source, "resource:one", "");
    assert.ok(cleared.includes("human context"));
    assert.equal(reviewedComments().length, 1);
    assert.equal(parseDisplayNames(cleared).values["resource:one"], undefined);
  });
});

test("rename moves node, descendants and connection associations while preserving prose", () => {
  const key = connectionDescriptionId({ id: "unused", relation: "env", from: "lambda:one", to: "resource:group.child", label: "KEY", provenance: "declared" });
  const source = `// Keep this note\nexport const descriptions = { "resource:group": "group prose", "resource:group.child": "Keep resource:group.child in prose", ${JSON.stringify(key)}: "connection prose", "resource:unrelated": "untouched" };`;
  const remap = { "resource:group": "resource:renamed" };
  const after = remapNamingMetadata(source, DESCRIPTION_FILE, remap);
  const values = parseDescriptions(after).values;
  assert.equal(values["resource:renamed.child"], "Keep resource:group.child in prose");
  assert.equal(values[key.replace("resource:group.child", "resource:renamed.child")], "connection prose");
  assert.equal(values["resource:group"], undefined);
  assert.ok(after.includes("// Keep this note"));
  const display = 'export const displayNames = { "resource:group.child": "A custom name" };';
  assert.equal(parseDisplayNames(remapNamingMetadata(display, DISPLAY_NAMES_FILE, remap)).values["resource:renamed.child"], "A custom name");
  assert.throws(() => remapNamingMetadata('export const displayNames = { "resource:group": "A", "resource:renamed": "B" };', DISPLAY_NAMES_FILE, remap), /already contains/);
});
