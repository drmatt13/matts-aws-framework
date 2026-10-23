import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Bounded authored config closure shared by Studio and the private task.
 * Dotenv inputs are private connection/runtime inputs, never planner artifacts.
 */
export function sourceImportClosure(root: string, roots: readonly string[], strict = false): readonly string[] {
  const files = new Set<string>();
  const visit = (file: string) => {
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Prisma configuration imports outside the checkout. Move authored helpers into the checkout.");
    if (/(?:^|[\\/])\.env(?:\.|$)/.test(relative)) throw new Error("Prisma configuration imports a private dotenv file as source. Read private inputs through the runtime environment instead.");
    if (files.has(file)) return;
    if (files.size >= 128) throw new Error("Prisma configuration imports too many local files for a bounded review.");
    files.add(file);
    if (!existsSync(file)) return;
    let current = root;
    for (const segment of relative.split(path.sep)) { current = path.join(current, segment); if (lstatSync(current).isSymbolicLink()) throw new Error("Prisma configuration imports linked source. Review and replace that link before planning."); }
    if (!/\.[cm]?[jt]s$/.test(file)) return;
    const source = readFileSync(file, "utf8");
    if (strict) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!))) throw new Error("Computed database source imports cannot be bound to a review. Use literal relative imports.");
        ts.forEachChild(node, inspect);
      };
      inspect(ast);
    }
    for (const entry of ts.preProcessFile(source, true, true).importedFiles) {
      if (strict && (entry.fileName.startsWith("@repo/") || entry.fileName.startsWith("#"))) throw new Error("Database source workspace aliases cannot be bound to a review. Use literal relative imports for authored helpers.");
      if (!entry.fileName.startsWith(".")) continue;
      const candidate = path.resolve(path.dirname(file), entry.fileName);
      const typed = candidate.replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts").replace(/\.js$/, ".ts");
      const choices = [typed, candidate, ...[".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.js"].map(extension => candidate + extension)];
      visit(choices.find(value => existsSync(value) && lstatSync(value).isFile()) ?? candidate);
    }
  };
  for (const file of roots) visit(path.resolve(root, file));
  return [...files];
}

export function configurationSourceFiles(root: string): readonly string[] {
  return sourceImportClosure(root, ["packages/database/prisma.config.ts", "package.json", "package-lock.json", "packages/database/package.json"], true);
}

/** Executable migration helpers outside prisma are authored inputs too. */
export function migrationSourceFiles(root: string, entrypoints: readonly string[]): readonly string[] {
  return sourceImportClosure(root, entrypoints, true);
}
