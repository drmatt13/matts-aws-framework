import ts from "typescript";
import path from "node:path";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import { databaseConsumers, readDatabaseDraft, readDatabasePlacementDraft, type DatabaseEdit, type DatabasePlacementEdit } from "../../shared/managed-database";
import type { StudioState } from "../snapshot";
import { SourceFiles } from "../source";
import { locateManagedDatabase } from "../source/database";
import { findProperty, hasComments, literalKey, literalValue, unwrap } from "../source/syntax";
import { assertWritable, toRelative } from "../files";
import { setProperty } from "./creation";
import { removeProperty } from "./splice";
import { EditError } from "./io";
import { importedVpc } from "../source/networks";
import { importVpc, planPlacement, pruneUnusedVpcImports } from "./networks";

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
  if (!located || located.id !== id) throw new EditError(422, "The database must be an imported, exported defineDatabase declaration inside framework-config. Make its settings literal in source before editing them.");
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
      if (hasComments(property.initializer.getText(located.source))) throw new EditError(422, `Database settings.${key} contains a source comment. Edit that setting in source to preserve the comment deliberately.`);
    }
    if (!Object.hasOwn(desired, key)) {
      if (property) text = removeProperty(text, located.source, current, property);
    } else text = setProperty(file, text, current, located.source, key, JSON.stringify(desired[key]));
  }
  return { file, after: text };
}

/** Coordinate declaration placement with every framework consumer. This never copies data or deploys. */
export function planDatabasePlacement(root: string, state: StudioState, raw: DatabasePlacementEdit, overrides: Map<string, string>): readonly string[] {
  const edit = readDatabasePlacementDraft(raw);
  const models = Object.values(state.snapshot.models);
  const known = models.flatMap(model => model.managedDatabase?.id === edit.database ? [model.managedDatabase] : []);
  const database = known[0];
  if (!database) throw new EditError(404, "Unknown managed database declaration.");
  if (known.length !== models.length || known.some(item => item.networkId !== database.networkId || item.subnet !== database.subnet || item.resource !== database.resource)) throw new EditError(422, "Database placement differs between environments. Reconcile its declaration in source before using coordinated placement.");
  if (known.some(item => item.consumers === undefined)) throw new EditError(422, "The database consumer index is unavailable. Restart Studio and review again.");
  if (models.some(model => !model.networks?.some(network => network.id === edit.vpc))) throw new EditError(422, "Select a VPC registered in both deployment graphs.");
  let files = new SourceFiles(overrides);
  let located = locateManagedDatabase(root, files);
  if (!located || located.id !== edit.database) throw new EditError(422, "Placement requires an imported, literal defineDatabase declaration. Edit computed placement in source.");
  const file = assertWritable(root, toRelative(root, located.file));
  const seen = new Set<string>();
  for (const property of located.object.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || key === undefined || seen.has(key)) throw new EditError(422, "Database declaration properties must be unique, explicit assignments before changing placement.");
    seen.add(key);
  }
  let registry = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const vpc = findProperty(located.object, "vpc").property;
  const subnet = findProperty(located.object, "subnet").property;
  if (!vpc || !ts.isPropertyAssignment(vpc) || importedVpc(file, located.source, vpc.initializer, registry) !== database.networkId || (subnet && (!ts.isPropertyAssignment(subnet) || !ts.isStringLiteral(unwrap(subnet.initializer)) || (unwrap(subnet.initializer) as ts.StringLiteral).text !== database.subnet))) throw new EditError(422, "The database placement is computed or changed since the snapshot. Refresh Studio or edit it in source.");
  for (const property of [vpc, subnet]) if (property && ts.isPropertyAssignment(property)) {
    if (hasComments(property.initializer.getText(located.source))) throw new EditError(422, "Database placement contains a source comment. Edit it in source to preserve that comment deliberately.");
  }
  let text = files.text(file);
  const imported = importVpc(file, text, edit.vpc, registry);
  text = imported.text;
  for (const [key, expression] of [["vpc", imported.symbol], ["subnet", JSON.stringify(edit.subnet)]] as const) {
    files = files.withText(file, text);
    located = locateManagedDatabase(root, files)!;
    const property = findProperty(located.object, key).property;
    if (property && ts.isPropertyAssignment(property)) text = text.slice(0, property.initializer.getStart(located.source)) + expression + text.slice(property.initializer.end);
    else text = setProperty(file, text, located.object, located.source, key, expression);
  }
  overrides.set(file, text);
  const affected = new Set([file]);
  const moved: string[] = [];
  if (edit.vpc !== database.networkId) for (const consumer of databaseConsumers(models, database.id)) {
    const targets = models.flatMap(model => model.targets.filter(target => target.ref === consumer.target));
    const target = targets[0];
    if (!target || target.placement.kind !== "vpc" || targets.some(item => item.placement.kind !== "vpc" || item.placement.subnet !== (target.placement as { subnet: string }).subnet)) throw new EditError(422, `The placement of ${consumer.target} differs between environments. Reconcile it in source before moving the database.`);
    const before = new Map(overrides);
    planPlacement(root, state, { target: target.ref, vpc: edit.vpc, subnet: target.placement.subnet }, overrides);
    for (const [changed, value] of overrides) if (before.get(changed) !== value) affected.add(changed);
    moved.push(target.ref);
  }
  files = new SourceFiles(overrides);
  registry = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  for (const changed of affected) overrides.set(changed, pruneUnusedVpcImports(changed, overrides.get(changed)!, registry));
  return moved;
}
