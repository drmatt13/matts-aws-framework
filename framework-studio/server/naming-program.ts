import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { RenameIssue } from "../shared/naming";
import type { SourceLocation } from "../shared/model";
import { sha256, toRelative } from "./files";

const IGNORED = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage", "output", ".playwright-mcp", "archived-workloads"]);
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

export interface NamingProject { readonly file: string; readonly roots: readonly string[]; readonly options: ts.CompilerOptions }
export interface NamingProgramIndex {
  readonly root: string;
  readonly files: readonly string[];
  readonly projects: readonly NamingProject[];
  readonly texts: ReadonlyMap<string, string>;
  readonly externalTexts: Map<string, string | undefined>;
  readonly hashes: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}
export interface NamingSeed { readonly file: string; readonly start: number; readonly name: string }
export interface NamingTextEdit { readonly file: string; readonly start: number; readonly length: number; readonly prefix: string; readonly suffix: string }

export function namingLocation(root: string, file: string, text: string, start: number, end = start): SourceLocation {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const position = source.getLineAndCharacterOfPosition(Math.min(start, text.length));
  return { file: toRelative(root, file), line: position.line + 1, column: position.character + 1, start, end };
}

export function isNamingSource(root: string, file: string): boolean {
  root = path.resolve(root);
  file = path.resolve(file);
  const relative = toRelative(root, file);
  if (relative.startsWith("../") || path.isAbsolute(relative) || !/\.tsx?$/.test(relative) || /\.d\.ts$/.test(relative)
    || relative.split("/").some(part => IGNORED.has(part) || part === "generated") || /\.gen\.[cm]?tsx?$/.test(relative)) return false;
  try {
    for (let component = file; component !== root; component = path.dirname(component)) if (lstatSync(component).isSymbolicLink()) return false;
    return realpathSync(file) === path.resolve(realpathSync(root), relative);
  } catch { return false; }
}

function inventory(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (SOURCE.test(entry.name) || /^tsconfig.*\.json$/.test(entry.name) || entry.name === "package.json" || file === path.join(root, "package-lock.json"))) files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

export function namingSourceFingerprint(root: string): string {
  return sha256(JSON.stringify(inventory(root).map(file => [toRelative(root, file), sha256(readFileSync(file, "utf8"))])));
}

export function namingProgramIndex(root: string, overlays: ReadonlyMap<string, string>): NamingProgramIndex {
  root = path.resolve(root);
  const files = inventory(root);
  const texts = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
  const hashes = Object.fromEntries(files.map(file => [toRelative(root, file), sha256(texts.get(file)!)]));
  const projects: NamingProject[] = [];
  const externalTexts = new Map<string, string | undefined>();
  const read = (file: string) => {
    file = path.resolve(file);
    if (!externalTexts.has(file) && !overlays.has(file) && !texts.has(file)) externalTexts.set(file, ts.sys.readFile(file));
    return overlays.get(file) ?? texts.get(file) ?? externalTexts.get(file);
  };
  for (const file of files.filter(file => /^tsconfig.*\.json$/.test(path.basename(file)))) {
    const loaded = ts.readConfigFile(file, read);
    if (loaded.error) continue;
    const parsed = ts.parseJsonConfigFileContent(loaded.config, { ...ts.sys, readFile: read }, path.dirname(file));
    projects.push({ file, roots: parsed.fileNames.filter(name => !toRelative(root, name).split("/").includes("archived-workloads")), options: { ...parsed.options, noEmit: true } });
  }
  const options = projects.find(project => project.file === path.join(root, "cdk-app/tsconfig.json"))?.options
    ?? { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true };
  const configuration = [...new Set([...files.filter(file => file === path.join(root, "framework.config.ts") || file.startsWith(path.join(root, "framework-config") + path.sep) && /\.tsx?$/.test(file)), ...overlays.keys()].filter(file => /\.tsx?$/.test(file) && (file.startsWith(path.join(root, "framework-config") + path.sep) || file === path.join(root, "framework.config.ts"))))];
  projects.unshift({ file: path.join(root, "framework.config.ts"), roots: configuration, options });
  const unique = new Map<string, NamingProject>();
  for (const project of projects) {
    const signature = JSON.stringify({ roots: [...project.roots].sort(), options: Object.fromEntries(Object.entries(project.options).sort(([a], [b]) => a.localeCompare(b))) });
    if (!unique.has(signature)) unique.set(signature, project);
  }
  return { root, files, projects: [...unique.values()], texts, externalTexts, hashes, fingerprint: sha256(JSON.stringify(Object.entries(hashes))) };
}

function projectReaches(index: NamingProgramIndex, project: NamingProject, targets: ReadonlySet<string>, read: (file: string) => string | undefined): boolean {
  const memo = new Map<string, boolean>();
  const host: ts.ModuleResolutionHost = { fileExists: file => index.texts.has(path.resolve(file)) || ts.sys.fileExists(file) || read(file) !== undefined, readFile: read, directoryExists: ts.sys.directoryExists, realpath: file => { try { return realpathSync(file); } catch { return file; } } };
  const moduleCache = ts.createModuleResolutionCache(index.root, file => file, project.options);
  const reaches = (file: string, active = new Set<string>()): boolean => {
    file = path.resolve(file);
    if (targets.has(file)) return true;
    if (memo.has(file)) return memo.get(file)!;
    if (active.has(file) || toRelative(index.root, file).startsWith("../") || file.includes(`${path.sep}node_modules${path.sep}`)) return false;
    const text = read(file);
    if (text === undefined) return false;
    const next = new Set(active).add(file);
    const found = ts.preProcessFile(text, true, true).importedFiles.some(imported => {
      const target = ts.resolveModuleName(imported.fileName, file, project.options, host, moduleCache).resolvedModule?.resolvedFileName;
      return !!target && reaches(target, next);
    });
    memo.set(file, found);
    return found;
  };
  return project.roots.some(file => reaches(file));
}

function symbolContains(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, seed: NamingSeed): boolean {
  if (!symbol) return false;
  return checker.getRootSymbols(symbol).some(root => root.declarations?.some(declaration => {
    const name = (declaration as ts.NamedDeclaration).name;
    return !!name && path.resolve(name.getSourceFile().fileName) === seed.file && name.getStart() === seed.start;
  }));
}

function maySelect(type: ts.Type, name: string): boolean {
  if (type.isUnion()) return type.types.some(part => maySelect(part, name));
  if (type.isStringLiteral()) return type.value === name;
  if (type.flags & ts.TypeFlags.TypeParameter) return !type.getConstraint() || maySelect(type.getConstraint()!, name);
  return !!(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** The exporter consumes catalog enumeration, never a resource's code name. */
function genericCatalogExporter(root: string, file: string, text: string, seed: NamingSeed): boolean {
  if (toRelative(root, file) !== "scripts/export-cdk-outputs.mjs") return false;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
  const declarations = source.statements.filter(ts.isVariableStatement).filter(statement => !!(statement.declarationList.flags & ts.NodeFlags.Const)).flatMap(statement => [...statement.declarationList.declarations]);
  const namedImport = (name: string, module: string) => source.statements.filter(ts.isImportDeclaration).filter(statement => ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text === module).flatMap(statement => {
    const bindings = statement.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(binding => binding.name.text === name && (binding.propertyName?.text ?? binding.name.text) === name).map(binding => binding.name) : [];
  });
  const namedRequire = (name: string, module: string) => declarations.filter(declaration => {
    const value = declaration.initializer;
    return value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "require" && value.arguments.length === 1 && ts.isStringLiteralLike(value.arguments[0]!) && value.arguments[0]!.text === module;
  }).flatMap(declaration => ts.isObjectBindingPattern(declaration.name) ? declaration.name.elements.filter(binding => !binding.dotDotDotToken && !binding.initializer && ts.isIdentifier(binding.name) && binding.name.text === name && (binding.propertyName ? ts.isIdentifier(binding.propertyName) && binding.propertyName.text === name : true)).map(binding => binding.name as ts.Identifier) : []);
  const require = declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "require" && declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "createRequire" && declaration.initializer.arguments.length === 1 && declaration.initializer.arguments[0]!.getText(source) === "import.meta.url");
  const framework = declarations.filter(declaration => ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.length === 1 && ts.isIdentifier(declaration.name.elements[0]!.name) && declaration.name.elements[0]!.name.text === "framework" && declaration.name.elements[0]!.propertyName?.getText(source) === "default" && declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "require" && declaration.initializer.arguments.length === 1 && ts.isCallExpression(declaration.initializer.arguments[0]!) && ts.isIdentifier(declaration.initializer.arguments[0]!.expression) && declaration.initializer.arguments[0]!.expression.text === "resolve" && declaration.initializer.arguments[0]!.arguments.length === 2 && ts.isIdentifier(declaration.initializer.arguments[0]!.arguments[0]!) && declaration.initializer.arguments[0]!.arguments[0]!.text === "mappingRoot" && ts.isStringLiteralLike(declaration.initializer.arguments[0]!.arguments[1]!) && declaration.initializer.arguments[0]!.arguments[1]!.text === "framework.config.ts");
  const enumeration = declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "declarations" && declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "listResourceDeclarations" && declaration.initializer.arguments.length === 1 && ts.isPropertyAccessExpression(declaration.initializer.arguments[0]!) && ts.isIdentifier(declaration.initializer.arguments[0]!.expression) && declaration.initializer.arguments[0]!.expression.text === "framework" && declaration.initializer.arguments[0]!.name.text === "resources");
  const expected = new Map<string, readonly ts.Identifier[]>([
    ["createRequire", namedImport("createRequire", "node:module")], ["resolve", namedImport("resolve", "node:path")],
    ["require", require.map(declaration => declaration.name as ts.Identifier)],
    ["listResourceDeclarations", namedRequire("listResourceDeclarations", "@repo/framework/config")],
    ["collectDevelopmentResources", namedRequire("collectDevelopmentResources", "./resource-export.ts")],
    ["resolveClientEnvironmentMappings", namedRequire("resolveClientEnvironmentMappings", "./client-environment-export.ts")],
    ["declarations", enumeration.map(declaration => declaration.name as ts.Identifier)],
    ["framework", framework.flatMap(declaration => ts.isObjectBindingPattern(declaration.name) ? declaration.name.elements.map(binding => binding.name as ts.Identifier) : [])],
  ]);
  if ([...expected.values()].some(values => values.length !== 1)) return false;
  let valid = true, enumerations = 0, listingCalls = 0, resolverCalls = 0, collectorCalls = 0, sinkUses = 0;
  const sink = (property: ts.Node): boolean => {
    const object = property.parent, call = object.parent;
    return ts.isObjectLiteralExpression(object) && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "resolveClientEnvironmentMappings" && call.arguments.length === 2 && call.arguments[1] === object;
  };
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isStringLiteralLike(node) && (node.text === seed.name || node.text.startsWith("resource:") && node.text.slice(9).split(".").includes(seed.name))) valid = false;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && ["eval", "Function"].includes(node.expression.text)) valid = false;
    if (ts.isIdentifier(node) && expected.has(node.text)) {
      const parent = node.parent;
      const binding = ts.isVariableDeclaration(parent) && parent.name === node || ts.isBindingElement(parent) && parent.name === node || ts.isParameter(parent) && parent.name === node || (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) && parent.name === node;
      if (binding && expected.get(node.text)![0] !== node) valid = false;
      if (node !== expected.get(node.text)![0]) {
        if (node.text === "listResourceDeclarations") {
          if (ts.isCallExpression(parent) && parent.expression === node && parent === enumeration[0]!.initializer) listingCalls++;
          else valid = false;
        }
        if (node.text === "resolveClientEnvironmentMappings") {
          if (ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 2 && ts.isObjectLiteralExpression(parent.arguments[1]!)) resolverCalls++;
          else valid = false;
        }
        if (node.text === "collectDevelopmentResources") {
          if (ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 3 && ts.isIdentifier(parent.arguments[2]!) && parent.arguments[2]!.text === "framework") collectorCalls++;
          else valid = false;
        }
        if (node.text === "declarations") {
          if (ts.isShorthandPropertyAssignment(parent) && parent.name === node && !parent.objectAssignmentInitializer && sink(parent)) sinkUses++;
          else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === "declarations" && sink(parent) && ts.isIdentifier(parent.initializer) && parent.initializer.text === "declarations") { if (parent.initializer === node) sinkUses++; }
          else valid = false;
        }
      }
      if (node.text === "framework" && expected.get("framework")![0] !== node) {
        const access = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "resources" ? parent : undefined;
        const call = access?.parent ?? parent;
        if (access && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "listResourceDeclarations" && call.arguments.length === 1 && call.arguments[0] === access) enumerations++;
        else if (!access && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "collectDevelopmentResources" && call.arguments.length === 3 && call.arguments[2] === node) enumerations++;
        else valid = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return valid && enumerations === 2 && listingCalls === 1 && collectorCalls === 1 && resolverCalls === 1 && sinkUses === 1;
}

/** Uses each project's real module resolution; no source is evaluated or emitted. */
export function namingReferences(index: NamingProgramIndex, overlays: ReadonlyMap<string, string>, seed: NamingSeed, inspectReceivers = false): { edits: readonly NamingTextEdit[]; issues: readonly RenameIssue[]; analyzedFiles: readonly string[] } {
  const read = (file: string) => {
    file = path.resolve(file);
    if (!index.externalTexts.has(file) && !overlays.has(file) && !index.texts.has(file)) index.externalTexts.set(file, ts.sys.readFile(file));
    return overlays.get(file) ?? index.texts.get(file) ?? index.externalTexts.get(file);
  };
  const edits = new Map<string, NamingTextEdit>();
  const issues = new Map<string, RenameIssue>();
  const analyzed = new Set<string>();
  const registry = ts.createDocumentRegistry();
  const issue = (file: string, node: ts.Node | undefined, message: string, position?: number) => {
    const text = read(file) ?? "";
    const start = node?.getStart() ?? position ?? (file === seed.file ? seed.start : 0);
    const source = namingLocation(index.root, file, text, start, node?.end ?? start);
    issues.set(`${file}:${start}:${message}`, { message, source });
  };
  for (const project of index.projects) {
    if (!projectReaches(index, project, new Set([seed.file]), read)) continue;
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => project.options, getCurrentDirectory: () => index.root,
      getScriptFileNames: () => [...project.roots], getScriptVersion: () => "1",
      getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getDefaultLibFileName: ts.getDefaultLibFilePath, fileExists: file => overlays.has(path.resolve(file)) || index.texts.has(path.resolve(file)) || ts.sys.fileExists(file),
      readFile: read, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(host, registry);
    try {
      const program = service.getProgram();
      if (!program?.getSourceFile(seed.file)) continue;
      const preferences: ts.UserPreferences = { providePrefixAndSuffixTextForRename: true, allowRenameOfImportPath: false };
      const info = service.getRenameInfo(seed.file, seed.start + (read(seed.file)?.[seed.start] === '"' || read(seed.file)?.[seed.start] === "'" ? 1 : 0), preferences);
      if (!info.canRename || info.fileToRename) { issue(seed.file, undefined, info.canRename ? "This source requires a file rename. Open it in your editor." : info.localizedErrorMessage); continue; }
      const locations = service.findRenameLocations(seed.file, seed.start + (read(seed.file)?.[seed.start] === '"' || read(seed.file)?.[seed.start] === "'" ? 1 : 0), false, false, preferences) ?? [];
      for (const location of locations) {
        const file = path.resolve(location.fileName);
        if (!isNamingSource(index.root, file)) { issue(file, undefined, "This reference is generated, linked, or outside authored source. Resolve its owning source before renaming.", location.textSpan.start); continue; }
        const edit = { file, start: location.textSpan.start, length: location.textSpan.length, prefix: location.prefixText ?? "", suffix: location.suffixText ?? "" };
        const key = `${file}:${edit.start}:${edit.length}`;
        const previous = edits.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(edit)) issue(file, undefined, "TypeScript projects disagree about this reference. Resolve the source before renaming.");
        else edits.set(key, edit);
      }
      const checker = program.getTypeChecker();
      for (const source of program.getSourceFiles()) {
        if (!isNamingSource(index.root, source.fileName)) continue;
        analyzed.add(path.resolve(source.fileName));
        if (!inspectReceivers) continue;
        const receiver = (node: ts.Expression) => symbolContains(checker, checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(node)), seed.name), seed);
        const retainsIdentity = (type: ts.Type | undefined) => !!type && symbolContains(checker, checker.getPropertyOfType(checker.getNonNullableType(type), seed.name), seed);
        const escaped = (node: ts.Expression) => issue(source.fileName, node, `This catalog receiver is passed to a reflective or shape-erasing consumer whose references cannot be renamed safely. In your editor, use a direct typed reference to the existing ${node.getText(source)}[${JSON.stringify(seed.name)}] entry, save, then review again. Keep the existing resource name until Apply.`);
        const visit = (node: ts.Node): void => {
          if (ts.isElementAccessExpression(node) && node.argumentExpression && !ts.isStringLiteralLike(node.argumentExpression) && receiver(node.expression) && maySelect(checker.getTypeAtLocation(node.argumentExpression), seed.name)) issue(source.fileName, node.argumentExpression, `This reference uses a computed catalog key. In your editor, make it static as ${node.expression.getText(source)}[${JSON.stringify(seed.name)}], save, then review again. Keep the existing resource name until Apply.`);
          if (ts.isAsExpression(node) && receiver(node.expression) && checker.getTypeAtLocation(node).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) issue(source.fileName, node, "This catalog receiver is cast to an unknown shape. Keep the existing resource name and remove the untyped cast or use a direct typed reference in your editor, save, then review again.");
          if (ts.isVariableDeclaration(node) && node.initializer && node.type && receiver(node.initializer) && checker.getTypeAtLocation(node.name).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) issue(source.fileName, node, "This catalog receiver escapes through an untyped binding. Keep the existing resource name and use a direct typed reference in your editor, save, then review again.");
          if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && receiver(node.expression) && !retainsIdentity(checker.getTypeAtLocation(node))) escaped(node.expression);
          if (ts.isVariableDeclaration(node) && node.initializer && node.type && receiver(node.initializer) && !retainsIdentity(checker.getTypeAtLocation(node.name))) escaped(node.initializer);
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const argument of node.arguments ?? []) if (receiver(argument)) {
            const reflective = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ["Reflect", "Object"].includes(node.expression.expression.text) && !["freeze", "seal", "preventExtensions"].includes(node.expression.name.text);
            const opaqueKey = (node.arguments ?? []).some(other => other !== argument && maySelect(checker.getTypeAtLocation(other), seed.name));
            if (reflective || opaqueKey || !retainsIdentity(checker.getContextualType(argument))) escaped(argument);
          }
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && receiver(node.right) && !retainsIdentity(checker.getTypeAtLocation(node.left))) escaped(node.right);
          if (ts.isReturnStatement(node) && node.expression && receiver(node.expression)) {
            let parent: ts.Node | undefined = node.parent;
            while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
            if (parent && ts.isFunctionLike(parent) && "type" in parent && parent.type && !retainsIdentity(checker.getTypeAtLocation(parent.type))) escaped(node.expression);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    } finally { service.dispose(); }
  }
  for (const file of index.files.filter(file => SOURCE.test(file) && !/\.d\.[cm]?ts$/.test(file) && (!analyzed.has(file) || !/\.tsx?$/.test(file)) && !toRelative(index.root, file).split("/").includes("generated"))) {
    const fallback: NamingProject = { file, roots: [file], options: index.projects[0]!.options };
    if (projectReaches(index, fallback, new Set([seed.file]), read)) {
      if (genericCatalogExporter(index.root, file, read(file) ?? "", seed)) continue;
      const host: ts.ModuleResolutionHost = { fileExists: ts.sys.fileExists, readFile: read, directoryExists: ts.sys.directoryExists };
      const reference = ts.preProcessFile(read(file) ?? "", true, true).importedFiles.find(imported => {
        const resolved = ts.resolveModuleName(imported.fileName, file, fallback.options, host).resolvedModule?.resolvedFileName;
        return !!resolved && projectReaches(index, { ...fallback, roots: [resolved] }, new Set([seed.file]), read);
      });
      issue(file, undefined, "This catalog consumer is outside a configured TypeScript project. Add it to its project or resolve the reference in your editor.", reference?.pos ?? 0);
    }
  }
  return { edits: [...edits.values()], issues: [...issues.values()], analyzedFiles: [...analyzed] };
}
