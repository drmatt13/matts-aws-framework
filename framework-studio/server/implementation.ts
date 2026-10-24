import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import ts from "typescript";
import path from "node:path";
import { getFrameworkTargets, type FrameworkConfig } from "@repo/framework/config";
import { createTargetArtifactValidator, resolveAgentSourcePath, resolveFrameworkDirectory, type TargetSourceHost } from "@repo/framework/config/source";
import type { ModeModel } from "../shared/model";
import { assertAgentCoreEntry } from "../../packages/framework/scripts/check-agentcore";
import { createCognitoVerifierInputValidator } from "../../packages/framework/scripts/check-auth";

/** Candidate files are visible to the canonical source/artifact validators without writing them. */
export function overlaySourceHost(overrides: Readonly<Record<string, string>> = {}): TargetSourceHost {
  const files = Object.keys(overrides).map(file => path.resolve(file));
  const virtualDirectory = (directory: string) => files.some(file => file.startsWith(path.resolve(directory) + path.sep));
  const realpath = (file: string): string => {
    if (existsSync(file)) return realpathSync(file);
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realpath(parent), path.basename(file));
  };
  return {
    exists: file => Object.hasOwn(overrides, path.resolve(file)) || existsSync(file),
    isDirectory: directory => virtualDirectory(directory) || existsSync(directory) && statSync(directory).isDirectory(),
    realpath,
    entries: directory => [...new Set([...(existsSync(directory) ? readdirSync(directory) : []), ...files.filter(file => file.startsWith(path.resolve(directory) + path.sep)).map(file => path.relative(directory, file).split(path.sep)[0]!)])],
  };
}

export function withImplementationHealth(config: FrameworkConfig, model: ModeModel, root: string, overrides: Readonly<Record<string, string>> = {}): ModeModel {
  const host = overlaySourceHost(overrides);
  const targets = new Map<string, ReturnType<typeof getFrameworkTargets>[number]>(getFrameworkTargets(config).map(target => [target.reference, target]));
  const assertArtifacts = createTargetArtifactValidator(config, host);
  const assertCognitoInput = createCognitoVerifierInputValidator(config);
  return { ...model, targets: model.targets.map(target => {
    const declaration = targets.get(target.ref);
    if (!declaration?.directory || target.kind === "workflow") return target;
    const problems: string[] = [];
    try {
      const directory = target.kind === "agent" ? resolveAgentSourcePath(config, target.id, { repositoryRoot: root, sourceHost: host }) : resolveFrameworkDirectory(declaration.directory, target.ref, { repositoryRoot: root, sourceHost: host });
      assertArtifacts(declaration, directory);
      const read = (file: string) => overrides[path.resolve(file)] ?? readFileSync(file, "utf8");
      if (target.kind === "agent" || target.compute.kind === "lambda" && target.compute.packaging === "zip" && target.compute.implementation === "typescript") {
        const file = path.join(directory, "index.ts"), sourceText = read(file), source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
        const name = target.kind === "agent" ? "handler" : target.compute.kind === "lambda" ? target.compute.handler ?? "lambdaHandler" : "lambdaHandler";
        const exports = new Set(source.statements.flatMap(statement => {
          if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) return statement.exportClause.elements.map(item => item.name.text);
          if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
          if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
          return ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(item => ts.isIdentifier(item.name) ? [item.name.text] : []) : [];
        }));
        if (!exports.has(name) && !source.statements.some(statement => ts.isExportDeclaration(statement) && !statement.exportClause)) problems.push(`${target.ref} requires index.ts to export ${name}. Restore the configured handler; existing code is preserved.`);
        assertAgentCoreEntry(config, declaration, sourceText);
        assertCognitoInput(declaration, () => sourceText);
      }
      if ((target.role === "agent" || target.role === "tool") && !host.exists(path.join(directory, "contract.ts")) && !host.exists(path.join(directory, "contract.schema.json"))) problems.push(`${target.ref} needs an adjacent contract.ts or contract.schema.json before generation.`);
      if (target.kind === "service" && target.lanes.local) {
        const manifest = path.join(directory, "package.json");
        if (!host.exists(manifest) || typeof JSON.parse(read(manifest)).scripts?.dev !== "string") problems.push(`${target.ref} needs package.json with a dev script for local Compose.`);
      }
    } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
    return { ...target, implementation: { ready: problems.length === 0, problems } };
  }) };
}
