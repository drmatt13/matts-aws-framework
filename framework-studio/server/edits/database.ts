import ts from "typescript";
import { readDatabaseDraft, type DatabaseEdit } from "../../shared/managed-database";
import type { StudioState } from "../snapshot";
import type { SourceFiles } from "../source";
import { locateManagedDatabase } from "../source/database";
import { findProperty, literalKey, literalValue, unwrap } from "../source/syntax";
import { assertWritable, toRelative } from "../files";
import { setProperty } from "./creation";
import { removeProperty } from "./splice";
import { EditError } from "./io";

function literalSettings(object: ts.ObjectLiteralExpression): Record<string, unknown> {
  const settings: Record<string, unknown> = Object.create(null);
  for (const property of object.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || key === undefined || Object.hasOwn(settings, key)) throw new EditError(422, "Database settings use a spread, computed key or duplicate. Make each option a literal in source before editing it.");
    const value = unwrap(property.initializer);
    if (ts.isArrayLiteralExpression(value)) {
      if (value.elements.some(element => !ts.isStringLiteral(element))) throw new EditError(422, `Database settings.${key} is computed. Make it a literal in source before editing it.`);
      settings[key] = value.elements.map(element => (element as ts.StringLiteral).text);
    } else {
      const literal = literalValue(value);
      if (!literal) throw new EditError(422, `Database settings.${key} is computed. Make it a literal in source before editing it.`);
      settings[key] = literal.value;
    }
  }
  return settings;
}

/** Write declared defaults only; native stack/construct identities stay untouched. */
export function planDatabaseSettings(root: string, state: StudioState, id: string, settings: DatabaseEdit["settings"], files: SourceFiles): { file: string; after: string } {
  const edit = readDatabaseDraft({ kind: "database", database: id, settings });
  const models = Object.values(state.snapshot.models) as readonly { readonly managedDatabase?: { readonly id: string; readonly authored: DatabaseEdit["settings"] } }[];
  const known = models.flatMap(model => model.managedDatabase?.id === id ? [model.managedDatabase] : []);
  if (!known.length) throw new EditError(404, "Unknown managed database declaration.");
  let located = locateManagedDatabase(root, files);
  if (!located || located.id !== id) throw new EditError(422, "The database must be an imported, exported defineDatabase declaration at framework-config/databases/<id>/index.ts. Make its settings literal in source before editing them.");
  const file = assertWritable(root, toRelative(root, located.file));
  let text = files.text(file);
  const settingProperty = findProperty(located.object, "settings");
  if (settingProperty.spread || (settingProperty.property && !ts.isPropertyAssignment(settingProperty.property))) throw new EditError(422, "Database settings are computed. Make them a literal object in source before editing them.");
  const existing = settingProperty.property && ts.isPropertyAssignment(settingProperty.property) ? unwrap(settingProperty.property.initializer) : undefined;
  if (existing && !ts.isObjectLiteralExpression(existing)) throw new EditError(422, "Database settings are computed. Make them a literal object in source before editing them.");
  const authored = existing ? literalSettings(existing as ts.ObjectLiteralExpression) : {};
  for (const model of known) {
    const keys = [...new Set([...Object.keys(authored), ...Object.keys(model.authored)])].sort();
    if (keys.some(key => JSON.stringify(authored[key]) !== JSON.stringify(model.authored[key as keyof typeof model.authored]))) throw new EditError(409, "The database declaration changed since this snapshot. Refresh Studio before editing it.");
  }
  const desired = edit.settings as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(authored), ...Object.keys(desired)])];
  for (const key of keys) {
    if (JSON.stringify(authored[key]) === JSON.stringify(desired[key])) continue;
    located = locateManagedDatabase(root, files.withText(file, text));
    if (!located) throw new EditError(422, "The database declaration cannot be located after editing.");
    const found = findProperty(located.object, "settings");
    const current = found.property && ts.isPropertyAssignment(found.property) ? unwrap(found.property.initializer) : undefined;
    if (!current) {
      text = setProperty(file, text, located.object, located.source, "settings", JSON.stringify(edit.settings));
      break;
    }
    if (!ts.isObjectLiteralExpression(current)) throw new EditError(422, "Database settings are computed. Edit them in source.");
    const property = findProperty(current, key).property;
    if (property && ts.isPropertyAssignment(property)) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, property.initializer.getText(located.source));
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) throw new EditError(422, `Database settings.${key} contains a source comment. Edit that setting in source to preserve the comment deliberately.`);
      }
    }
    if (!Object.hasOwn(desired, key)) {
      if (property) text = removeProperty(text, located.source, current, property);
    } else text = setProperty(file, text, current, located.source, key, JSON.stringify(desired[key]));
  }
  return { file, after: text };
}
