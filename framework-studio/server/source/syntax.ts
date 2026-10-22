import ts from "typescript";
import type { Editability } from "../../shared/model";

/**
 * The few syntactic questions the studio asks of authored source.
 *
 * Syntactic on purpose, like the framework's own source checks: no program, no
 * type checker, no module resolution. The studio only ever edits a literal in
 * an object literal, and those are visible without types.
 */

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Distinguish source comments from comment-like text inside literal values. */
export function hasComments(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  }
  return false;
}

/** Strips the wrappers an authored value may carry: parentheses, `satisfies`, `as`. */
export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) current = current.expression;
    else return current;
  }
}

/** The outermost expression whose text is exactly this span. */
export function expressionAt(sourceFile: ts.SourceFile, start: number, end: number): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found || node.end < start || node.pos > end) return;
    if (node.getStart(sourceFile) === start && node.end === end && ts.isExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A property's key as written, or undefined when it is not a literal. */
export function literalKey(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

/** The value of a literal the studio can write back, or undefined for anything else. */
export function literalValue(node: ts.Expression): { readonly value: string | number | boolean } | undefined {
  const expression = unwrap(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return { value: expression.text };
  if (ts.isNumericLiteral(expression)) return { value: Number(expression.text.replace(/_/g, "")) };
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return { value: -Number(expression.operand.text.replace(/_/g, "")) };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  return undefined;
}

export interface PropertyLookup {
  /** The last assignment of the key, which is the one that wins. */
  readonly property?: ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
  /** A spread after the property, or anywhere when the key is absent, may supply the key instead. */
  readonly spread?: ts.SpreadAssignment;
}

export function findProperty(object: ts.ObjectLiteralExpression, name: string): PropertyLookup {
  let property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined;
  let spread: ts.SpreadAssignment | undefined;
  for (const element of object.properties) {
    if (ts.isSpreadAssignment(element)) {
      spread = element;
      continue;
    }
    if ((ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) && literalKey(element) === name) {
      property = element;
      spread = undefined;
    }
  }
  return { ...(property ? { property } : {}), ...(spread ? { spread } : {}) };
}

/**
 * The object an entry's fields are written on.
 *
 * An entry is an object literal, except a workflow, whose fields are the
 * options object passed to `workflow(graph, { ... })`. A chain such as
 * `["authorizer"]` descends into a nested object literal.
 */
export function declarationObject(
  value: ts.Expression,
  section: string,
  chain: readonly string[],
): { readonly object: ts.ObjectLiteralExpression } | { readonly unsupported: string } {
  let node = unwrap(value);
  if (section === "workflows") {
    const call = ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    const officialAlias = call && node.getSourceFile().statements.some(statement => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@repo/framework/config" || statement.importClause?.isTypeOnly) return false;
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding => !binding.isTypeOnly && (binding.propertyName?.text ?? binding.name.text) === "workflow" && binding.name.text === call);
    });
    if (!ts.isCallExpression(node) || !call || (call !== "workflow" && !officialAlias)) {
      return { unsupported: "This workflow is not declared with workflow(...) directly." };
    }
    const options = node.arguments[1];
    if (!options) return { unsupported: "This workflow passes no options object." };
    node = unwrap(options);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return { unsupported: `This declaration is produced by an expression (${node.getText().slice(0, 60)}), not written as an object literal.` };
  }
  let object = node;
  for (const link of chain) {
    const { property } = findProperty(object, link);
    const inner = property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    if (!inner || !ts.isObjectLiteralExpression(inner)) {
      return { unsupported: `Its ${link} is not written as an object literal.` };
    }
    object = inner;
  }
  return { object };
}

export interface PropertyPosition {
  readonly editability: Editability;
  /** The object the next missing segment would be inserted into. */
  readonly container: ts.ObjectLiteralExpression;
  /** Path segments that do not exist yet, outermost first. */
  readonly missing: readonly string[];
  /** The property holding the value, when the whole path exists. */
  readonly property?: ts.PropertyAssignment;
}

/** What the source says at a property path, and where a change to it would go. */
export function propertyAt(object: ts.ObjectLiteralExpression, path: readonly string[]): PropertyPosition {
  let container = object;
  for (const [index, segment] of path.entries()) {
    const { property, spread } = findProperty(container, segment);
    const last = index === path.length - 1;
    if (spread) {
      return { editability: { kind: "spread", text: spread.getText() }, container, missing: path.slice(index) };
    }
    if (!property) return { editability: { kind: "absent" }, container, missing: path.slice(index) };
    if (ts.isShorthandPropertyAssignment(property)) {
      return { editability: { kind: "computed", text: property.getText() }, container, missing: [] };
    }
    const initializer = unwrap(property.initializer);
    if (!last) {
      if (!ts.isObjectLiteralExpression(initializer)) {
        return { editability: { kind: "computed", text: property.initializer.getText() }, container, missing: [] };
      }
      container = initializer;
      continue;
    }
    if (literalValue(property.initializer)) {
      return { editability: { kind: "literal", text: property.initializer.getText() }, container, missing: [], property };
    }
    return { editability: { kind: "computed", text: property.initializer.getText() }, container, missing: [], property };
  }
  return { editability: { kind: "unsupported", reason: "An empty property path." }, container, missing: [] };
}

/** One-based line and column of an offset. */
export function lineAndColumn(sourceFile: ts.SourceFile, offset: number): { readonly line: number; readonly column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character + 1 };
}
