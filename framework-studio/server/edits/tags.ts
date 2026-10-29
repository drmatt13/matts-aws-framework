import ts from "typescript";
import { validateTags } from "@repo/framework/config";
import type { ModeModel } from "../../shared/model";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { SourceFiles } from "../source";
import { locateTagSites, readTagSite, tagEditability, type TagSite } from "../source/tags";
import { findProperty, hasComments, parse, propertyAt } from "../source/syntax";
import { removeProperty, replaceValue } from "./splice";
import { EditError } from "./io";

function rewrite(site: TagSite, tags: Readonly<Record<string, string>>, text: string, envName?: string): string {
  const current = readTagSite(site);
  if (!current.object) {
    if (!Object.keys(tags).length) return text;
    if (site.object) {
      const position = propertyAt(site.object, site.segments);
      if (position.editability.kind !== "absent") throw new Error("Tag metadata is computed or ambiguous. Edit its owning expression in source.");
      return insertExpression(text, site.source, position.container, position.missing, JSON.stringify(tags));
    }
    const expression = site.segments.reduceRight((value, segment) => `{ ${JSON.stringify(segment)}: ${value} }`, JSON.stringify(tags));
    const call = site.call!;
    const at = call.end - 1;
    if (site.argumentIndex === 1 && !call.arguments.length && !envName) throw new Error("This input's environment name cannot be determined. Make it explicit in source first.");
    const separator = call.arguments.length ? call.arguments.hasTrailingComma ? " " : ", " : "";
    return text.slice(0, at) + `${separator}${site.argumentIndex === 1 && !call.arguments.length ? `${JSON.stringify(envName)}, ` : ""}${expression}` + text.slice(at);
  }
  // Only tag-map spans change. Unrelated comments and shared fragments survive.
  const object = current.object;
  let map = object.getText(site.source);
  if ((Object.keys(current.value).some(key => !Object.hasOwn(tags, key)) || (!object.properties.length && Object.keys(tags).length)) && hasComments(map)) throw new Error("This tag map contains comments. Add or remove tags in source so those comments are preserved deliberately.");
  const prefix = "const tags = ";
  const parsed = () => {
    const source = parse("tags.ts", `${prefix}${map};`);
    const statement = source.statements[0] as ts.VariableStatement;
    return { source, object: statement.declarationList.declarations[0]!.initializer as ts.ObjectLiteralExpression };
  };
  for (const key of Object.keys(current.value)) {
    const { source, object } = parsed();
    const property = findProperty(object, key).property as ts.PropertyAssignment;
    const whole = `${prefix}${map};`;
    const next = Object.hasOwn(tags, key) ? replaceValue(whole, source, property, tags[key]!) : removeProperty(whole, source, object, property);
    map = next.slice(prefix.length, -1);
  }
  for (const key of Object.keys(tags).filter(key => !Object.hasOwn(current.value, key)).sort()) {
    const { source, object } = parsed();
    const next = insertExpression(`${prefix}${map};`, source, object, [key], JSON.stringify(tags[key]));
    map = next.slice(prefix.length, -1);
  }
  return text.slice(0, object.getStart(site.source)) + map + text.slice(object.end);
}

export function planTags(root: string, model: ModeModel, entity: string, raw: unknown, overrides: Map<string, string>): void {
  try {
    entity = tagOwner(model, entity);
    const tags = validateTags(raw, `${entity}.tags`);
    if (!model.tagging?.[entity]) throw new Error("Select an authored resource or workload to edit its tags.");
    const editable = tagEditability(root, model, new SourceFiles(overrides), entity);
    if (editable.kind !== "literal" && editable.kind !== "absent") throw new Error(editable.kind === "unsupported" ? editable.reason : "Tags are computed or ambiguous. Edit the owning expression in source.");
    const count = locateTagSites(root, model, new SourceFiles(overrides), entity).length;
    for (let index = 0; index < count; index++) {
      const files = new SourceFiles(overrides);
      const site = locateTagSites(root, model, files, entity)[index]!;
      const file = assertWritable(root, toRelative(root, site.file));
      overrides.set(file, rewrite(site, tags, files.text(file), model.resources.find(resource => resource.id === entity)?.fromEnv));
    }
  } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
}

export function tagOwner(model: ModeModel, entity: string): string {
  return model.routes.find(route => route.id === entity)?.target ?? entity;
}

export function tagSignature(model: ModeModel): string {
  // The source index discovers additional public stack members after evaluation.
  // Inherited-only members are derived from their owner; they are not another
  // authored declaration to compare against the evaluator's preflight result.
  // An absent catalog placeholder borrows the other graph's tags; a framework
  // stack's come straight from framework.config.ts in both.
  return JSON.stringify(Object.entries(model.tagging ?? {}).filter(([entity, facts]) => Object.keys(facts.authored).length && !model.resources.some(resource => resource.id === entity && resource.absent && !resource.frameworkStack)).map(([entity, facts]) => [entity, facts.authored, facts.effective]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

export function tagDifferences(actual: ModeModel, expected: ModeModel): string {
  const entries = (model: ModeModel): Map<string, unknown> => new Map((JSON.parse(tagSignature(model)) as [string, unknown, unknown][]).map(([entity, authored, effective]) => [entity, { authored, effective }]));
  const left = entries(actual), right = entries(expected);
  return [...new Set([...left.keys(), ...right.keys()])].filter(entity => JSON.stringify(left.get(entity)) !== JSON.stringify(right.get(entity))).join(", ");
}
