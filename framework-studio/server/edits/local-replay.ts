import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModelTarget } from "../../shared/model";

const MODULE = "@repo/framework/runtime/event-replay";
const refuse = (): never => { throw new Error("Studio can pair local replay with a directly exported TypeScript handler constant. Update this handler in your editor before changing local replay."); };

/** A separate, narrow write authority: only this event's resolved TypeScript entry point.
 * The generic configuration writer never gains access to handler directories. */
export function replayHandlerFile(root: string, target: ModelTarget): { file: string; name: string } {
  const compute = target.compute;
  if (target.role !== "event" || compute.kind !== "lambda" || compute.implementation !== "typescript" || compute.packaging !== "zip" || !target.directory) return refuse();
  const handler = /^[A-Za-z_$][\w$]*$/.exec(compute.handler ?? "");
  if (!handler) return refuse();
  const directory = path.resolve(root, "cdk-app", target.directory.replace(/^[/\\]+/, ""));
  const file = path.resolve(directory, "index.ts");
  const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
  if (!inside(path.resolve(root, "cdk-app"), directory) || !inside(directory, file) || !existsSync(file) || lstatSync(file).isSymbolicLink()) return refuse();
  const real = realpathSync(file);
  if (!inside(path.join(realpathSync(root), "cdk-app"), real) || !inside(directory, real)) return refuse();
  return { file, name: handler[0] };
}

/** Splice only the wrapper/import, preserving the handler body and unrelated source. */
export function rewriteReplayHandler(file: string, text: string, name: string, enabled: boolean): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = source.statements.flatMap((statement) => ts.isVariableStatement(statement) && statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)
    ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name) : []);
  const initializer = declarations.length === 1 ? declarations[0]!.initializer : undefined;
  if (!initializer) return refuse();
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  const imports = source.statements.filter(ts.isImportDeclaration);
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== MODULE || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "withLocalReplay") aliases.add(item.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  const isWrapper = (expression: ts.Expression) => ts.isIdentifier(expression) ? aliases.has(expression.text)
    : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && expression.name.text === "withLocalReplay";
  const wrapped = ts.isCallExpression(initializer) && isWrapper(initializer.expression);
  if (wrapped && initializer.arguments.length !== 1) return refuse();
  let otherCapture = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !(node === initializer && wrapped) && (isWrapper(node.expression) || ts.isIdentifier(node.expression) && ["withLocalReplay", "captureEventDrivenInvocation"].includes(node.expression.text))) otherCapture = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (otherCapture) return refuse();
  const canonicalCall = wrapped && (!ts.isIdentifier(initializer.expression) || initializer.expression.text === "withLocalReplay");
  if (enabled && canonicalCall || !enabled && !wrapped) return text;
  let after: string;
  if (!enabled) {
    if (!ts.isCallExpression(initializer) || initializer.arguments.length !== 1) return refuse();
    const argument = initializer.arguments[0]!;
    const removed = text.slice(initializer.getStart(source), argument.getStart(source)) + text.slice(argument.end, initializer.end);
    if (/\/\/|\/\*/.test(removed)) return refuse();
    after = text.slice(0, initializer.getStart(source)) + argument.getText(source) + text.slice(initializer.end);
    // Keep the import: other code/type references may use it, and re-enabling can reuse it.
  } else {
    let wrapper = aliases.has("withLocalReplay") ? "withLocalReplay" : ([...namespaces][0] ? `${[...namespaces][0]}.withLocalReplay` : undefined);
    let addition = "";
    if (!wrapper) {
      const identifiers = new Set<string>();
      const collect = (node: ts.Node): void => { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, collect); };
      collect(source);
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      if (!identifiers.has("withLocalReplay")) {
        wrapper = "withLocalReplay";
        addition = `${newline}import { withLocalReplay } from "${MODULE}";${newline}`;
      } else {
        let namespace = "studioReplay";
        while (identifiers.has(namespace)) namespace = `_${namespace}`;
        wrapper = `${namespace}.withLocalReplay`;
        addition = `${newline}import * as ${namespace} from "${MODULE}";${newline}`;
      }
    }
    const expression = wrapped ? initializer.expression : initializer;
    after = text.slice(0, expression.getStart(source)) + (wrapped ? wrapper : `${wrapper}(${initializer.getText(source)})`) + text.slice(expression.end);
    if (addition) {
      const at = imports.at(-1)?.end ?? source.statements[0]?.getStart(source) ?? 0;
      after = after.slice(0, at) + addition + after.slice(at);
    }
  }
  const diagnostics = ts.transpileModule(after, { fileName: file, reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.length) return refuse();
  return after;
}
