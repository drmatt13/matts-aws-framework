import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { identityPolicyStatements, type IdentityPolicyEdit, type IdentityPolicySource, type IdentityPolicyStatement } from "../shared/identity-policy";
import type { StudioState } from "./snapshot";
import { assertStackFile } from "./edits/native-triggers";
import { EditError } from "./edits/io";
import { hasComments, literalKey, unwrap } from "./source/syntax";
import { insertExpression } from "./resources-source";
import { removeProperty } from "./edits/splice";
import { sha256 } from "./files";

export function readIdentityPolicyEdit(value: unknown): IdentityPolicyEdit {
  const item = value as Partial<IdentityPolicyEdit> | null;
  if (!item || item.kind !== "identityPolicy" || typeof item.allowUnauthenticated !== "boolean" || typeof item.target !== "string" || !/^resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(item.target) || Object.keys(item).some(key => !["kind", "target", "statements", "allowUnauthenticated"].includes(key))) throw new EditError(400, "Select a generated identity-pool stack, explicit guest opt-in and reader-role policy statements.");
  try { return { kind: "identityPolicy", target: item.target, statements: identityPolicyStatements(item.statements), allowUnauthenticated: item.allowUnauthenticated }; }
  catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
}
function literal(node: ts.Expression): unknown {
  node = unwrap(node);
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return node.kind === ts.SyntaxKind.TrueKeyword;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !literalKey(property) || Object.hasOwn(result, literalKey(property)!)) throw new Error("Policy data must be explicit literal properties without spreads or duplicates.");
      result[literalKey(property)!] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("Computed policy data requires source review in your editor.");
}
function options(file: string, text: string, className: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imported = source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "./identity-pool-access" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(binding => binding.name.text === "identityPoolAccess" && !binding.propertyName));
  if (!imported) throw new Error("This stack does not use the recognized identityPoolAccess import. Edit its native source deliberately.");
  const shadowed = (node: ts.Node): boolean => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === "identityPoolAccess") return true;
    return ts.forEachChild(node, child => shadowed(child) || undefined) === true;
  };
  if (shadowed(source)) throw new Error("A shadowed identityPoolAccess binding is custom source. Open its native source deliberately.");
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isClassDeclaration(node) && node.name?.text !== className) return; if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "identityPoolAccess") calls.push(node); ts.forEachChild(node, visit); };
  visit(source);
  const call = calls[0];
  if (calls.length !== 1 || call?.arguments.length !== 2 || call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword || !ts.isObjectLiteralExpression(call.arguments[1]!)) throw new Error("Policy editing supports one generated identityPoolAccess(this, { … }) call only. Open its source for a custom shape.");
  const constructor = call.parent.parent?.parent?.parent?.parent;
  if (!ts.isVariableDeclaration(call.parent) || !ts.isIdentifier(call.parent.name) || call.parent.name.text !== "access" || !constructor || !ts.isConstructorDeclaration(constructor) || !ts.isClassDeclaration(constructor.parent) || constructor.parent.name?.text !== className) throw new Error("The helper must remain the generated constructor's access declaration. Custom call placement requires native source review.");
  const object = call.arguments[1] as ts.ObjectLiteralExpression;
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    const name = literalKey(property);
    if (!ts.isPropertyAssignment(property) || !name || properties.has(name) || !["userPool", "userPoolClient", "groupName", "readBucketArn", "readPrefix", "readerPolicyStatements", "allowUnauthenticated"].includes(name)) throw new Error("Custom helper options, spreads and duplicate properties require native source review.");
    properties.set(name, property);
  }
  if (properties.get("userPool")?.initializer.getText(source) !== "props.userPool" || properties.get("userPoolClient")?.initializer.getText(source) !== "props.userPoolClient" || typeof literal(properties.get("groupName")?.initializer ?? ts.factory.createNull()) !== "string") throw new Error("This stack's identity provider/group wiring is custom. Policy editing cannot change or infer its trust.");
  return { source, object, properties };
}
export function identityPolicySource(root: string, state: StudioState, target: string, overlays: ReadonlyMap<string, string> = new Map()) {
  const resource = Object.values(state.snapshot.models).flatMap(model => model.resources).find(resource => resource.id === target && resource.kind === "stack");
  const entry = resource && state.built.catalog.get(resource.path.join("."));
  const stack = entry?.stack;
  if (!stack?.location || !["identityPool", "authenticatedRole", "readerRole", "readerGroup"].every(name => stack.members.some(member => member.name === name))) throw new EditError(422, "Select a recognized generated identity-pool catalog stack. Custom/native role policies remain source-owned.");
  const file = assertStackFile(root, state, stack.location.file); const text = overlays.get(file) ?? readFileSync(file, "utf8");
  try {
    const parsed = options(file, text, stack.className);
    const policy = parsed.properties.get("readerPolicyStatements");
    const bucket = parsed.properties.get("readBucketArn"); const prefix = parsed.properties.get("readPrefix");
    if (policy && (bucket || prefix)) throw new Error("Competing policy options require source review; remove the obsolete bucket/prefix authority first.");
    const statements = policy ? identityPolicyStatements(literal(policy.initializer)) : bucket ? identityPolicyStatements([{ Effect: "Allow", Action: ["s3:GetObject"], Resource: [`${literal(bucket.initializer)}/${prefix ? literal(prefix.initializer) : ""}*`] }]) : [];
    const guest = parsed.properties.get("allowUnauthenticated"); const allowUnauthenticated = guest ? literal(guest.initializer) : false;
    if (typeof allowUnauthenticated !== "boolean") throw new Error("Guest opt-in must be an explicit boolean literal.");
    return { file, relative: stack.location.file, text, className: stack.className, ...parsed, statements, allowUnauthenticated };
  } catch (error) { throw new EditError(422, `${error instanceof Error ? error.message : error} Source: ${stack.location.file}`); }
}
export function identityPolicySources(root: string, state: StudioState): IdentityPolicySource[] {
  const seen = new Set<string>(); const result: IdentityPolicySource[] = [];
  for (const model of Object.values(state.snapshot.models)) for (const resource of model.resources) {
    if (resource.kind !== "stack" || seen.has(resource.id)) continue;
    seen.add(resource.id); const stack = state.built.catalog.get(resource.path.join("."))?.stack;
    if (!stack?.members.some(member => member.name === "identityPool")) continue;
    try { const source = identityPolicySource(root, state, resource.id); result.push({ target: resource.id, file: source.relative, statements: source.statements, allowUnauthenticated: source.allowUnauthenticated }); }
    catch (error) { result.push({ target: resource.id, file: stack.location?.file ?? "native source", statements: [], allowUnauthenticated: false, problem: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}
export function planIdentityPolicy(root: string, state: StudioState, edit: IdentityPolicyEdit, overlays: Map<string, string>) {
  readIdentityPolicyEdit(edit);
  const original = identityPolicySource(root, state, edit.target, overlays);
  let text = original.text;
  // One policy authority: replace convenience bucket options with literal statements.
  for (const name of ["readBucketArn", "readPrefix"]) {
    const parsed = options(original.file, text, original.className); const property = parsed.properties.get(name);
    if (property) {
      if (hasComments(property.getFullText(parsed.source))) throw new EditError(422, "Bucket convenience settings have authored comments. Edit them in source so those comments are preserved.");
      text = removeProperty(text, parsed.source, parsed.object, property);
    }
  }
  const parsed = options(original.file, text, original.className); const property = parsed.properties.get("readerPolicyStatements");
  if (property) {
    if (hasComments(property.getText(parsed.source))) throw new EditError(422, "This policy has authored comments. Edit it in source so those comments are preserved.");
    text = text.slice(0, property.initializer.getStart(parsed.source)) + JSON.stringify(edit.statements, null, 2) + text.slice(property.initializer.end);
  } else text = insertExpression(text, parsed.source, parsed.object, ["readerPolicyStatements"], JSON.stringify(edit.statements, null, 2));
  const guestParsed = options(original.file, text, original.className); const guest = guestParsed.properties.get("allowUnauthenticated");
  if (guest) {
    if (hasComments(guest.getText(guestParsed.source))) throw new EditError(422, "Guest settings have authored comments. Edit them in source deliberately.");
    text = text.slice(0, guest.initializer.getStart(guestParsed.source)) + String(edit.allowUnauthenticated) + text.slice(guest.initializer.end);
  } else text = insertExpression(text, guestParsed.source, guestParsed.object, ["allowUnauthenticated"], String(edit.allowUnauthenticated));
  overlays.set(original.file, text);
  return { file: original.file, hashes: identityPolicyAuthorityHashes(root, original.relative) };
}

export function identityPolicyAuthorityHashes(root: string, source: string): Record<string, string> {
  return Object.fromEntries([source, "cdk-app/lib/app/identity-pool-access.ts", "cdk-app/lib/app/identity-policy.ts"].map(file => [file, sha256(readFileSync(path.join(root, file), "utf8"))]));
}
