import assert from "./support/assert";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const serverPackages = new Set(["express", "vite", "typescript", "aws-cdk-lib"]);

/** Type-only contracts may cross boundaries; executable imports may not. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) names.push(value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

async function sourceFiles(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?tsx?$/.test(file) ? [file] : [];
  }))).flat();
}

test("browser runtime imports cannot reach Node, server services or AWS execution adapters", async () => {
  const studio = path.resolve(__dirname, "..");
  const config = ts.readConfigFile(path.join(studio, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, studio);
  const pending = [...await sourceFiles(path.join(studio, "src")), ...await sourceFiles(path.join(studio, "shared"))];
  const visited = new Set<string>();
  const problems: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file) || file.endsWith(".d.ts")) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const name of runtimeSpecifiers(source)) {
      const owner = path.relative(studio, file).replaceAll(path.sep, "/");
      if (name.startsWith("node:") || builtins.has(name) || serverPackages.has(name) || name.startsWith("@aws-sdk/")) {
        problems.push(`${owner} imports runtime ${name}`);
        continue;
      }
      // Third-party browser packages own their published bundles. Follow authored
      // relative/workspace imports, including the existing pure script/CDK helpers.
      if (!name.startsWith(".") && !name.startsWith("@repo/")) continue;
      const resolved = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || !/\.[cm]?tsx?$/.test(resolved)) continue;
      if (resolved.replaceAll(path.sep, "/").includes("/framework-studio/server/")) problems.push(`${owner} imports server service ${name}`);
      else pending.push(resolved);
    }
  }
  assert.deepEqual(problems, [], "Keep browser rendering separate from privileged execution; use shared type-only contracts and HTTP adapters.");
});

test("boundary analysis distinguishes type contracts from executable imports", () => {
  const source = ts.createSourceFile("contracts.ts", `
    import type { Server } from "node:http";
    import { type Snapshot } from "../server/snapshot";
    export type { Result } from "../server/service";
    export { type Contract } from "../server/types";
    import { validate, type Settings } from "./shared";
    export { handler } from "./runtime";
    import {} from "./side-effect";
    export {} from "./side-effect-export";
    const lazy = import("node:fs");
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(runtimeSpecifiers(source), ["./shared", "./runtime", "./side-effect", "./side-effect-export", "node:fs"]);
});
