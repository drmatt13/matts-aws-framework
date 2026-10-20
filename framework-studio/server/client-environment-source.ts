import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT_ENV_STACK_OUTPUTS } from "../../scripts/root-env-outputs";
import { CLIENT_ENVIRONMENT_FILE, clientMappingsError, type ClientEnvironmentMappings } from "../shared/client-environment";
import type { ModeModel } from "../shared/model";
import { literalKey, parse, unwrap } from "./source/syntax";

/** Interpret literal data only; mapping source is never executed by Studio. */
export function parseClientMappings(text: string) {
  const source = parse(CLIENT_ENVIRONMENT_FILE, text);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Fix the client mapping file's TypeScript syntax.");
  const declarations = source.statements.filter(ts.isVariableStatement).filter((statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap((statement) => statement.declarationList.declarations).filter((item) => ts.isIdentifier(item.name) && item.name.text === "clientEnvironment");
  const initializer = declarations.length === 1 && declarations[0]!.initializer;
  const object = initializer && unwrap(initializer);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${CLIENT_ENVIRONMENT_FILE} must export const clientEnvironment as a literal object.`);
  const literal = (expression: ts.Expression): unknown => {
    const value = unwrap(expression);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(value)) return value.elements.map((item) => literal(item as ts.Expression));
    if (ts.isObjectLiteralExpression(value)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of value.properties) {
        const key = literalKey(property);
        if (!ts.isPropertyAssignment(property) || key === undefined || Object.hasOwn(result, key)) throw new Error("Mapping keys must be unique literals, without spreads.");
        result[key] = literal(property.initializer);
      }
      return result;
    }
    throw new Error("Client mappings accept literal references only; expressions and calls are not supported.");
  };
  const mappings = literal(object);
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  return { source, object, mappings: mappings as ClientEnvironmentMappings };
}

export function readClientMappings(root: string): { mappings: ClientEnvironmentMappings; problem?: string } {
  try { return { mappings: parseClientMappings(readFileSync(path.join(root, CLIENT_ENVIRONMENT_FILE), "utf8")).mappings }; }
  catch (error) { return { mappings: {}, problem: error instanceof Error ? error.message : String(error) }; }
}

export function validateClientMappings(value: unknown, models: readonly ModeModel[]): asserts value is ClientEnvironmentMappings {
  const error = clientMappingsError(value);
  if (error) throw new Error(error);
  const publicOutputs = new Map<string, Set<string>>(Object.entries(ROOT_ENV_STACK_OUTPUTS).map(([stack, outputs]) => [stack, new Set(Object.keys(outputs))]));
  const sensitive = new Set(models.flatMap((model) => model.resources.flatMap((resource) => [
    ...(resource.kind === "secret" && resource.fromEnv ? [resource.fromEnv] : []),
    ...(resource.deploymentFile?.entries.filter((entry) => entry.sensitive).map((entry) => entry.name) ?? []),
  ])));
  for (const model of models) for (const resource of model.resources) if (resource.stackClass && resource.stackOutputs) {
    const names = publicOutputs.get(resource.stackClass) ?? new Set<string>();
    resource.stackOutputs.forEach((output) => names.add(output.name));
    publicOutputs.set(resource.stackClass, names);
  }
  for (const [name, modes] of Object.entries(value as ClientEnvironmentMappings)) for (const binding of Object.values(modes)) {
    const inputs = binding.kind === "input" ? [binding.name] : binding.kind === "endpoint" ? [binding.port, ...(binding.override ? [binding.override] : [])] : [];
    if (inputs.some((input) => sensitive.has(input))) throw new Error(`${name}: secret inputs cannot be mapped into the client.`);
    if (binding.kind === "output" && binding.outputs.some((output) => !publicOutputs.get(binding.stack)?.has(output))) throw new Error(`${name}: select a public stack output shown in Studio.`);
    if (binding.kind === "region" && !publicOutputs.has(binding.stack) && !models.some((model) => model.resources.some((resource) => resource.kind === "stack" && resource.stackClass === binding.stack))) throw new Error(`${name}: select a stack shown in Studio.`);
  }
}

/** Replace changed fields only so comments and untouched mappings retain their source. */
export function rewriteClientMappings(text: string, mappings: ClientEnvironmentMappings): string {
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  const { source, object, mappings: before } = parseClientMappings(text);
  const edits: { start: number; end: number; value: string }[] = [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = literalKey(property)!;
    if (!Object.hasOwn(mappings, name)) {
      let end = property.end;
      if (text[end] === ",") end++;
      edits.push({ start: property.getStart(source), end, value: "" });
    } else if (JSON.stringify(before[name]) !== JSON.stringify(mappings[name])) {
      edits.push({ start: property.initializer.getStart(source), end: property.initializer.end, value: JSON.stringify(mappings[name], null, 2).replaceAll("\n", "\n  ") });
    }
  }
  const added = Object.entries(mappings).filter(([name]) => !Object.hasOwn(before, name));
  if (added.length) {
    const last = object.properties.filter((property) => Object.hasOwn(mappings, literalKey(property)!)).at(-1);
    if (last && text[last.end] !== ",") edits.push({ start: last.end, end: last.end, value: "," });
    edits.push({ start: object.end - 1, end: object.end - 1, value: added.map(([name, modes]) => `  ${JSON.stringify(name)}: ${JSON.stringify(modes, null, 2).replaceAll("\n", "\n  ")},\n`).join("") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  if (JSON.stringify(parseClientMappings(text).mappings) !== JSON.stringify(mappings)) throw new Error("Client mappings did not round trip. Review the mapping source.");
  return text;
}
