import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModeModel } from "../shared/model";
import { descriptionEntityIds, DESCRIPTION_FILE } from "../shared/descriptions";
import { DISPLAY_NAMES_FILE, displayNameError, remapEntity, type NamingCapability } from "../shared/naming";
import { parseDescriptions } from "./descriptions";
import { assertWritable } from "./files";
import { insertExpression } from "./resources-source";
import { removeProperty } from "./edits/splice";
import { literalKey, parse, unwrap } from "./source/syntax";

/** Names are documentation: parse their literal map without loading a module. */
export function parseDisplayNames(text: string) {
  const source = parse(DISPLAY_NAMES_FILE, text);
  const errors = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (errors.length) throw new Error(`${DISPLAY_NAMES_FILE}: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ")}`);
  const declarations = source.statements.filter(ts.isVariableStatement)
    .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => statement.declarationList.declarations)
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "displayNames");
  const value = declarations.length === 1 && declarations[0]!.initializer;
  const object = value && unwrap(value);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${DISPLAY_NAMES_FILE} must export const displayNames as an object of string literals.`);
  const values: Record<string, string> = Object.create(null);
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || key === undefined || properties.has(key)) throw new Error(`${DISPLAY_NAMES_FILE} requires unique literal keys without spreads.`);
    const value = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(value)) throw new Error(`Display name ${key} must be a string literal.`);
    const error = displayNameError(value.text);
    if (error || value.text.trim() !== value.text || !value.text) throw new Error(`Display name ${key}: ${error ?? "Use a nonblank, trimmed name, or remove its override."}`);
    properties.set(key, property); values[key] = value.text;
  }
  return { source, object, properties, values };
}

export function readDisplayNames(root: string) {
  try { return { values: existsSync(path.join(root, DISPLAY_NAMES_FILE)) ? parseDisplayNames(readFileSync(assertWritable(root, DISPLAY_NAMES_FILE), "utf8")).values : {} }; }
  catch (error) { return { values: {}, problem: error instanceof Error ? error.message : String(error) }; }
}

export function rewriteDisplayName(text: string | null, entity: string, raw: string | null): string {
  const value = (raw ?? "").trim();
  const error = displayNameError(value); if (error) throw new Error(error);
  text ??= "// Shared labels for AWS Studio. Code identities remain source-owned.\nexport const displayNames = {};\n";
  const { source, object, properties } = parseDisplayNames(text);
  const property = properties.get(entity);
  if (!value) return property ? removeProperty(text, source, object, property) : text;
  if (property) return text.slice(0, property.initializer.getStart(source)) + JSON.stringify(value) + text.slice(property.initializer.end);
  return insertExpression(text, source, object, [entity], JSON.stringify(value));
}

/** Associations move; description prose and all unrelated string values stay byte-for-byte. */
export function remapNamingMetadata(text: string, file: typeof DESCRIPTION_FILE | typeof DISPLAY_NAMES_FILE, remap: Readonly<Record<string, string>>): string {
  const { source, properties } = file === DESCRIPTION_FILE ? parseDescriptions(text) : parseDisplayNames(text);
  const moved = new Map<string, string>();
  for (const key of properties.keys()) {
    let next = remapEntity(key, remap);
    if (key.startsWith("connection-description:")) {
      try {
        const parts: unknown = JSON.parse(key.slice("connection-description:".length));
        if (Array.isArray(parts) && parts.length === 5 && parts.slice(0, 4).every(item => typeof item === "string")) {
          parts[1] = remapEntity(parts[1] as string, remap); parts[2] = remapEntity(parts[2] as string, remap);
          if (typeof parts[4] === "string") parts[4] = remapEntity(parts[4], remap);
          next = `connection-description:${JSON.stringify(parts)}`;
        }
      } catch { /* Unrecognized keys remain source-owned. */ }
    }
    if (next !== key) moved.set(key, next);
  }
  const destinations = new Set<string>();
  for (const [key, next] of moved) {
    if (destinations.has(next) || properties.has(next) && !moved.has(next)) throw new Error(`${file} already contains ${next}. Resolve the competing association in source before renaming ${key}.`);
    destinations.add(next);
  }
  const edits = [...moved].map(([key, next]) => ({ start: properties.get(key)!.name.getStart(source), end: properties.get(key)!.name.end, next }));
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + JSON.stringify(edit.next) + text.slice(edit.end);
  return text;
}

export function namingCapabilities(models: readonly ModeModel[]): Readonly<Record<string, NamingCapability>> {
  const result: Record<string, NamingCapability> = Object.create(null);
  const resources = [...new Map(models.flatMap(model => model.resources).map(resource => [resource.id, resource])).values()];
  for (const id of descriptionEntityIds(models)) {
    if (id.startsWith("connection-description:")) continue;
    const resource = resources.find(resource => resource.id === id);
    const authored = !!resource && ["input", "secret"].includes(resource.kind) && (!!resource.fromEnv || resource.authoredValue !== undefined);
    const group = resource?.kind === "group" && resources.filter(other => other.id.startsWith(`${id}.`)).every(other => ["input", "secret", "group"].includes(other.kind));
    const code = authored || group;
    result[id] = { code, display: true, ...(code ? { codeName: resource!.path.at(-1)! } : { reason: id.startsWith("island:vpc:") ? "The VPC's code identity is owned by its network declaration. This edits its shared authored name." : id.startsWith("route:") ? "The public path is owned by the route editor. Caller references require a separate review." : "The code identity is owned by its declaration. Rename its Studio display label here; changing code identity requires compatibility checks." }) };
  }
  return result;
}
