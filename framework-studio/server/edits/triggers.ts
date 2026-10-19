import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { Snapshot } from "../../shared/model";
import type { FailureDestinationSettings, TriggerBinding } from "../../shared/triggers";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue } from "../source";
import { declarationObject, findProperty, unwrap } from "../source/syntax";
import { assertWritable } from "../files";
import { insertExpression } from "../resources-source";
import { blockingProblems, triggerProblems, triggerTiming, triggerUnavailable } from "../../shared/trigger-availability";
import { validateFailureDestination, validateTrigger } from "@repo/framework/config";
import { removeProperty } from "./splice";
import { pruneImports } from "./source-cleanup";

export function validateTriggerBindings(snapshot: Snapshot, event: string, bindings: readonly TriggerBinding[]): void {
  if (bindings.length > 100 || !Object.values(snapshot.models).every((model) => model.targets.some((target) => target.id === event && target.role === "event"))) throw new Error("Select an existing event Lambda in both graphs.");
  for (const binding of bindings) {
    if (typeof binding.id !== "string" || typeof binding.adapter !== "string" || typeof binding.resource !== "string" || typeof binding.accepts !== "string" || !binding.options || Array.isArray(binding.options) || typeof binding.options !== "object") throw new Error("A trigger names an adapter, stable id, resource, handler contract and options.");
    const metadata = snapshot.models.dev.triggerAdapters?.find((item) => item.kind === binding.adapter);
    if (metadata?.resourceless) {
      if (binding.resource) throw new Error(`A ${metadata.label} trigger takes no resource.`);
    } else {
      const reason = triggerUnavailable(snapshot, binding.resource, binding.adapter, binding.options);
      if (reason) throw new Error(reason);
    }
    if (Object.keys(binding.options).some((name) => !metadata?.fields.some((field) => field.name === name))) throw new Error("Unsupported trigger option.");
    const path = snapshot.models.dev.resources.find((item) => item.id === binding.resource)?.path;
    // The adapter's own pure validator, exactly as the written declaration will run it.
    validateTrigger({ $trigger: "@repo/framework/trigger", adapter: binding.adapter, id: binding.id, accepts: binding.accepts, ...(metadata?.resourceless ? {} : { resource: { $cdk: "@repo/framework/cdk-resource", path: path ?? [], optional: false } as never }), options: binding.options as never });
    const timing = metadata?.resourceless ? {} : triggerTiming(snapshot, { ...binding, event });
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
    }
    // The form's checklist, so nothing the form would refuse reaches source: local replay, duplicates in this list.
    const problem = blockingProblems(triggerProblems(snapshot, { ...binding, event }, bindings.filter((item) => item !== binding)))[0];
    if (problem) throw new Error(problem.message);
  }
}

const FAILURE_TYPES = ["aws-sqs:IQueue", "aws-sns:ITopic"];

/** A standard catalog queue or topic in both graphs, with the framework's own bounds. */
export function validateFailureDestinationEdit(snapshot: Snapshot, event: string, value: FailureDestinationSettings | null): void {
  if (!Object.values(snapshot.models).every((model) => model.targets.some((target) => target.id === event && target.role === "event"))) throw new Error("Select an existing event Lambda in both graphs.");
  if (value === null) return;
  if (typeof value.destination !== "string" || Object.keys(value).some((key) => !["destination", "retryAttempts", "maxEventAgeSeconds"].includes(key))) throw new Error("A failure destination names a queue or topic, and optional retries and maximum age.");
  const capability = snapshot.source.triggerCapabilities?.find((item) => item.resource === value.destination);
  if (!capability || !capability.canonicalTypes.some((type) => FAILURE_TYPES.includes(type))) throw new Error("Choose an SQS queue or SNS topic from your stacks.");
  if (capability.facts?.fifo === true || capability.facts?.fifoName === true) throw new Error("A failure destination is a standard queue or topic, not FIFO.");
  const resource = snapshot.models.dev.resources.find((item) => item.id === value.destination);
  if (!resource || Object.values(snapshot.models).some((model) => model.resources.find((item) => item.id === value.destination)?.absent !== false)) throw new Error("The failure destination is missing in one graph.");
  validateFailureDestination({ destination: { $cdk: "@repo/framework/cdk-resource", path: resource.path, optional: false }, ...(value.retryAttempts !== undefined ? { retryAttempts: value.retryAttempts } : {}), ...(value.maxEventAgeSeconds !== undefined ? { maxEventAgeSeconds: value.maxEventAgeSeconds } : {}) });
}

/** Writes or removes `onFailure` on one literal event declaration. */
export function planFailureDestination(root: string, state: StudioState, event: string, value: FailureDestinationSettings | null, files: SourceFiles): { file: string; after: string } {
  validateFailureDestinationEdit(state.snapshot, event, value);
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const entry = located.sections.events.find((entry) => entry.key === event);
  if (!entry) throw new Error("The event declaration could not be located.");
  const file = assertWritable(root, path.relative(root, entry.file));
  const source = files.get(file), declared = entryValue(files, entry);
  const declaration = declared && declarationObject(declared, "events", []);
  if (!declaration || "unsupported" in declaration) throw new Error("A failure destination requires a literal event declaration.");
  const position = findProperty(declaration.object, "onFailure");
  if (position.spread || (position.property && !ts.isPropertyAssignment(position.property))) throw new Error("A computed onFailure requires source review.");
  const property = position.property as ts.PropertyAssignment | undefined;
  if (property) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, property.getText(source));
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) throw new Error("This onFailure has comments; edit it in source to preserve them.");
  }
  const text = files.text(file);
  if (value === null) {
    if (!property) throw new Error("This event has no failure destination to remove.");
    return { file, after: pruneImports(file, text, removeProperty(text, source, declaration.object, property)) };
  }
  const catalogFile = [...state.built.catalog.values()][0]?.value.file;
  if (!catalogFile) throw new Error("The resource catalog module could not be located.");
  let specifier = path.relative(path.dirname(file), path.join(root, catalogFile)).replaceAll("\\", "/").replace(/\.ts$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  let existing: string | undefined;
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === specifier && !statement.importClause?.isTypeOnly) {
    const bindings = statement.importClause?.namedBindings;
    const element = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((item) => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "resources") : undefined;
    if (element) existing = element.name.text;
  }
  const names = new Set<string>();
  const collect = (node: ts.Node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collect); };
  collect(source);
  let alias = existing ?? "studioResources";
  for (let index = 1; !existing && names.has(alias); index++) alias = `studioResources${index}`;
  const resource = state.snapshot.models.dev.resources.find((item) => item.id === value.destination)!;
  const reference = alias + resource.path.map((part) => /^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join("");
  const expression = `{ destination: ${reference}${value.retryAttempts !== undefined ? `, retryAttempts: ${value.retryAttempts}` : ""}${value.maxEventAgeSeconds !== undefined ? `, maxEventAgeSeconds: ${value.maxEventAgeSeconds}` : ""} }`;
  let after = property ? text.slice(0, property.initializer.getStart(source)) + expression + text.slice(property.initializer.end) : insertExpression(text, source, declaration.object, ["onFailure"], expression);
  if (!existing) after = `import { resources as ${alias} } from ${JSON.stringify(specifier)};\n${after}`;
  return { file, after: pruneImports(file, text, after) };
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
  // A resourceless adapter is called by name, since it has no resource to pass.
  const call = (binding: TriggerBinding) => state.snapshot.models.dev.triggerAdapters?.find((item) => item.kind === binding.adapter)?.resourceless
    ? `${triggerAlias}.${binding.adapter}(${render({ id: binding.id, accepts: binding.accepts, ...binding.options })})`
    : `${triggerAlias}.adapter(${JSON.stringify(binding.adapter)}, ${reference(binding.resource)}, ${render({ id: binding.id, accepts: binding.accepts, ...binding.options })})`;
  const expression = `[${bindings.length ? "\n" + bindings.map((binding) => `      ${call(binding)}`).join(",\n") + ",\n    " : ""}]`;
  // No triggers left: remove the property itself, and any import only it needed.
  if (!bindings.length) {
    if (!property) throw new Error("This event has no triggers to remove.");
    return { file, after: pruneImports(file, text, removeProperty(text, source, declaration.object, property)) };
  }
  let after = property ? text.slice(0, property.initializer.getStart(source)) + expression + text.slice(property.initializer.end) : insertExpression(text, source, declaration.object, ["triggers"], expression);
  const usesResources = new RegExp(`\\b${resourcesAlias.replace(/\$/g, "\\$")}[.[]`).test(expression);
  after = `${existingTrigger ? "" : `import { trigger as ${triggerAlias} } from "@repo/framework/config";\n`}${existingResources || !usesResources ? "" : `import { resources as ${resourcesAlias} } from ${JSON.stringify(specifier)};\n`}${after}`;
  return { file, after: pruneImports(file, text, after) };
}
