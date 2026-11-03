import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DESCRIPTION_FILE, descriptionError } from "../shared/descriptions";
import { insertProperty } from "./edits/splice";
import { parseStringMap } from "./source/string-map";

/** Parse literals only: documentation never executes as part of Studio or a deployment. */
export function parseDescriptions(text: string) {
  const { source, object, values, properties } = parseStringMap(text, {
    file: DESCRIPTION_FILE, exportName: "descriptions", label: "Description", validate: descriptionError,
  });
  return { source, object, values, properties };
}

export function readDescriptions(root: string): { readonly values: Readonly<Record<string, string>>; readonly problem?: string } {
  const file = path.join(root, DESCRIPTION_FILE);
  try {
    if (!existsSync(file)) return { values: {}, problem: `Create ${DESCRIPTION_FILE} with export const descriptions = {}; to enable descriptions.` };
    return { values: parseDescriptions(readFileSync(file, "utf8")).values };
  } catch (error) { return { values: {}, problem: error instanceof Error ? error.message : String(error) }; }
}

export function rewriteDescription(text: string, entity: string, value: string): string {
  const error = descriptionError(value);
  if (error) throw new Error(error);
  const { source, object, properties } = parseDescriptions(text);
  const property = properties.get(entity);
  // JSON encoding handles quotes, tabs, newlines and control characters without code interpolation.
  const after = !property && object.properties.length === 0
    ? text.slice(0, object.end - 1) + `\n  ${JSON.stringify(entity)}: ${JSON.stringify(value)},\n` + text.slice(object.end - 1)
    : property
    ? text.slice(0, property.initializer.getStart(source)) + JSON.stringify(value) + text.slice(property.initializer.end)
    : insertProperty(text, source, object, [entity], "", { after: [], before: [] });
  if (!property && object.properties.length > 0) return rewriteDescription(after, entity, value);
  if (parseDescriptions(after).values[entity] !== value) throw new Error("The description did not round trip as a string literal.");
  return after;
}

/** Route keys move simultaneously so path swaps preserve each route's documentation. */
export function renameRouteDescriptions(text: string, routes: readonly { before: string; after: string }[]): string {
  const { source, properties } = parseDescriptions(text);
  const moves = routes.filter((route) => route.before !== route.after).map((route) => ({ before: `route:http:${route.before}`, after: `route:http:${route.after}` }));
  const edits = moves.flatMap((move) => {
    const property = properties.get(move.before);
    if (!property) return [];
    if (properties.has(move.after) && !moves.some((other) => other.before === move.after)) throw new Error(`A description already exists for ${move.after}. Resolve it in ${DESCRIPTION_FILE} before renaming this route.`);
    return [{ start: property.name.getStart(source), end: property.name.end, value: JSON.stringify(move.after) }];
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  parseDescriptions(text);
  return text;
}
