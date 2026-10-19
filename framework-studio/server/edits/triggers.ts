import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { Snapshot } from "../../shared/model";
import type { TriggerBinding } from "../../shared/triggers";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue } from "../source";
import { declarationObject, findProperty, unwrap } from "../source/syntax";
import { assertWritable } from "../files";
import { insertExpression } from "../resources-source";
import { triggerTiming, triggerUnavailable } from "../../shared/trigger-availability";
import { validateTrigger } from "@repo/framework/config";

export function validateTriggerBindings(snapshot: Snapshot, event: string, bindings: readonly TriggerBinding[]): void {
  if (bindings.length > 100 || !Object.values(snapshot.models).every((model) => model.targets.some((target) => target.id === event && target.role === "event"))) throw new Error("Select an existing event Lambda in both graphs.");
  for (const binding of bindings) {
    if (typeof binding.id !== "string" || typeof binding.adapter !== "string" || typeof binding.resource !== "string" || typeof binding.accepts !== "string" || !binding.options || Array.isArray(binding.options) || typeof binding.options !== "object") throw new Error("A trigger names an adapter, stable id, resource, handler contract and options.");
    const reason = triggerUnavailable(snapshot, binding.resource, binding.adapter, binding.options);
    if (reason) throw new Error(reason);
    const metadata = snapshot.models.dev.triggerAdapters?.find((item) => item.kind === binding.adapter);
    if (Object.keys(binding.options).some((name) => !metadata?.fields.some((field) => field.name === name))) throw new Error("Unsupported trigger option.");
    const path = snapshot.models.dev.resources.find((item) => item.id === binding.resource)?.path;
    // The adapter's own pure validator, exactly as the written declaration will run it.
    validateTrigger({ $trigger: "@repo/framework/trigger", adapter: binding.adapter, id: binding.id, accepts: binding.accepts, resource: { $cdk: "@repo/framework/cdk-resource", path: path ?? [], optional: false } as never, options: binding.options as never });
    const timing = triggerTiming(snapshot, { ...binding, event });
    if (timing.problem) throw new Error(timing.problem);
    for (const native of snapshot.source.cdkLinks.edges.filter((edge) => edge.relation === "trigger" && edge.from === binding.resource)) {
      if (metadata?.exclusive && native.label === binding.options[metadata.exclusive]) throw new Error(`${native.label} is occupied by native wiring; review required.`);
      if (metadata?.onePerEvent && native.to === `lambda:${event}`) throw new Error("This event already has a native source binding; review required.");
    }
    for (const field of metadata?.fields.filter((field) => field.kind === "resource") ?? []) {
      const reference = binding.options[field.name] as { readonly path?: readonly string[] } | undefined;
      if (!reference) continue;
      const candidate = snapshot.source.triggerCapabilities?.find((item) => item.resource === `resource:${reference.path?.join(".")}`);
      if (!candidate || !field.resourceType || !candidate.canonicalTypes.includes(`${field.resourceType.module}:${field.resourceType.name}`) || (field.resourceType.owned && !candidate.owned)) throw new Error(`${field.label}: choose a compatible${field.resourceType?.owned ? " owned" : ""} public resource.`);
      if (Object.values(snapshot.models).some((model) => model.resources.find((item) => item.id === candidate.resource)?.absent !== false)) throw new Error(`${field.label} is missing in one graph.`);
      if (Object.values(snapshot.models).some((model) => model.resources.find((item) => item.id === candidate.stack)?.stackUsage?.status === "unreferenced")) throw new Error(`${field.label}: stack is not added to the CDK app.`);
    }
  }
}

export function planTriggers(root: string, state: StudioState, event: string, bindings: readonly TriggerBinding[], files: SourceFiles): { file: string; after: string } {
  validateTriggerBindings(state.snapshot, event, bindings);
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const entry = located.sections.events.find((entry) => entry.key === event);
  if (!entry) throw new Error("The event declaration could not be located.");
  const file = assertWritable(root, path.relative(root, entry.file));
  const source = files.get(file), value = entryValue(files, entry);
  const declaration = value && declarationObject(value, "events", []);
  if (!declaration || "unsupported" in declaration) throw new Error("Triggers require a literal event declaration.");
  const position = findProperty(declaration.object, "triggers");
  if (position.spread || (position.property && !ts.isPropertyAssignment(position.property))) throw new Error("Computed or spread triggers require source review.");
  const property = position.property as ts.PropertyAssignment | undefined;
  if (property && !ts.isArrayLiteralExpression(unwrap(property.initializer))) throw new Error("Computed trigger arrays require source review.");
  if (property) {
    const array = unwrap(property.initializer) as ts.ArrayLiteralExpression;
    const imports = new Set<string>();
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@repo/framework/config") {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "trigger") imports.add(item.name.text);
    }
    if (array.elements.some((item) => { const value = unwrap(item); return !ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression) || !ts.isIdentifier(value.expression.expression) || !imports.has(value.expression.expression.text); })) throw new Error("Computed or spread trigger entries require source review.");
  }
  if (property) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, property.getText(source));
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) throw new Error("This trigger list contains comments; edit it in source to preserve them.");
  }
  const text = files.text(file);
  const names = new Set<string>();
  const collect = (node: ts.Node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collect); };
  collect(source);
  const alias = (prefix: string) => { let name = prefix, index = 1; while (names.has(name)) name = `${prefix}${index++}`; names.add(name); return name; };
  const catalogFile = [...state.built.catalog.values()][0]?.value.file;
  if (!catalogFile) throw new Error("The resource catalog module could not be located.");
  let specifier = path.relative(path.dirname(file), path.join(root, catalogFile)).replaceAll("\\", "/").replace(/\.ts$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const imported = (module: string, name: string) => {
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module && !statement.importClause?.isTypeOnly) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const element = bindings.elements.find((item) => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === name);
        if (element) return element.name.text;
      }
    }
    return undefined;
  };
  const existingTrigger = imported("@repo/framework/config", "trigger"), existingResources = imported(specifier, "resources");
  const triggerAlias = existingTrigger ?? alias("studioTrigger"), resourcesAlias = existingResources ?? alias("studioResources");
  const reference = (resource: string): string => {
    const model = state.snapshot.models.dev.resources.find((item) => item.id === resource);
    if (!model) throw new Error("The public catalog resource could not be located.");
    return resourcesAlias + model.path.map((part) => /^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join("");
  };
  const render = (value: unknown): string => {
    if (value && typeof value === "object" && "$cdk" in value && "path" in value) return reference(`resource:${(value as { path: string[] }).path.join(".")}`);
    if (Array.isArray(value)) return `[${value.map(render).join(", ")}]`;
    if (value && typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${key === "__proto__" ? `[${JSON.stringify(key)}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${render(item)}`).join(", ")} }`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Trigger options contain a non-JSON value.");
    return encoded;
  };
  const expression = `[${bindings.length ? "\n" + bindings.map((binding) => `      ${triggerAlias}.adapter(${JSON.stringify(binding.adapter)}, ${reference(binding.resource)}, ${render({ id: binding.id, accepts: binding.accepts, ...binding.options })})`).join(",\n") + ",\n    " : ""}]`;
  let after = property ? text.slice(0, property.initializer.getStart(source)) + expression + text.slice(property.initializer.end) : insertExpression(text, source, declaration.object, ["triggers"], expression);
  if (bindings.length) after = `${existingTrigger ? "" : `import { trigger as ${triggerAlias} } from "@repo/framework/config";\n`}${existingResources ? "" : `import { resources as ${resourcesAlias} } from ${JSON.stringify(specifier)};\n`}${after}`;
  return { file, after };
}
