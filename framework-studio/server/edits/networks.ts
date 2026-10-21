import { importedVpc } from "../source/networks";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import ts from "typescript";
import { defineNetwork, type InterfaceEndpointService } from "@repo/framework/config";
import { locateConfigSource, type LocatedConfigSource } from "../../../packages/framework/scripts/config-source";
import { networkCreationProblem, readCreationRequest } from "../../shared/creation";
import type { NetworkSettings, PlacementEdit } from "../../shared/networks";
import type { StudioState } from "../snapshot";
import { assertWritable, toRelative } from "../files";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, findProperty, parse, propertyAt } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { insertExpression } from "../resources-source";
import { removeProperty } from "./splice";
import { assertCreationFile, objectCall, setProperty } from "./creation";
import { EditError } from "./io";
import { DESCRIPTION_FILE } from "../../shared/descriptions";
import { parseDescriptions } from "../descriptions";

function registered(root: string, files: SourceFiles): LocatedConfigSource {
  return locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
}


export function importVpc(file: string, text: string, id: string, located: LocatedConfigSource): { text: string; symbol: string } {
  const network = located.networks.find(network => network.id === id);
  if (!network) throw new EditError(422, "Select a registered VPC with an exported source declaration.");
  const source = parse(file, text);
  const identifiers = new Set<string>();
  const scan = (node: ts.Node): void => { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, scan); };
  scan(source);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) if (importedVpc("", file, source, binding.name, located) === id) return { text, symbol: binding.name.text };
  }
  let symbol = `${id.split("-").map((part, i) => i ? part[0]!.toUpperCase() + part.slice(1) : part).join("")}Vpc`;
  const base = symbol;
  for (let suffix = 2; identifiers.has(symbol); suffix++) symbol = `${base}${suffix}`;
  let specifier = path.relative(path.dirname(file), network.file).replaceAll("\\", "/").replace(/\.ts$/, "").replace(/\/index$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return { text: `import { ${network.exportName} as ${symbol} } from ${JSON.stringify(specifier)};\n${text}`, symbol };
}

/** Remove only plain, now-unused VPC imports. Comments and shared imports remain source-owned. */
export function pruneUnusedVpcImports(root: string, file: string, text: string, located: LocatedConfigSource): string {
  const source = parse(file, text);
  const removals: { start: number; end: number }[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.name || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1) continue;
    const name = bindings.elements[0]!.name;
    if (!importedVpc(root, file, source, name, located)) continue;
    let used = false;
    const inspect = (node: ts.Node): void => {
      if (node === statement) return;
      if (ts.isIdentifier(node) && node.text === name.text) used = true;
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (used || (ts.getLeadingCommentRanges(text, statement.pos) ?? []).length || (ts.getTrailingCommentRanges(text, statement.end) ?? []).length || /\/\*|\/\//.test(statement.getText(source))) continue;
    removals.push({ start: statement.getStart(source), end: statement.end + (/^[ \t]*\r?\n/.exec(text.slice(statement.end))?.[0].length ?? 0) });
  }
  for (const removal of removals.reverse()) text = text.slice(0, removal.start) + text.slice(removal.end);
  return text;
}

export function planPlacement(root: string, state: StudioState, edit: PlacementEdit, overrides: Map<string, string>): void {
  const target = state.snapshot.models.dev.targets.find(target => target.ref === edit.target) ?? state.snapshot.models.prod.targets.find(target => target.ref === edit.target);
  if (!target || !["lambda", "service", "task"].includes(target.kind)) throw new EditError(422, "This target does not support VPC placement.");
  const lambda = target.kind === "lambda";
  if (lambda && target.compute.kind === "lambda" && target.compute.implementation !== "typescript") throw new EditError(422, "Only TypeScript Lambdas support VPC placement.");
  if (!(lambda ? ["none", "private", "isolated"] : ["public", "private"]).includes(edit.subnet) || (lambda ? (edit.subnet === "none") !== (edit.vpc === null) : !edit.vpc)) throw new EditError(422, "Select a compatible VPC and subnet together.");
  for (const origin of target.origins) {
    let files = new SourceFiles(overrides);
    let located = registered(root, files);
    const parsed = parseOrigin(origin);
    let entry = parsed && findEntry(located, parsed);
    if (!parsed || !entry) throw new EditError(422, "The workload declaration cannot be located.");
    const file = assertWritable(root, toRelative(root, entry.file));
    let text = files.text(file);
    let symbol: string | undefined;
    if (edit.vpc) { const imported = importVpc(file, text, edit.vpc, located); text = imported.text; symbol = imported.symbol; }
    // Reparse after import insertion and after each property edit so every offset remains current.
    for (const key of ["vpc", "subnet"] as const) {
      overrides.set(file, text); files = new SourceFiles(overrides); located = registered(root, files); entry = findEntry(located, parsed)!;
      const value = entryValue(files, entry);
      if (!value) throw new EditError(422, "The workload declaration cannot be read.");
      const declaration = declarationObject(value, parsed.section, parsed.chain);
      if ("unsupported" in declaration) throw new EditError(422, declaration.unsupported);
      const source = files.get(file);
      const keys = lambda ? [key] : ["cloud", key];
      const position = propertyAt(declaration.object, keys);
      const old = position.property;
      if (position.editability.kind === "spread") throw new EditError(422, "Placement uses an object spread. Make the placement explicit in source first.");
      if (position.editability.kind === "unsupported") throw new EditError(422, position.editability.reason);
      if (!old && position.editability.kind === "computed") throw new EditError(422, "Placement is computed. Make the VPC and subnet explicit in source first.");
      if (key === "vpc" && old && !importedVpc(root, file, source, old.initializer, located)) throw new EditError(422, "The current VPC is computed or cannot be resolved safely. Edit it in source.");
      const expression = key === "subnet" ? JSON.stringify(edit.subnet) : symbol;
      if (old) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, old.initializer.getText(source));
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) throw new EditError(422, "Placement contains a source comment. Edit it in source to preserve that comment deliberately.");
        if (expression === undefined) text = removeProperty(text, source, old.parent as ts.ObjectLiteralExpression, old);
        else if (key === "subnet" && !ts.isStringLiteral(old.initializer)) throw new EditError(422, "The subnet is computed. Edit it in source.");
        else text = text.slice(0, old.initializer.getStart(source)) + expression + text.slice(old.initializer.end);
      } else if (expression !== undefined) text = insertExpression(text, source, position.container, position.missing, expression);
    }
    overrides.set(file, text);
  }
}

export function planNetwork(root: string, state: StudioState, id: string, raw: NetworkSettings, files: SourceFiles): { file: string; after: string } {
  const network = state.snapshot.models.dev.networks?.find(network => network.id === id) ?? state.snapshot.models.prod.networks?.find(network => network.id === id);
  if (!network) throw new EditError(404, "Unknown VPC.");
  const request = readCreationRequest({ kind: "vpc", id, description: "", name: network.name ?? network.id, ...raw });
  if (request.kind !== "vpc") throw new EditError(422, "Invalid VPC settings.");
  const problem = networkCreationProblem(request, Object.values(state.snapshot.models).flatMap(model => model.networks ?? []), true);
  // Existing intentional overlaps remain editable when this change keeps the range.
  if (problem && request.cidr !== network.cidr) throw new EditError(422, `${problem.field}: ${problem.message}`);
  defineNetwork({ id, cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: { s3: request.s3, dynamodb: request.dynamodb }, interfaceEndpoints: request.endpoints as InterfaceEndpointService[] });
  const entry = registered(root, files).networks.find(network => network.id === id);
  if (!entry) throw new EditError(422, "The VPC source declaration cannot be located.");
  const file = assertWritable(root, toRelative(root, entry.file));
  let text = files.text(file);
  const settings = { name: request.name || id, cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, interfaceEndpoints: request.endpoints };
  const modes = Object.values(state.snapshot.models).flatMap(model => model.networks?.filter(network => network.id === id) ?? []);
  const unchanged = (key: keyof typeof settings, value: unknown) => modes.every(network => JSON.stringify(key === "name" ? network.name ?? network.id : network[key]) === JSON.stringify(value));
  for (const [key, value] of Object.entries(settings)) {
    if (unchanged(key as keyof typeof settings, value)) continue;
    const { source, object } = objectCall(file, text, "defineNetwork");
    text = setProperty(file, text, object, source, key, JSON.stringify(value));
  }
  for (const endpoint of ["s3", "dynamodb"] as const) {
    if (modes.every(network => network.gatewayEndpoints.includes(endpoint) === request[endpoint])) continue;
    const { source, object } = objectCall(file, text, "defineNetwork");
    const gateway = findProperty(object, "gatewayEndpoints");
    if (gateway.spread) throw new EditError(422, "Gateway endpoints use an object spread. Edit them in source.");
    if (gateway.property && ts.isPropertyAssignment(gateway.property)) {
      const value = gateway.property.initializer;
      if (!ts.isObjectLiteralExpression(value)) throw new EditError(422, "Gateway endpoints are computed. Edit them in source.");
      text = setProperty(file, text, value, source, endpoint, String(request[endpoint]));
    } else text = insertExpression(text, source, object, ["gatewayEndpoints", endpoint], String(request[endpoint]));
  }
  return { file, after: text };
}

function moduleMatches(file: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const absolute = path.resolve(path.dirname(file), specifier);
  return [absolute, `${absolute}.ts`, `${absolute}.tsx`, path.join(absolute, "index.ts")].includes(target);
}

/** The removal contract deliberately refuses arbitrary source surgery. Any
 * import, re-export or literal dynamic reference outside the registry means the
 * developer must move that consumer first, even if it is currently disabled. */
export function planNetworkRemoval(root: string, state: StudioState, id: string, files: SourceFiles): readonly { file: string; before: string; after: string | null }[] {
  const models = Object.values(state.snapshot.models);
  if (!models.some(model => model.networks?.some(network => network.id === id))) throw new EditError(404, "Unknown VPC.");
  const workloads = [...new Set(models.flatMap(model => model.targets.filter(target => target.placement.kind === "vpc" && target.placement.networkId === id).map(target => target.ref)))];
  if (workloads.length) throw new EditError(422, `VPC "${id}" is used by ${workloads.join(", ")}. Move these workloads to another VPC before removing it.`);
  if (models.some(model => model.databaseNetworkId === id)) throw new EditError(422, `VPC "${id}" owns the application database. Move the database declaration before removing this VPC.`);
  const entry = registered(root, files).networks.find(network => network.id === id);
  if (!entry) throw new EditError(422, "The VPC source declaration cannot be located.");
  const file = assertWritable(root, toRelative(root, entry.file));
  assertCreationFile(root, toRelative(root, file));
  const config = assertWritable(root, "framework.config.ts");
  const consumers: string[] = [];
  const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
  const visitFiles = (folder: string): void => {
    for (const child of readdirSync(folder, { withFileTypes: true })) {
      if (skip.has(child.name) || child.isSymbolicLink()) continue;
      const current = path.join(folder, child.name);
      if (child.isDirectory()) visitFiles(current);
      else if (child.isFile() && /\.[cm]?[jt]sx?$/.test(child.name) && current !== file && current !== config) {
        const source = files.get(current);
        let used = false;
        const inspect = (node: ts.Node): void => {
          if (ts.isStringLiteralLike(node) && moduleMatches(current, node.text, file)) used = true;
          ts.forEachChild(node, inspect);
        };
        inspect(source);
        if (used) consumers.push(toRelative(root, current));
      }
    }
  };
  visitFiles(root);
  if (consumers.length) throw new EditError(422, `VPC "${id}" is still referenced by ${consumers.join(", ")}. Remove or reassign these imports before removing it.`);
  const declaration = files.get(file);
  const imports = declaration.statements.filter(ts.isImportDeclaration);
  const declarations = declaration.statements.filter(ts.isVariableStatement);
  const onlyDeclaration = declarations.length === 1 && declarations[0]!.declarationList.declarations.length === 1 && declarations[0]!.declarationList.declarations[0]!.name.getText(declaration) === entry.exportName;
  const onlyFrameworkImports = imports.every(statement => ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@repo/framework/config" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.every(binding => (binding.propertyName ?? binding.name).text === "defineNetwork"));
  if (!onlyDeclaration || !onlyFrameworkImports || declaration.statements.some(statement => !ts.isVariableStatement(statement) && !ts.isImportDeclaration(statement) && !ts.isEmptyStatement(statement))) throw new EditError(422, "This VPC module contains other declarations or custom code. Remove it in source so that code is preserved deliberately.");
  let text = files.text(config);
  const parsedConfig = objectCall(config, text, "defineFrameworkConfig");
  let source = parsedConfig.source;
  const object = parsedConfig.object;
  const registry = findProperty(object, "networks");
  if (!registry.property || !ts.isPropertyAssignment(registry.property) || !ts.isArrayLiteralExpression(registry.property.initializer)) throw new EditError(422, "Compose networks as a literal array before removing a VPC.");
  const array = registry.property.initializer;
  const located = registered(root, files);
  const elements = array.elements.filter(element => ts.isExpression(element) && importedVpc(root, config, source, element, located) === id);
  if (elements.length !== 1 || !ts.isIdentifier(elements[0]!)) throw new EditError(422, "The VPC registry reference is computed. Remove it in source.");
  const element = elements[0]!;
  const localName = element.text;
  const references: ts.Identifier[] = [];
  const inspect = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === localName) references.push(node); ts.forEachChild(node, inspect); };
  inspect(source);
  const importStatement = source.statements.find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && moduleMatches(config, statement.moduleSpecifier.text, file));
  if (!importStatement || !ts.isImportDeclaration(importStatement)) throw new EditError(422, "The VPC import cannot be removed safely. Edit the registry in source.");
  const bindings = importStatement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1 || bindings.elements[0]!.name.text !== localName || importStatement.importClause?.name || references.some(reference => reference !== element && reference !== bindings.elements[0]!.name && reference !== bindings.elements[0]!.propertyName)) throw new EditError(422, "The VPC has additional references in framework.config.ts. Remove or reassign them before removing it.");
  const removeElement = (value: string, currentSource: ts.SourceFile, node: ts.Node, siblings: readonly ts.Node[]): string => {
    const start = node.getStart(currentSource);
    if ((ts.getLeadingCommentRanges(value, node.pos) ?? []).length || (ts.getTrailingCommentRanges(value, node.end) ?? []).length) throw new EditError(422, "This VPC registry item has a comment. Remove it in source to preserve the comment deliberately.");
    const after = /^\s*,[ \t]*/.exec(value.slice(node.end));
    if (after) return value.slice(0, start) + value.slice(node.end + after[0].length);
    const previous = siblings[siblings.indexOf(node) - 1];
    if (previous) {
      const separator = value.slice(previous.end, start);
      if (!/^\s*,\s*$/.test(separator)) throw new EditError(422, "This VPC registry item has source comments. Remove it in source.");
      return value.slice(0, previous.end) + value.slice(node.end);
    }
    return value.slice(0, start) + value.slice(node.end);
  };
  text = removeElement(text, source, element, array.elements);
  source = parse(config, text);
  const currentImport = source.statements.find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && moduleMatches(config, statement.moduleSpecifier.text, file))!;
  text = text.slice(0, currentImport.getStart(source)) + text.slice(currentImport.end).replace(/^[ \t]*\r?\n/, "");
  const changes: { file: string; before: string; after: string | null }[] = [{ file: config, before: files.text(config), after: text }, { file, before: files.text(file), after: null }];
  const descriptionFile = path.join(root, DESCRIPTION_FILE);
  if (existsSync(descriptionFile)) {
    const before = files.text(descriptionFile);
    let after = before;
    for (;;) {
      const parsed = parseDescriptions(after);
      const property = [...parsed.properties].find(([key]) => key === `island:vpc:${id}` || key.startsWith(`prop:vpc:${id}:`))?.[1];
      if (!property) break;
      after = removeProperty(after, parsed.source, parsed.object, property);
    }
    if (after !== before) changes.push({ file: assertWritable(root, DESCRIPTION_FILE), before, after });
  }
  return changes;
}
