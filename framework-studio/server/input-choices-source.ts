import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModelResource, SourceLocation } from "../shared/model";
import { inputChoicesError, inputModeIntents, sameInputModes, type ResourceIntent } from "../shared/resources";
import { preserveResourceBuilderComments } from "./resource-config-comments";

const FILES = { deployment: "cdk-app/deployment-inputs.ts", local: "cdk-app/framework-inputs.ts" } as const;
const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};

/** Fixed public declaration files only. This authority never accepts a path from a request. */
function choiceFile(root: string, owner: string): string | undefined {
  const relative = FILES[owner as keyof typeof FILES];
  if (!relative) return undefined;
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (!existsSync(current)) return undefined;
    if (lstatSync(current).isSymbolicLink()) throw new Error("Input declarations must be regular repository files, without symbolic links.");
  }
  if (!lstatSync(current).isFile()) throw new Error("Input declarations must be regular repository files.");
  return current;
}

/** Inspect literal builder metadata without executing source or reading any environment values. */
export function frameworkInputChoices(root: string, owner: string, key: string, name: string, overlay: ReadonlyMap<string, string> = new Map()) {
  const file = choiceFile(root, owner);
  if (!file) return undefined;
  const text = overlay.get(file) ?? readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineResources" && node.arguments[0]) {
      const object = unwrap(node.arguments[0]);
      if (ts.isObjectLiteralExpression(object)) for (const member of object.properties) {
        if (ts.isPropertyAssignment(member) && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === key) found.push(unwrap(member.initializer));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (found.length !== 1) return undefined;
  const expression = found[0]!;
  const calls: { name: string; node: ts.CallExpression; receiver: ts.Expression }[] = [];
  let node = expression;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.unshift({ name: node.expression.name.text, node, receiver: node.expression.expression });
    node = unwrap(node.expression.expression);
  }
  if (!ts.isIdentifier(node) || node.text !== "resource" || calls[0]?.name !== "fromEnv" || !calls[0].node.arguments[0] || !ts.isStringLiteral(calls[0].node.arguments[0]) || calls[0].node.arguments[0].text !== name) return undefined;
  if (calls.slice(1).some(call => !["enum", "default", "required", "only", "note"].includes(call.name)) || new Set(calls.map(call => call.name)).size !== calls.length) return undefined;
  const enumeration = calls.find(call => call.name === "enum");
  if (enumeration?.node.arguments.some(argument => !ts.isStringLiteral(argument))) return undefined;
  const choices = enumeration?.node.arguments.map(argument => (argument as ts.StringLiteral).text);
  if (choices && (!choices.length || inputChoicesError(choices))) return undefined;
  const defaults: string[] = [];
  const fallback = calls.find(call => call.name === "default");
  if (fallback) for (const argument of fallback.node.arguments) {
    const value = unwrap(argument);
    if (ts.isStringLiteral(value)) defaults.push(value.text);
    else if (ts.isObjectLiteralExpression(value) && value.properties.every(item => ts.isPropertyAssignment(item) && ts.isStringLiteral(item.initializer)))
      for (const item of value.properties) defaults.push(((item as ts.PropertyAssignment).initializer as ts.StringLiteral).text);
    else return undefined;
  }
  const at = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
  const source: SourceLocation = { file: FILES[owner as keyof typeof FILES], line: at.line + 1, column: at.character + 1, start: expression.getStart(sourceFile), end: expression.end };
  return { file, text, sourceFile, expression, calls, enumeration, choices, defaults, source };
}

export function planFrameworkInputChoices(root: string, resource: ModelResource, intent: ResourceIntent, overlay: ReadonlyMap<string, string>) {
  if (!resource.inputChoices || intent.choices === undefined || intent.kind !== "input" || intent.fromEnv !== resource.fromEnv || intent.group !== resource.path.slice(0, -1).join(".") || !sameInputModes(intent.modes, inputModeIntents(resource)) || Object.keys(intent.requirements).length)
    throw new Error("Only allowed values can be edited on this framework input; its reader, identity and environment policy stay managed.");
  const error = inputChoicesError(intent.choices);
  if (error) throw new Error(error);
  const facts = frameworkInputChoices(root, resource.frameworkInput!, resource.path.at(-1)!, resource.fromEnv!, overlay);
  if (!facts) throw new Error("This input's enum is computed or unavailable. Edit its declaration in source.");
  const choices = intent.choices.map(value => value.trim());
  if (choices.length && facts.defaults.some(value => !choices.includes(value))) throw new Error("Every declared default must remain one of the allowed values.");
  const original = facts.expression.getText(facts.sourceFile);
  const start = facts.expression.getStart(facts.sourceFile);
  const call = choices.length ? `.enum(${choices.map(value => JSON.stringify(value)).join(", ")})` : "";
  const from = facts.enumeration ? facts.enumeration.receiver.end - start : facts.calls[0]!.node.end - start;
  const to = facts.enumeration ? facts.enumeration.node.end - start : from;
  const desired = original.slice(0, from) + call + original.slice(to);
  const rewritten = preserveResourceBuilderComments(original, desired);
  if (!rewritten) throw new Error("This enum edit would discard a source comment. Resolve that comment in source, then review again.");
  return { overrides: { ...Object.fromEntries(overlay), [facts.file]: facts.text.slice(0, start) + rewritten + facts.text.slice(facts.expression.end) }, nextResource: resource.id };
}
