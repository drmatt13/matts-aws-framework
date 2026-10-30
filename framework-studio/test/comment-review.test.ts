import assert from "./support/assert";
import test from "node:test";
import ts from "typescript";
import { reviewedComments, withCommentReview } from "../server/edits/comments";
import { removeProperty } from "../server/edits/splice";
import { pruneImports, removeElement, removeStatement } from "../server/edits/source-cleanup";
import { findProperty, parse } from "../server/source/syntax";
import type { CommentReviewOptions } from "../shared/api";

function remove(text: string, key: string, options?: CommentReviewOptions) {
  return withCommentReview("/tmp", options, () => {
    const source = parse("/tmp/comment-review-fixture.ts", text);
    const declaration = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    const object = declaration.initializer as ts.ObjectLiteralExpression;
    const after = removeProperty(text, source, object, findProperty(object, key).property!);
    return { after, comments: reviewedComments() };
  });
}

test("batch removal preserves leading, inline and embedded comments and exposes exact locations", () => {
  const text = 'const entry = {\r\n  // Authored rationale.\r\n  cloud: { /* placement */ subnet: "private" }, // tuned\r\n  memory: 512,\r\n};\r\n';
  const kept = remove(text, "cloud");
  assert.equal(kept.comments.length, 3);
  assert.ok(kept.comments.every(comment => comment.resolution === "keep"));
  assert.deepEqual(kept.comments.map(comment => [comment.line, comment.column]), [[2, 3], [3, 12], [3, 49]]);
  for (const prose of ["// Authored rationale.", "/* placement */", "// tuned"]) assert.ok(kept.after.includes(prose));
  assert.ok(!kept.after.includes("subnet:"));
  assert.ok(kept.after.includes("memory: 512,"));
  assert.ok(kept.comments[0]!.vscodeUrl.endsWith(":2:3"));
  const removed = remove(text, "cloud", { comments: Object.fromEntries(kept.comments.map(comment => [comment.id, "remove"])) });
  for (const prose of ["// Authored rationale.", "/* placement */", "// tuned"]) assert.ok(!removed.after.includes(prose));
  assert.match(removed.after, /memory: 512/);
  assert.equal(ts.transpileModule(removed.after, { reportDiagnostics: true }).diagnostics?.length, 0);
});

test("inline line comments cannot swallow the next surviving property", () => {
  const text = 'const entry = { cloud: {\n  // reasoning\n  subnet: "private"\n}, memory: 512 };';
  const kept = remove(text, "cloud");
  assert.match(kept.after, /\/\/ reasoning\r?\n/);
  const source = parse("/tmp/check.ts", kept.after);
  const object = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer as ts.ObjectLiteralExpression;
  assert.ok(findProperty(object, "memory").property, "the next property remains real code");
});

test("removing the last property preserves a previous property's trailing comment", () => {
  const text = 'const entry = {\n  memory: 512, // memory policy\n  subnet: "private"\n};';
  const kept = remove(text, "subnet");
  assert.equal(kept.comments.length, 0, "the previous property's comment does not belong to the removal");
  assert.match(kept.after, /memory: 512, \/\/ memory policy/);
});

test("comment decisions expire when original source bytes change and directives need manual resolution", () => {
  const text = 'const entry = {\n  // Keep this context.\n  subnet: "private",\n};';
  const kept = remove(text, "subnet");
  assert.throws(() => remove(text + "\n", "subnet", { comments: { [kept.comments[0]!.id]: "remove" } }), /comments changed/);
  const directive = remove(text.replace("Keep this context.", "@ts-expect-error Temporary exception"), "subnet");
  assert.match(directive.comments[0]!.manualReason!, /tooling or diagnostics/);
  assert.match(directive.after, /@ts-expect-error/);
  for (const annotation of ["/*#__PURE__*/", "/* @__NO_SIDE_EFFECTS__ */", '/* webpackChunkName: "feature" */', "/* @vite-ignore */"]) {
    const result = remove(`const entry = {\n  ${annotation}\n  subnet: "private",\n};`, "subnet");
    assert.match(result.comments[0]!.manualReason!, /tooling or diagnostics/);
  }
});

test("array removal preserves next-element comments and handles a sole element", () => {
  for (const text of ['const values = [first,\n  // second policy\n  second];', 'const values = [first];']) {
    const source = parse("/tmp/array-fixture.ts", text);
    const array = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer as ts.ArrayLiteralExpression;
    const after = withCommentReview("/tmp", undefined, () => removeElement(text, array, array.elements[0]!, source));
    assert.equal(after, text.includes("second") ? 'const values = [\n  // second policy\n  second];' : 'const values = [];');
  }
});

test("removing a final inline property or list element restores the original surrounding whitespace", () => {
  assert.equal(remove('const entry = { directory: "/worker", onFailure: {} };', "onFailure").after, 'const entry = { directory: "/worker" };');
  for (const [before, expected] of [
    ['const values = [first, second];', 'const values = [first];'],
    ['const values = [first, second,];', 'const values = [first,];'],
    ['const values = [first, second, ];', 'const values = [first, ];'],
    ['const values = [first, /* first policy */\n  second];', 'const values = [first /* first policy */\n  ];'],
  ]) {
    const source = parse("/tmp/list-whitespace-fixture.ts", before!);
    const array = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer as ts.ArrayLiteralExpression;
    const after = withCommentReview("/tmp", undefined, () => removeElement(before!, array, array.elements[1]!, source));
    assert.equal(after, expected);
  }
});

test("property removal finds a comma after an inline comment and reviews that comment", () => {
  const text = 'const entry = { removed: 1 /* rationale */, kept: 2 };';
  const kept = remove(text, "removed");
  assert.equal(kept.comments.length, 1);
  assert.equal(kept.after, 'const entry = { /* rationale */ kept: 2 };');
  const removed = remove(text, "removed", { comments: { [kept.comments[0]!.id]: "remove" } });
  assert.equal(removed.after, 'const entry = { kept: 2 };');
  assert.equal(ts.transpileModule(kept.after, { reportDiagnostics: true }).diagnostics?.length, 0);
  assert.equal(ts.transpileModule(removed.after, { reportDiagnostics: true }).diagnostics?.length, 0);
});

test("statement removal offers comments rather than deleting an import's authored rationale", () => {
  const text = '// reason\nimport { shared } from "./shared"; // keep context\nconst value = 1;';
  const source = parse("/tmp/statement-fixture.ts", text);
  const result = withCommentReview("/tmp", undefined, () => ({ after: removeStatement(text, source.statements[0]!, source), comments: reviewedComments() }));
  assert.equal(result.comments.length, 2);
  assert.match(result.after, /\/\/ reason\n \/\/ keep context\nconst value = 1;/);
});

test("comment-looking literal data remains literal data", () => {
  const text = 'const entry = { pattern: /https?:\\/\\//, text: "/* data */" };';
  assert.equal(remove(text, "pattern").comments.length, 0);
  assert.equal(remove(text, "text").comments.length, 0);
});

test("partial import pruning reviews the removed binding's comments and preserves the surviving binding's prose", () => {
  for (const declarations of ['kept, /* orphan rationale */ removed', 'removed, /* survivor rationale */ kept']) {
    const before = `import { ${declarations} } from "./shared";\nconsole.log(kept, removed);`;
    const result = withCommentReview("/tmp", undefined, () => ({ after: pruneImports("/tmp/import-fixture.ts", before, before.replace("kept, removed);", "kept);")), comments: reviewedComments() }));
    assert.ok(result.after.includes(declarations.includes("orphan") ? "orphan rationale" : "survivor rationale"));
    assert.ok(!result.after.includes(" removed"));
    if (declarations.includes("orphan")) assert.equal(result.comments.length, 1);
  }
});
