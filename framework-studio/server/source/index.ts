import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  locateConfigSource,
  type ConfigSourceHost,
  type LocatedConfigSource,
  type LocatedSectionEntry,
} from "../../../packages/framework/scripts/config-source";
import type { CdkLinkIndex, Editability, EntitySource, FieldFact, ModeModel, SourceIndex, SourceLocation } from "../../shared/model";
import { fieldById } from "../edits/fields";
import { parseOrigin, type ParsedOrigin } from "../model/origin";
import { readCatalogSource, readLinkSites, type CatalogEntrySource } from "./catalog";
import { readConstructorSites, readStackUsage } from "./stack-usage";
import { readExportStacks, type ExportStackSource } from "./export-stacks";
import { scanCdkLinks } from "./cdk-links";
import { discoverCapabilities } from "./capabilities";
import { locateManagedDatabase } from "./database";
import { declarationObject, expressionAt, findProperty, lineAndColumn, literalValue, parse, propertyAt } from "./syntax";
import { tagEditability } from "./tags";

/**
 * Where every entity was written, and what the studio may change in it.
 *
 * Built on the framework's own locator (scripts/config-source.ts), which
 * follows framework.config.ts into each section module exactly as
 * `framework:check` does. Property-level answers come from the entry's object
 * literal, and every editable literal is checked against the value the
 * framework evaluated: if the source and the evaluated config disagree, the
 * studio does not trust its reading of the source and refuses to edit.
 */

export interface BuiltSourceIndex {
  readonly index: SourceIndex;
  readonly catalog: ReadonlyMap<string, CatalogEntrySource>;
  readonly exportStacks: readonly ExportStackSource[];
  readonly located?: LocatedConfigSource;
}

/** Parsed source files, read once per index (or from an overlay, when planning an edit). */
export class SourceFiles {
  private readonly parsed = new Map<string, ts.SourceFile>();
  constructor(private readonly overlay: ReadonlyMap<string, string> = new Map()) {}

  withText(file: string, text: string): SourceFiles {
    return new SourceFiles(new Map([...this.overlay, [path.resolve(file), text]]));
  }

  text(file: string): string {
    return this.overlay.get(path.resolve(file)) ?? readFileSync(file, "utf8");
  }

  get(file: string): ts.SourceFile {
    const key = path.resolve(file);
    let sourceFile = this.parsed.get(key);
    if (!sourceFile) {
      sourceFile = parse(file, this.text(file));
      this.parsed.set(key, sourceFile);
    }
    return sourceFile;
  }

  host(): ConfigSourceHost {
    return {
      readFile: (file) => this.text(file),
      exists: (file) => this.overlay.has(path.resolve(file)) || ts.sys.fileExists(file),
    };
  }
}

function relative(repositoryRoot: string, file: string): string {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function location(repositoryRoot: string, sourceFile: ts.SourceFile, start: number, end: number): SourceLocation {
  return { file: relative(repositoryRoot, sourceFile.fileName), ...lineAndColumn(sourceFile, start), start, end };
}

type LocatedDeclaration = Pick<LocatedSectionEntry, "file" | "key" | "keySpan" | "valueSpan">;

export function findEntry(located: LocatedConfigSource, origin: ParsedOrigin): LocatedDeclaration | undefined {
  if (origin.section === "defaults") {
    const property = located.properties.defaults;
    return property ? { file: property.file, key: "defaults", keySpan: property.span, valueSpan: property.span } : undefined;
  }
  return located.sections[origin.section].find((entry) => entry.key === origin.key);
}

/** The value expression of a located entry, parsed. */
export function entryValue(files: SourceFiles, entry: LocatedDeclaration): ts.Expression | undefined {
  return expressionAt(files.get(entry.file), entry.valueSpan.start, entry.valueSpan.end);
}

/** Where an origin was written: the entry itself, or a property below it. */
function locateOrigin(
  repositoryRoot: string,
  files: SourceFiles,
  located: LocatedConfigSource,
  origin: string,
): EntitySource | undefined {
  const parsed = parseOrigin(origin);
  if (!parsed) return undefined;
  const entry = findEntry(located, parsed);
  if (!entry) return undefined;
  const sourceFile = files.get(entry.file);
  let key = location(repositoryRoot, sourceFile, entry.keySpan.start, entry.keySpan.end);
  let value = location(repositoryRoot, sourceFile, entry.valueSpan.start, entry.valueSpan.end);
  let object = entryValue(files, entry);
  for (const link of parsed.chain) {
    const inner = object && ts.isObjectLiteralExpression(object) ? findProperty(object, link).property : undefined;
    if (!inner || !ts.isPropertyAssignment(inner)) break;
    key = location(repositoryRoot, sourceFile, inner.name.getStart(sourceFile), inner.name.end);
    value = location(repositoryRoot, sourceFile, inner.initializer.getStart(sourceFile), inner.initializer.end);
    object = inner.initializer;
  }
  return { origin, key, value };
}

function sameValue(source: string | number | boolean, evaluated: FieldFact["authored"]): boolean {
  return evaluated !== undefined && evaluated !== null && source === evaluated;
}

/** What the source allows for one field of one target, cross-checked against the evaluated value. */
export function fieldEditability(
  files: SourceFiles,
  located: LocatedConfigSource,
  origin: string,
  fact: FieldFact,
): Editability {
  if (fact.blocked) return { kind: "unsupported", reason: fact.blocked };
  const definition = fieldById(fact.field);
  if (!definition) {
    return { kind: "unsupported", reason: `This Studio server has not loaded the edit control for ${fact.field}. Restart Studio to load updated settings.` };
  }
  const parsed = parseOrigin(origin);
  const entry = parsed ? findEntry(located, parsed) : undefined;
  const value = entry ? entryValue(files, entry) : undefined;
  if (!parsed || !entry || !value) {
    return { kind: "unsupported", reason: `${origin} could not be found in source.` };
  }
  const declaration = declarationObject(value, parsed.section, parsed.chain);
  if ("unsupported" in declaration) return { kind: "unsupported", reason: declaration.unsupported };
  const position = propertyAt(declaration.object, definition.path);
  const editability = position.editability;
  if (editability.kind === "literal") {
    const written = position.property ? literalValue(position.property.initializer) : undefined;
    if (!written || !sameValue(written.value, fact.authored)) {
      return {
        kind: "unsupported",
        reason: `The source writes ${editability.text}, but the evaluated config holds ${JSON.stringify(fact.authored)}. Something between them changes it, so the studio leaves it alone.`,
      };
    }
  }
  if (editability.kind === "absent" && fact.authored !== undefined) {
    return {
      kind: "unsupported",
      reason: `The source does not write ${definition.path.join(".")}, but the evaluated config holds ${JSON.stringify(fact.authored)}.`,
    };
  }
  return editability;
}

/** The source index for one evaluated model. */
export function buildSourceIndex(
  repositoryRoot: string,
  model: ModeModel,
  files: SourceFiles = new SourceFiles(),
): BuiltSourceIndex {
  const problems: string[] = [];
  const entities: Record<string, EntitySource> = {};
  const editability: Record<string, Record<string, Editability>> = {};
  const catalogFacts: Record<string, { condition?: string; stackClass?: string; stackLocation?: SourceLocation }> = {};
  let located: LocatedConfigSource | undefined;
  try {
    located = locateConfigSource(path.join(repositoryRoot, "framework.config.ts"), { repositoryRoot, host: files.host() });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (located) {
    const database = locateManagedDatabase(repositoryRoot, files);
    if (database) {
      const at = { file: relative(repositoryRoot, database.file), line: database.line, column: database.column, start: database.span.start, end: database.span.end };
      entities[`database:${database.id}`] = { origin: `database.${database.id}`, key: at, value: at };
    }
    for (const network of located.networks) {
      const at = { file: relative(repositoryRoot, network.file), line: network.line, column: network.column, start: network.span.start, end: network.span.end };
      entities[`island:vpc:${network.id}`] = { origin: `networks.${network.id}`, key: at, value: at };
    }
    for (const target of model.targets) {
      const origin = target.origins[0];
      const source = origin ? locateOrigin(repositoryRoot, files, located, origin) : undefined;
      if (source) entities[target.ref] = source;
      else problems.push(`${target.ref} (${origin ?? "no origin"}) was not found in source.`);
      editability[target.ref] = Object.fromEntries(
        (model.fields[target.ref] ?? []).map((fact) => [
          fact.field,
          origin ? fieldEditability(files, located!, origin, fact) : { kind: "unsupported", reason: "No declaration origin." },
        ]),
      );
    }
    for (const route of model.routes) {
      const source = locateOrigin(repositoryRoot, files, located, route.origin);
      if (source) entities[route.id] = source;
    }
    for (const group of model.defaults ?? []) {
      const source = locateOrigin(repositoryRoot, files, located, group.origin);
      if (source) entities[group.ref] = source;
      editability[group.ref] = Object.fromEntries((model.fields[group.ref] ?? []).map((fact) => [fact.field, fieldEditability(files, located!, group.origin, fact)]));
    }
  }

  let catalog = new Map<string, CatalogEntrySource>();
  const resources = located?.properties.resources;
  if (resources) {
    try {
      catalog = readCatalogSource(repositoryRoot, resources.file, resources.span, (file) => files.text(file));
    } catch (error) {
      problems.push(`The resource catalog could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let triggerCapabilities: SourceIndex["triggerCapabilities"] = [];
  let capabilityFiles: SourceIndex["capabilityFiles"] = {};
  if ([...catalog.values()].some((entry) => entry.stack)) {
    try {
      const discovered = discoverCapabilities(repositoryRoot, catalog, model.triggerAdapters ?? []);
      catalog = new Map(discovered.catalog);
      triggerCapabilities = discovered.capabilities;
      capabilityFiles = discovered.files;
    } catch (error) { problems.push(`Trigger capabilities could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // One walk of the CDK app's imports answers both the catalog and the export stacks.
  const sites = readConstructorSites(repositoryRoot);
  const stackUsage = readStackUsage(repositoryRoot, catalog, sites);
  for (const [key, entry] of catalog) catalog.set(key, { ...entry, stackUsage: entry.stackUsage ?? stackUsage.get(key) });
  for (const [catalogPath, entry] of catalog) {
    const id = `resource:${catalogPath}`;
    entities[id] = { origin: `resources.${catalogPath}`, key: entry.key, value: entry.value };
    catalogFacts[id] = {
      ...(entry.condition ? { condition: entry.condition } : {}),
      ...(entry.stack ? { stackClass: entry.stack.className } : {}),
      ...(entry.stack?.location ? { stackLocation: entry.stack.location } : {}),
    };
    for (const member of entry.stack?.members ?? []) {
      entities[`resource:${catalogPath}.${member.name}`] = {
        origin: `${entry.stack!.className}.${member.name}`,
        key: member.location,
        value: member.location,
      };
    }
  }

  let exportStacks: readonly ExportStackSource[] = [];
  try {
    exportStacks = readExportStacks(repositoryRoot, sites);
    for (const stack of exportStacks) {
      const entry = [...catalog].find(([, item]) => item.stack?.className === stack.className);
      const id = entry ? `resource:${entry[0]}` : `framework-stack:${stack.className}`;
      entities[id] ??= { origin: stack.className, key: stack.location, value: stack.location };
      catalogFacts[id] ??= { stackClass: stack.className, stackLocation: stack.location };
    }
  } catch (error) { problems.push(`Root environment export stacks could not be read: ${error instanceof Error ? error.message : String(error)}`); }

  let links: Record<string, SourceLocation[]> = {};
  try {
    links = Object.fromEntries(readLinkSites(repositoryRoot));
  } catch (error) {
    problems.push(`Application CDK could not be scanned for linkResources: ${error instanceof Error ? error.message : String(error)}`);
  }

  let cdkLinks: CdkLinkIndex = { version: 2, files: {}, edges: [], notes: [], manualWiring: [] };
  try {
    cdkLinks = scanCdkLinks(repositoryRoot, catalog, links);
  } catch (error) {
    problems.push(`CDK resource links could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const taggedEntities = new Set(Object.keys(model.tagging ?? {}));
  for (const [key, entry] of catalog) {
    taggedEntities.add(`resource:${key}`);
    for (const member of entry.stack?.members ?? []) taggedEntities.add(`resource:${key}.${member.name}`);
  }
  const tagSources = located ? { located, catalog } : undefined;
  for (const entity of taggedEntities) editability[entity] = { ...editability[entity], tags: tagEditability(repositoryRoot, model, files, entity, tagSources) };
  return {
    index: { entities, editability, links, catalog: catalogFacts, problems, cdkLinks, triggerCapabilities, capabilityFiles },
    catalog,
    exportStacks,
    ...(located ? { located } : {}),
  };
}
