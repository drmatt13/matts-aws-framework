import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { DraftEdit } from "../../shared/api";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, hasComments, propertyAt, unwrap } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { removeProperty } from "./splice";
import { planPlacement } from "./networks";
import { EditError } from "./io";

type Connection = Extract<DraftEdit, { kind: "connection" }>;
function planCatalogConnection(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const target = Object.values(state.snapshot.models).flatMap(model => model.targets).find(item => item.ref === edit.target);
  const resource = Object.values(state.snapshot.models).flatMap(model => model.resources).find(item => item.id === edit.destination);
  if (!target || !resource || !/^resource:(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id)) throw new EditError(422, "Select a declared catalog resource.");
  const grant = edit.connection === "grant";
  if (!grant && !["input", "secret"].includes(resource.kind)) throw new EditError(422, "Input delivery supports catalog inputs and secrets; native construct attributes remain source-owned.");
  if (!grant && !/^[A-Z][A-Z0-9_]*$/.test(edit.variable ?? "")) throw new EditError(422, "Enter an uppercase consumer environment variable.");
  if (grant) {
    const types = state.snapshot.source.triggerCapabilities?.find(item => item.resource === resource.id)?.canonicalTypes ?? [];
    const bucket = types.some(type => /^aws-s3:(?:I?Bucket)$/.test(type)), queue = types.some(type => /^aws-sqs:(?:I?Queue)$/.test(type));
    if (!(bucket && ["grantRead", "grantWrite", "grantReadWrite"].includes(edit.grant ?? "") || queue && ["grantSendMessages", "grantConsumeMessages"].includes(edit.grant ?? ""))) throw new EditError(422, "Choose a supported native bucket or queue grant. Custom grants remain source-owned.");
    if (edit.scope !== undefined && (typeof edit.scope !== "string" || edit.scope.length > 256 || /[\r\n\0]/.test(edit.scope) || queue && !!edit.scope)) throw new EditError(422, "Use a literal object-key scope for a bucket grant; queue grants take no scope.");
  }
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides), parsed = parseOrigin(origin), located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
    if (!entry || !value || !parsed) throw new EditError(422, "The consumer declaration cannot be located.");
    const declaration = declarationObject(value, parsed.section, parsed.chain);
    if ("unsupported" in declaration) throw new EditError(422, declaration.unsupported);
    const file = assertWritable(root, toRelative(root, entry.file)), source = files.get(file);
    let text = files.text(file), alias = "resources", imported = false;
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".") || statement.importClause?.isTypeOnly || path.resolve(path.dirname(file), statement.moduleSpecifier.text.replace(/\.(?:js|ts)$/, "")) !== path.join(root, "framework-config/resources")) continue;
      const bindings = statement.importClause?.namedBindings;
      const found = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "resources") : undefined;
      if (found) { alias = found.name.text; imported = true; break; }
    }
    if (!imported) for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(text); suffix++) alias = `resources${suffix}`;
    const reference = `${alias}${resource.path.map(part => `[${JSON.stringify(part)}]`).join("")}`;
    const container = target.kind === "service" || target.kind === "task";
    const keys = grant ? ["cloud", "bindings"] : [container && resource.kind === "secret" ? "secrets" : "environment", edit.variable!];
    const position = propertyAt(declaration.object, keys);
    if (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property) throw new EditError(422, "This binding map is computed. Edit it in source.");
    if (grant) {
      const expression = `${reference}.${edit.grant}(${edit.scope ? JSON.stringify(edit.scope) : ""})`;
      const array = position.property && unwrap(position.property.initializer);
      const referencePath = (node: ts.Expression): readonly string[] | undefined => {
        const value = unwrap(node);
        if (ts.isIdentifier(value)) return [value.text];
        if (ts.isPropertyAccessExpression(value)) { const base = referencePath(value.expression); return base && [...base, value.name.text]; }
        if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression)) { const base = referencePath(value.expression); return base && [...base, value.argumentExpression.text]; }
        return undefined;
      };
      const matches = (item: ts.Expression): boolean => {
        const call = unwrap(item);
        return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === edit.grant && JSON.stringify(referencePath(call.expression.expression)) === JSON.stringify([alias, ...resource.path]) && (edit.scope ? call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]!) && call.arguments[0]!.text === edit.scope : call.arguments.length === 0);
      };
      if (array) {
        if (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement) || hasComments(array.getText(source))) throw new EditError(422, "This binding list is computed or commented. Edit it in source.");
        const existing = array.elements.filter(matches);
        if (edit.enabled && existing.length) throw new EditError(422, "This exact native grant already exists.");
        if (!edit.enabled && existing.length !== 1) throw new EditError(422, "Select the exact declared native grant and scope to disconnect. Computed or ambiguous grants remain source-owned.");
        if (edit.enabled) {
          const at = array.end - 1;
          text = text.slice(0, at) + `${array.elements.length && !array.elements.hasTrailingComma ? "," : ""} ${expression}` + text.slice(at);
        } else text = text.slice(0, array.getStart(source)) + `[${array.elements.filter(item => !matches(item)).map(item => item.getText(source)).join(", ")}]` + text.slice(array.end);
      } else if (edit.enabled) text = insertExpression(text, source, position.container, position.missing, `[${expression}]`);
      else throw new EditError(422, "This consumer has no native bindings to disconnect.");
    } else if (!edit.enabled) {
      if (!position.property) throw new EditError(422, "This consumer variable is not declared here.");
      const delivered = [...target.environment, ...target.secrets].find(item => item.name === edit.variable);
      if (!delivered || !JSON.stringify(delivered).includes(resource.id)) throw new EditError(422, "This variable belongs to another mapping. Inspect it in source before removal.");
      if (hasComments(position.property.getText(source))) throw new EditError(422, "This mapping contains comments. Edit it in source to preserve them.");
      text = removeProperty(text, source, position.container, position.property);
    } else {
      if (position.property) throw new EditError(422, "This environment variable already exists. Choose another name or disconnect its current mapping first.");
      text = insertExpression(text, source, position.container, position.missing, reference + (resource.kind === "secret" ? container ? ".value" : ".arn" : ""));
    }
    if (edit.enabled && !imported) {
      let specifier = path.relative(path.dirname(file), path.join(root, "framework-config/resources")).replaceAll("\\", "/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      text = `import { resources as ${alias} } from ${JSON.stringify(specifier)};\n${text}`;
    }
    overrides.set(file, text);
  }
}
/** Bounded declaration operations. No arbitrary expressions, IAM strings, or source destinations. */
export function planConnection(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const models = Object.values(state.snapshot.models);
  const target = models.flatMap(model => model.targets).find(target => target.ref === edit.target);
  if (!target || target.kind === "workflow") throw new EditError(422, "Select a compute workload to configure a connection.");
  if (!["database", "userPool", "runsTask", "startsWorkflow", "invokesAgent", "tool", "resource", "grant"].includes(edit.connection) || typeof edit.enabled !== "boolean") throw new EditError(422, "Choose a supported connection operation.");
  if (edit.connection === "resource" || edit.connection === "grant") { planCatalogConnection(root, state, edit, overrides); return; }
  const simple = edit.connection === "database" || edit.connection === "userPool";
  if (edit.connection === "database") {
    if (target.kind === "agent") throw new EditError(422, "Database access belongs in an agent's tool, not the agent.");
    if (edit.enabled && target.role === "event" && target.compute.kind === "lambda" && !target.compute.localReplay) throw new EditError(422, "An AWS-invoked event reaches local PostgreSQL only through local replay. Enable replay for an asynchronous compatible trigger first; a synchronous workflow step must keep its response and cannot use that capture path.");
    const database = state.snapshot.models.prod.managedDatabase;
    if (!database) throw new EditError(422, "Declare the application's database before connecting this workload.");
    if (edit.enabled) planPlacement(root, state, { target: target.ref, vpc: database.networkId, subnet: target.kind === "lambda" && target.placement.kind === "vpc" && target.placement.subnet === "isolated" ? "isolated" : "private" }, overrides);
  }
  if (edit.connection === "userPool" && (target.role === "agent" || target.role === "tool")) throw new EditError(422, "Agents and tools receive their pool through auth:true. Select the authenticated wrapper in source.");
  const destination = edit.destination ? models.flatMap(model => model.targets).find(target => target.ref === edit.destination) : undefined;
  const expected = edit.connection === "runsTask" ? "task" : edit.connection === "startsWorkflow" ? "workflow" : edit.connection === "invokesAgent" ? "agent" : "lambda";
  if (!simple && (!destination || destination.kind !== expected || edit.connection === "tool" && (target.kind !== "agent" || destination.role !== "tool"))) throw new EditError(422, "Choose a compatible declared destination.");
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides);
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const parsed = parseOrigin(origin), entry = parsed && findEntry(located, parsed);
    if (!entry || !parsed) throw new EditError(422, "This connection's declaration is source-owned.");
    const file = assertWritable(root, toRelative(root, entry.file));
    let text = files.text(file);
    const value = entryValue(files, entry), declaration = value && declarationObject(value, parsed.section, parsed.chain);
    if (!declaration || "unsupported" in declaration) throw new EditError(422, "This computed declaration must be edited in source.");
    const source = files.get(file);
    const keys = simple ? [edit.connection] : edit.connection === "tool" ? ["tools"] : ["cloud", "bindings"];
    const position = propertyAt(declaration.object, keys);
    if (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property) throw new EditError(422, "This connection uses computed source. Open its declaration to preserve the authored expression.");
    if (simple) {
      const property = position.property;
      if (property && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(property.initializer.kind)) throw new EditError(422, "This setting is computed. Edit it in source.");
      if (property && hasComments(property.getText(source))) throw new EditError(422, "This connection contains comments. Edit it in source to preserve them.");
      if (!edit.enabled && property) text = removeProperty(text, source, position.container, property);
      else if (edit.enabled && property) text = text.slice(0, property.initializer.getStart(source)) + "true" + text.slice(property.initializer.end);
      else if (edit.enabled) text = insertExpression(text, source, position.container, position.missing, "true");
    } else {
      const array = position.property && unwrap(position.property.initializer);
      if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement) || hasComments(array.getText(source)))) throw new EditError(422, "This connection list is computed or commented. Edit it in source.");
      let helper = edit.connection;
      const aliases = new Set<string>([helper]);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@repo/framework/config" || statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if ((item.propertyName?.text ?? item.name.text) === helper) { aliases.add(item.name.text); helper = item.name.text as typeof helper; }
      }
      const items = array && ts.isArrayLiteralExpression(array) ? [...array.elements] : [];
      const matches = (item: ts.Expression) => edit.connection === "tool" ? ts.isStringLiteral(item) && item.text === destination!.id : ts.isCallExpression(item) && ts.isIdentifier(item.expression) && aliases.has(item.expression.text) && !!item.arguments[0] && ts.isStringLiteral(item.arguments[0]) && item.arguments[0].text === destination!.id;
      const exists = items.some(matches);
      if (exists === edit.enabled) throw new EditError(422, edit.enabled ? "This connection already exists." : "This connection is not declared here.");
      const expression = edit.connection === "tool" ? JSON.stringify(destination!.id) : `${helper}(${JSON.stringify(destination!.id)})`;
      const retained = items.filter(item => edit.enabled || !matches(item)).map(item => item.getText(source));
      if (edit.enabled) retained.push(expression);
      const next = `[${retained.join(", ")}]`;
      if (array) text = text.slice(0, array.getStart(source)) + next + text.slice(array.end);
      else text = insertExpression(text, source, position.container, position.missing, next);
      if (edit.enabled && edit.connection !== "tool" && !source.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(item => item.name.text === helper))) {
        let alias = `studio${edit.connection[0]!.toUpperCase()}${edit.connection.slice(1)}`;
        for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(text); suffix++) alias += suffix;
        text = text.replace(expression, `${alias}(${JSON.stringify(destination!.id)})`);
        text = `import { ${edit.connection} as ${alias} } from "@repo/framework/config";\n${text}`;
      }
    }
    overrides.set(file, text);
  }
}

