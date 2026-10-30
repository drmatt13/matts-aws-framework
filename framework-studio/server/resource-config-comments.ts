import ts from "typescript";

interface Call { readonly name: string; readonly node: ts.CallExpression; readonly member: ts.PropertyAccessExpression }
interface Builder { readonly source: ts.SourceFile; readonly offset: number; readonly calls: readonly Call[] }
interface Edit { readonly start: number; readonly end: number; readonly value: string }
const FACTORIES = new Set(["value", "fromEnv", "secret"]);
const POLICIES = new Set(["enum", "only", "required", "default", "note"]);

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function builder(text: string): Builder | undefined {
  const prefix = "const value = ";
  const source = ts.createSourceFile("input.ts", `${prefix}${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return undefined;
  const statement = source.statements[0];
  if (source.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)) return undefined;
  const declaration = statement.declarationList.declarations[0];
  if (!declaration?.initializer) return undefined;
  const calls: Call[] = [];
  let node = unwrap(declaration.initializer);
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.unshift({ name: node.expression.name.text, node, member: node.expression });
    node = unwrap(node.expression.expression);
  }
  if (!ts.isIdentifier(node) || !FACTORIES.has(calls[0]?.name ?? "") || calls.slice(1).some(call => !POLICIES.has(call.name))) return undefined;
  if (new Set(calls.slice(1).map(call => call.name)).size !== calls.length - 1) return undefined;
  return { source, offset: prefix.length, calls };
}
function comments(text: string): readonly string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text), result: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) result.push(scanner.getTokenText());
  }
  return result;
}
function retainsComments(before: string, after: string): boolean {
  const next = comments(after);
  let index = 0;
  for (const comment of comments(before)) {
    while (index < next.length && next[index] !== comment) index++;
    if (index === next.length) return false;
    index++;
  }
  return true;
}
function literalEqual(left: ts.Expression, right: ts.Expression): boolean {
  left = unwrap(left); right = unwrap(right);
  return ts.isStringLiteralLike(left) && ts.isStringLiteralLike(right) && left.text === right.text;
}

/** Keep comments on retained builder calls; ambiguous/discarded comments stay source-owned. */
export function preserveResourceBuilderComments(originalExpression: string, desiredExpression: string): string | undefined {
  const original = builder(originalExpression), desired = builder(desiredExpression);
  if (!original || !desired) return undefined;
  const edits: Edit[] = [];
  const add = (start: number, end: number, value: string) => edits.push({ start: start - original.offset, end: end - original.offset, value });
  const argumentsOf = (previous: Call, next: Call): boolean => {
    const oldArgs = previous.node.arguments, nextArgs = next.node.arguments;
    for (let index = 0; index < Math.min(oldArgs.length, nextArgs.length); index++) {
      const before = oldArgs[index]!, after = nextArgs[index]!;
      const oldText = before.getText(original.source), newText = after.getText(desired.source);
      if (oldText === newText || literalEqual(before, after)) continue;
      if (!retainsComments(oldText, newText)) return false;
      add(before.getStart(original.source), before.end, newText);
    }
    if (oldArgs.length > nextArgs.length) {
      const start = nextArgs.length ? oldArgs[nextArgs.length - 1]!.end : previous.node.arguments.pos;
      const end = previous.node.end - 1;
      if (comments(original.source.text.slice(start, end)).length) return false;
      add(start, end, "");
    } else if (nextArgs.length > oldArgs.length) {
      const newText = nextArgs.slice(oldArgs.length).map(argument => argument.getText(desired.source)).join(", ");
      const at = previous.node.end - 1;
      if (oldArgs.length && !oldArgs.hasTrailingComma && oldArgs.at(-1)!.end === at) add(at, at, `, ${newText}`);
      else {
        if (oldArgs.length && !oldArgs.hasTrailingComma) add(oldArgs.at(-1)!.end, oldArgs.at(-1)!.end, ",");
        add(at, at, `${oldArgs.length ? " " : ""}${newText}`);
      }
    }
    return true;
  };
  const first = original.calls[0]!, nextFirst = desired.calls[0]!;
  if (first.name !== nextFirst.name) add(first.member.name.getStart(original.source), first.member.name.end, nextFirst.name);
  if (!argumentsOf(first, nextFirst)) return undefined;
  const policies = new Map(desired.calls.slice(1).map(call => [call.name, call]));
  for (const call of original.calls.slice(1)) {
    const next = policies.get(call.name);
    if (next) { if (!argumentsOf(call, next)) return undefined; policies.delete(call.name); }
    else {
      const start = call.member.expression.end, end = call.node.end;
      if (comments(original.source.text.slice(start, end)).length) return undefined;
      add(start, end, "");
    }
  }
  if (policies.size) {
    const addition = [...policies.values()].map(call => desired.source.text.slice(call.member.expression.end, call.node.end)).join("");
    const at = original.calls.at(-1)!.node.end;
    add(at, at, addition);
  }
  let text = originalExpression, boundary = text.length + 1;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.start < 0 || edit.end > boundary) return undefined;
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    boundary = edit.start;
  }
  return builder(text) && retainsComments(originalExpression, text) ? text : undefined;
}
