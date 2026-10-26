import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT_ENV_STACK_OUTPUTS } from "../../scripts/root-env-outputs";
import { CLIENT_ENVIRONMENT_FILE, clientMappingsError, type ClientEnvironmentMappings } from "../shared/client-environment";
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
    ...(resource.kind === "secret" && resource.fromEnv ? [resource.fromEnv] : []),
    ...(resource.deploymentFile?.entries.filter((entry) => entry.sensitive).map((entry) => entry.name) ?? []),
  ])));
  for (const model of models) for (const resource of model.resources) if (resource.stackClass && resource.stackOutputs) {
    const names = publicOutputs.get(resource.stackClass) ?? new Set<string>();
    resource.stackOutputs.forEach((output) => names.add(output.name));
    publicOutputs.set(resource.stackClass, names);
  }
  for (const [name, modes] of Object.entries(value as ClientEnvironmentMappings)) for (const binding of Object.values(modes)) {
    const inputs = [...(binding.kind === "input" ? [binding.name] : binding.kind === "endpoint" ? [binding.port, ...(binding.override ? [binding.override] : [])] : []), ...(binding.when ? [binding.when.input] : [])];
    if (inputs.some((input) => sensitive.has(input))) throw new Error(`${name}: secret inputs cannot be mapped into the client.`);
    if (inputs.some(input => !models.some(model => model.resources.some(resource => resource.kind === "input" && resource.fromEnv === input)))) throw new Error(`${name}: select a declared public input parameter.`);
    if (binding.kind === "output" && binding.outputs.some((output) => !publicOutputs.get(binding.stack)?.has(output))) throw new Error(`${name}: select a public stack output shown in Studio.`);
    if (binding.kind === "region" && !publicOutputs.has(binding.stack) && !models.some((model) => model.resources.some((resource) => resource.kind === "stack" && resource.stackClass === binding.stack))) throw new Error(`${name}: select a stack shown in Studio.`);
  }
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
      edits.push({ start: property.initializer.getStart(source), end: property.initializer.end, value: JSON.stringify(mappings[nextName], null, 2).replaceAll("\n", "\n  ") });
    }
  }
  const renamed = new Set(renames.values());
  const added = Object.entries(mappings).filter(([name]) => !Object.hasOwn(before, name) && !renamed.has(name));
  if (added.length) {
    const last = object.properties.filter((property) => { const key = literalKey(property)!; return Object.hasOwn(mappings, renames.get(key) ?? key); }).at(-1);
    if (last && text[last.end] !== ",") edits.push({ start: last.end, end: last.end, value: "," });
    edits.push({ start: object.end - 1, end: object.end - 1, value: added.map(([name, modes]) => `  ${JSON.stringify(name)}: ${JSON.stringify(modes, null, 2).replaceAll("\n", "\n  ")},\n`).join("") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  if (JSON.stringify(parseClientMappings(text).mappings) !== JSON.stringify(mappings)) throw new Error("Client mappings did not round trip. Review the mapping source.");
  return text;
}
