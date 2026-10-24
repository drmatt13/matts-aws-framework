import path from "node:path";
import ts from "typescript";
export function resourceAlias(root: string, file: string, source: ts.SourceFile, text: string) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".") || statement.importClause?.isTypeOnly || path.resolve(path.dirname(file), statement.moduleSpecifier.text.replace(/\.(?:js|ts)$/, "")) !== path.join(root, "framework-config/resources")) continue;
    const bindings = statement.importClause?.namedBindings;
    const found = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "resources") : undefined;
    if (found) return { alias: found.name.text, imported: true };
  }
  let alias = "resources";
  for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(text); suffix++) alias = `resources${suffix}`;
  return { alias, imported: false };
}
export function addResourceImport(root: string, file: string, text: string, alias: string): string {
  let specifier = path.relative(path.dirname(file), path.join(root, "framework-config/resources")).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return `import { resources as ${alias} } from ${JSON.stringify(specifier)};\n${text}`;
}
