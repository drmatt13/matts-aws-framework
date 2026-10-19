import ts from "typescript";
import type { TriggerAdapterMetadata } from "../../shared/triggers";
import { literalKey, unwrap } from "./syntax";

/** Conservative syntax facts; values are only booleans/durations, never evaluated CDK. */
export function triggerFacts(member: ts.Node, name: string, initial: ts.Expression | undefined, adapters: readonly TriggerAdapterMetadata[]): Readonly<Record<string, boolean | number | undefined>> {
  const result: Record<string, boolean | number | undefined> = {};
  const object = initial && ts.isNewExpression(initial) ? initial.arguments?.[2] : undefined;
  const properties = object && ts.isObjectLiteralExpression(unwrap(object)) ? unwrap(object) as ts.ObjectLiteralExpression : undefined;
  const nested = (expression: ts.Expression, keys: readonly string[]): ts.Expression | undefined => {
    const value = unwrap(expression);
    if (!keys.length) return value;
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    const property = value.properties.find((item) => literalKey(item) === keys[0]);
    return property && ts.isPropertyAssignment(property) ? nested(property.initializer, keys.slice(1)) : undefined;
  };
  for (const fact of adapters.flatMap((adapter) => adapter.facts ?? [])) {
    const property = properties?.properties.find((item) => fact.properties.includes(literalKey(item) ?? ""));
    const expression = property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    let value: boolean | number | undefined;
    if (expression) {
      if (fact.kind === "presence") value = expression.kind !== ts.SyntaxKind.UndefinedKeyword && expression.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(expression) && expression.text === "undefined") && !(ts.isArrayLiteralExpression(expression) && !expression.elements.length);
      else if (fact.kind === "suffix") value = ts.isStringLiteralLike(expression) && fact.suffix ? expression.text.endsWith(fact.suffix) : undefined;
      else if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) value = expression.kind === ts.SyntaxKind.TrueKeyword;
      else if (fact.kind === "duration" && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.arguments[0] && ts.isNumericLiteral(expression.arguments[0])) {
        const scale: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
        const multiplier = scale[expression.expression.name.text];
        if (multiplier) value = Number(expression.arguments[0].text) * multiplier;
      }
    } else if (properties && !properties.properties.some(ts.isSpreadAssignment) || initial && ts.isNewExpression(initial) && initial.arguments?.length === 2) value = fact.fallback;
    if (fact.assignmentPath && ts.isClassDeclaration(member.parent)) {
      const constructor = member.parent.members.find(ts.isConstructorDeclaration);
      const aliases = new Map<string, string>();
      const access = (expression: ts.Expression): string | undefined => {
        const node = unwrap(expression);
        if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
        if (ts.isIdentifier(node)) return aliases.get(node.text);
        if (ts.isPropertyAccessExpression(node)) { const base = access(node.expression); return base && `${base}.${node.name.text}`; }
        return undefined;
      };
      for (const statement of constructor?.body?.statements ?? []) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) { const path = access(declaration.initializer); if (path) aliases.set(declaration.name.text, path); }
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const left = access(statement.expression.left), expected = `this.${name}.node.defaultChild.${fact.assignmentPath}`;
        // The field's own construction is the initializer read above, not an L1 assignment.
        if (!left || left === `this.${name}` || !expected.startsWith(`${left}.`)) continue;
        const assigned = nested(statement.expression.right, expected.slice(left.length + 1).split("."));
        if (assigned?.kind === ts.SyntaxKind.TrueKeyword || assigned?.kind === ts.SyntaxKind.FalseKeyword) value = assigned.kind === ts.SyntaxKind.TrueKeyword;
        else value = undefined;
      }
    }
    result[fact.name] = value;
  }
  return result;
}
