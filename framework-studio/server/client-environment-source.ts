import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT_ENV_STACK_OUTPUTS } from "../../scripts/root-env-outputs";
import { CLIENT_ENVIRONMENT_FILE, clientBindingFor, clientMappingsError, publicInputName, type ClientEnvironmentMapping, type ClientEnvironmentMappings } from "../shared/client-environment";
import type { ModeModel } from "../shared/model";
import { literalKey } from "./source/syntax";
import { parseClientMappings } from "../../scripts/client-environment-source";
export { parseClientMappings } from "../../scripts/client-environment-source";

export function readClientMappings(root: string): { mappings: ClientEnvironmentMappings; problem?: string } {
  try { return { mappings: parseClientMappings(readFileSync(path.join(root, CLIENT_ENVIRONMENT_FILE), "utf8")).mappings }; }
  catch (error) { return { mappings: {}, problem: error instanceof Error ? error.message : String(error) }; }
}

export function validateClientMappings(value: unknown, models: readonly ModeModel[]): asserts value is ClientEnvironmentMappings {
  const error = clientMappingsError(value);
  if (error) throw new Error(error);
  const publicOutputs = new Map<string, Set<string>>(Object.entries(ROOT_ENV_STACK_OUTPUTS).map(([stack, outputs]) => [stack, new Set(Object.keys(outputs))]));
  const sensitive = new Set(models.flatMap((model) => model.resources.flatMap((resource) => [
    ...(resource.kind === "secret" ? [resource.id] : []),
    ...(resource.kind === "secret" && resource.fromEnv ? [resource.fromEnv] : []),
    ...(resource.deploymentFile?.entries.filter((entry) => entry.sensitive).map((entry) => entry.name) ?? []),
  ])));
  // A canonical alias must not bypass the policy on its environment-file source name.
  for (const model of models) for (const resource of model.resources) if (resource.fromEnv && (sensitive.has(resource.fromEnv) || !publicInputName(resource.fromEnv))) sensitive.add(resource.id);
  for (const model of models) for (const resource of model.resources) if (resource.stackClass && resource.stackOutputs) {
    const names = publicOutputs.get(resource.stackClass) ?? new Set<string>();
    resource.stackOutputs.forEach((output) => names.add(output.name));
    publicOutputs.set(resource.stackClass, names);
  }
  for (const [name, mapping] of Object.entries(value as ClientEnvironmentMappings)) for (const binding of new Set([clientBindingFor(mapping, "dev"), clientBindingFor(mapping, "prod")])) {
    const inputs = [...(binding.kind === "input" ? [binding.name] : binding.kind === "endpoint" ? [binding.port, ...(binding.override ? [binding.override] : [])] : []), ...(binding.when ? [binding.when.input] : [])];
    if (inputs.some((input) => sensitive.has(input))) throw new Error(`${name}: secret inputs cannot be mapped into the client.`);
    if (inputs.some(input => !models.some(model => model.resources.some(resource => resource.kind === "input" && (resource.fromEnv === input || resource.id === input))))) throw new Error(`${name}: select a declared public input parameter.`);
    if (binding.kind === "output" && binding.outputs.some((output) => !publicOutputs.get(binding.stack)?.has(output))) throw new Error(`${name}: select a public stack output shown in Studio.`);
    if (binding.kind === "region" && !publicOutputs.has(binding.stack) && !models.some((model) => model.resources.some((resource) => resource.kind === "stack" && resource.stackClass === binding.stack))) throw new Error(`${name}: select a stack shown in Studio.`);
  }
}

/** A mapping as the file's author would write it: unquoted keys, one line when it fits, nested per environment. */
function mappingSource(mapping: ClientEnvironmentMapping, indent = "  "): string {
  const value = (item: unknown, depth: string): string => {
    if (Array.isArray(item)) return `[${item.map((entry) => value(entry, depth)).join(", ")}]`;
    if (item && typeof item === "object") {
      const entries = Object.entries(item).map(([key, entry]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${value(entry, `${depth}  `)}`);
      const inline = `{ ${entries.join(", ")} }`;
      return inline.length + depth.length <= 120 && !inline.includes("\n") ? inline : `{\n${entries.map((entry) => `${depth}  ${entry},`).join("\n")}\n${depth}}`;
    }
    return JSON.stringify(item);
  };
  return value(mapping, indent);
}

/** Replace changed fields only so comments and untouched mappings retain their source. */
export function rewriteClientMappings(text: string, mappings: ClientEnvironmentMappings): string {
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  const { source, object, mappings: before } = parseClientMappings(text);
  // Inline renames retain position and comments, even when this draft also adds
  // or removes fields. Surviving names anchor the gaps where keys can change.
  const oldKeys = Object.keys(before), newKeys = Object.keys(mappings);
  const renames = new Map<string, string>();
  for (const [at, name] of newKeys.entries()) {
    if (Object.hasOwn(before, name)) continue;
    const previous = newKeys.slice(0, at).reverse().find((key) => Object.hasOwn(before, key));
    const next = newKeys.slice(at + 1).find((key) => Object.hasOwn(before, key));
    const candidates = oldKeys.slice(previous ? oldKeys.indexOf(previous) + 1 : 0, next ? oldKeys.indexOf(next) : undefined)
      .filter((key) => !Object.hasOwn(mappings, key) && !renames.has(key));
    const original = candidates.find((key) => JSON.stringify(before[key]) === JSON.stringify(mappings[name])) ?? candidates[0];
    if (original) renames.set(original, name);
  }
  const edits: { start: number; end: number; value: string }[] = [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = literalKey(property)!;
    const nextName = renames.get(name) ?? name;
    if (nextName !== name) edits.push({ start: property.name.getStart(source), end: property.name.end, value: nextName });
    if (!Object.hasOwn(mappings, nextName)) {
      let end = property.end;
      if (text[end] === ",") end++;
      edits.push({ start: property.getStart(source), end, value: "" });
    } else if (JSON.stringify(before[name]) !== JSON.stringify(mappings[nextName])) {
      edits.push({ start: property.initializer.getStart(source), end: property.initializer.end, value: mappingSource(mappings[nextName]!) });
    }
  }
  const renamed = new Set(renames.values());
  const added = Object.entries(mappings).filter(([name]) => !Object.hasOwn(before, name) && !renamed.has(name));
  if (added.length) {
    const last = object.properties.filter((property) => { const key = literalKey(property)!; return Object.hasOwn(mappings, renames.get(key) ?? key); }).at(-1);
    if (last && text[last.end] !== ",") edits.push({ start: last.end, end: last.end, value: "," });
    edits.push({ start: object.end - 1, end: object.end - 1, value: added.map(([name, mapping]) => `  ${name}: ${mappingSource(mapping)},\n`).join("") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  if (JSON.stringify(parseClientMappings(text).mappings) !== JSON.stringify(mappings)) throw new Error("Client mappings did not round trip. Review the mapping source.");
  return text;
}
