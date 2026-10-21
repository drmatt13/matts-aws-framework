import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { defineNetwork, type InterfaceEndpointService } from "@repo/framework/config";
import { readCreationRequest, CreationValidationError, type CreationRequest } from "../../shared/creation";
import { DESCRIPTION_FILE } from "../../shared/descriptions";
import { rewriteDescription } from "../descriptions";
import { toRelative } from "../files";
import { insertExpression } from "../resources-source";
import type { StudioState } from "../snapshot";
import { findProperty, parse, unwrap, declarationObject, expressionAt, propertyAt } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { EditError } from "./io";
import { isCreationGeneratedFile } from "./creation-generation";

export interface CreationExpectation { readonly select: string; readonly targets: readonly string[]; readonly resources: readonly string[]; readonly routes: readonly string[]; readonly kind: CreationRequest["kind"]; readonly network?: { readonly cidr: string; readonly zones: number; readonly natGateway: boolean; readonly egressOnlyInternetGateway: boolean; readonly gatewayEndpoints: readonly string[]; readonly interfaceEndpoints: readonly string[] } }
export interface CreationSource { readonly overrides: ReadonlyMap<string, string>; readonly before: ReadonlyMap<string, string | null>; readonly expected: CreationExpectation; readonly impact: readonly string[] }
const q = JSON.stringify;
function refuse(field: string, message: string): never { throw new CreationValidationError(field, message); }

/** Fixed creator-owned destinations, with no traversal or symlink components.
 * This authority is used only for a server-generated creation batch. */
export function assertCreationFile(root: string, relative: string): string {
  const allowed = isCreationGeneratedFile(relative) || relative === "framework.config.ts" || /^framework-config\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(relative)
    || /^cdk-app\/lambda_functions\/(?:http_functions|event_functions|websocket_functions)\/[a-z][a-z0-9-]*\/index\.ts$/.test(relative)
    || /^cdk-app\/ecs_containers\/(?:tasks|services)\/[a-z][a-z0-9-]*\/(?:index\.mjs|Dockerfile|package\.json)$/.test(relative)
    || /^agents\/[a-z][a-z0-9-]*\/(?:(?:index|contract)\.ts|package\.json|tsconfig\.json)$/.test(relative)
    || /^cdk-app\/lib\/app\/[a-z][a-z0-9-]*-stack\.ts$/.test(relative)
    || relative === "cdk-app/bin/cdk-app.ts" || /^cdk-app\/\.env\.(?:dev|prod)\.template$/.test(relative);
  if (!allowed || relative.split("/").some((part) => part === ".." || part === ".") || relative.includes("\\")) throw new EditError(422, "This is not a creator-owned source path.");
  let current = realpathSync(root);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    // lstat detects dangling symlinks too, unlike existsSync.
    try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "Creation cannot write through symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path.resolve(root, relative);
}

function objectCall(file: string, text: string, name: string) {
  const source = parse(file, text);
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      const argument = node.arguments[0] && unwrap(node.arguments[0]);
      if (argument && ts.isObjectLiteralExpression(argument)) found.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new EditError(422, `Creation requires one literal ${name} declaration in ${file}.`);
  return { source, object: found[0]! };
}
/** Only new modules are printed. Existing authored files always use splices. */
function formatNewModule(file: string, text: string): string {
  const transformed = ts.transform(parse(file, text), [(context) => (source) => {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context);
      return ts.isObjectLiteralExpression(visited) ? ts.factory.createObjectLiteralExpression(visited.properties, true) : visited;
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  }]);
  try {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed.transformed[0]!)
      .replace(/^( +)/gm, (indent) => " ".repeat(Math.ceil(indent.length / 2)));
  } finally { transformed.dispose(); }
}
function addImport(text: string, statement: string, name: string): string {
  const source = parse("imports.ts", text);
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) && node.name && ts.isIdentifier(node.name)) identifiers.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (identifiers.has(name)) throw new EditError(422, `The generated import ${name} conflicts with an existing source identifier.`);
  return statement + "\n" + text;
}
function setProperty(file: string, text: string, object: ts.ObjectLiteralExpression, source: ts.SourceFile, key: string, expression: string): string {
  const found = findProperty(object, key);
  if (found.spread || (found.property && !ts.isPropertyAssignment(found.property))) throw new EditError(422, `Edit computed ${key} in ${file} in your editor first.`);
  if (!found.property) return insertExpression(text, source, object, [key], expression);
  const node = found.property.initializer;
  // A configuration flow may replace literal settings, never custom expressions.
  const literal = (value: ts.Expression): boolean => {
    const item = unwrap(value);
    if (ts.isObjectLiteralExpression(item)) return item.properties.every((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && literal(property.initializer));
    if (ts.isArrayLiteralExpression(item)) return item.elements.every((element) => ts.isExpression(element) && literal(element));
    return [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(item.kind);
  };
  if (!literal(node)) throw new EditError(422, `The ${key} setting is computed. Edit it in source.`);
  return text.slice(0, node.getStart(source)) + expression + text.slice(node.end);
}

export function planCreation(root: string, state: StudioState, raw: CreationRequest): CreationSource {
  const request = readCreationRequest(raw);
  const overrides = new Map<string, string>();
  const before = new Map<string, string | null>();
  const read = (relative: string) => overrides.get(path.join(root, relative)) ?? readFileSync(path.join(root, relative), "utf8");
  const put = (relative: string, text: string) => {
    const file = assertCreationFile(root, relative);
    if (!before.has(file)) before.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
    overrides.set(file, text);
  };
  const fresh = (relative: string, text: string) => {
    const file = assertCreationFile(root, relative);
    if (existsSync(file) || overrides.has(file)) refuse("id", "A source file already exists for this identity. Choose another identifier.");
    put(relative, text);
  };
  const models = Object.values(state.snapshot.models);
  const targetExists = (id: string) => models.some((model) => model.targets.some((target) => target.id === id));
  const expected: { select: string; targets: string[]; resources: string[]; routes: string[]; kind: CreationRequest["kind"]; network?: CreationExpectation["network"] } = { select: "", targets: [], resources: [], routes: [], kind: request.kind };
  const impact = ["Creates the reviewed source as one undoable operation. AWS deployment and secret provisioning remain separate actions."];
  function register(section: string, id: string, expression: string, imports = "") {
    const relative = `framework-config/${section.toLowerCase()}/${id}.ts`;
    const symbol = `studio${id.replace(/(^|-)([a-z0-9])/g, (_match, _prefix, letter: string) => letter.toUpperCase())}${section[0]!.toUpperCase() + section.slice(1)}`;
    const types: Record<string, string> = { http: "HttpSection", webSocket: "WebSocketSection", events: "EventsSection", workflows: "WorkflowsSection", services: "ServicesSection", tasks: "TasksSection", agents: "AgentsSection" };
    const sectionType = section === "webSocket" && (request.kind === "function" || request.kind === "route")
      ? `Pick<WebSocketSection, ${q(request.path)}>` : types[section];
    fresh(relative, formatNewModule(relative, `${imports}import type { ${types[section]} } from "../contracts";\n\nexport const ${symbol} = ${expression} satisfies ${sectionType};\n`));
    let text = read("framework.config.ts");
    const { source, object } = objectCall("framework.config.ts", text, "defineFrameworkConfig");
    const prop = findProperty(object, section);
    if (prop.spread || (prop.property && !ts.isPropertyAssignment(prop.property))) throw new EditError(422, "Compose workload sections as literal arrays before creating workloads.");
    if (prop.property) {
      const array = unwrap(prop.property.initializer);
      if (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement)) throw new EditError(422, "Compose workload sections as literal arrays before creating workloads.");
      const end = array.end - 1;
      text = text.slice(0, end) + `${array.elements.length && !array.elements.hasTrailingComma ? "," : ""} ${symbol}` + text.slice(end);
    } else text = insertExpression(text, source, object, [section], `[${symbol}]`);
    text = addImport(text, `import { ${symbol} } from ${q("./" + relative.replace(/\.ts$/, ""))};`, symbol);
    put("framework.config.ts", text);
  }
  function catalog(keys: string[], expression: string) {
    const relative = "framework-config/resources.ts";
    const text = read(relative);
    const { source, object } = objectCall(relative, text, "defineResources");
    let container = object;
    for (const [index, key] of keys.entries()) {
      const found = findProperty(container, key);
      if (container.properties.some(ts.isSpreadAssignment)) refuse("id", "The catalog contains a spread; make this declaration explicit in source first.");
      if (!found.property) { put(relative, insertExpression(text, source, container, keys.slice(index), expression)); return; }
      if (index === keys.length - 1) refuse("id", "This catalog identity already exists.");
      const inner = ts.isPropertyAssignment(found.property) && unwrap(found.property.initializer);
      if (!inner || !ts.isObjectLiteralExpression(inner)) refuse("group", "This catalog group is already used by another resource.");
      container = inner as ts.ObjectLiteralExpression;
    }
  }
  function binding(request: { bindingResource: string; bindingVariable: string }, container: boolean): string {
    if (!request.bindingResource) return "";
    const resource = models.flatMap((model) => model.resources).find((resource) => resource.id === request.bindingResource);
    if (!resource || !["input", "secret"].includes(resource.kind)) return refuse("bindingResource", "Select a declared input parameter or secret.");
    const reference = "resources" + resource.path.map((part) => `[${q(part)}]`).join("");
    return resource.kind === "secret" ? container
      ? `secrets: { ${q(request.bindingVariable)}: ${reference}.value },`
      : `environment: { ${q(request.bindingVariable)}: ${reference}.arn },`
      : `environment: { ${q(request.bindingVariable)}: ${reference} },`;
  }
  const bindingImport = 'import { resources } from "../resources";\n';
  function scopeCatalog(expression: string, scope: "both" | "dev" | "prod"): string {
    if (scope === "both") return expression;
    let text = read("framework-config/resources.ts");
    const source = parse("framework-config/resources.ts", text);
    let alias: string | undefined;
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@repo/framework/config/source" || statement.importClause?.isTypeOnly) continue;
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) alias = names.elements.find((item) => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "PROD_DEPLOYMENT")?.name.text;
      if (alias) break;
    }
    if (!alias) {
      alias = "studioProdDeployment";
      for (let index = 2; new RegExp(`\\b${alias}\\b`).test(text); index++) alias = `studioProdDeployment${index}`;
      text = addImport(text, `import { PROD_DEPLOYMENT as ${alias} } from "@repo/framework/config/source";`, alias);
      put("framework-config/resources.ts", text);
    }
    return `${scope === "dev" ? "!" : ""}${alias} ? ${expression} : undefined`;
  }
  const uniqueTarget = (id: string) => { if (targetExists(id)) refuse("id", "This workload identifier is already declared."); };
  if (request.kind === "input" || request.kind === "secret") {
    const keys = [...(request.group ? [request.group] : []), request.id];
    if (models.some((model) => model.resources.some((resource) => resource.fromEnv === request.envName))) refuse("envName", "This environment variable is already declared in the catalog.");
    let expression = `resource.${request.kind === "secret" ? "secret" : "fromEnv"}(${q(request.envName)})`;
    if (request.required) expression += ".required()";
    if (request.kind === "input") {
      if (request.choices.length) expression += `.enum(${request.choices.map((choice) => q(choice)).join(", ")})`;
      if (request.defaultValue) expression += `.default(${q(request.defaultValue)})`;
    }
    catalog(keys, expression);
    expected.select = `resource:${keys.join(".")}`; expected.resources.push(expected.select);
    if (request.consumer) {
      const target = models.flatMap((model) => model.targets).find((target) => target.ref === request.consumer);
      const origin = target?.origins[0] && parseOrigin(target.origins[0]);
      const located = origin && origin.section !== "defaults" && state.built.located?.sections[origin.section].find((entry) => entry.key === origin.key);
      if (!target || !located || !origin) refuse("consumer", "Select an existing workload with an explicit section declaration.");
      const relative = toRelative(root, located.file);
      let text = read(relative);
      const source = parse(relative, text);
      const value = expressionAt(source, located.valueSpan.start, located.valueSpan.end);
      const declaration = value && declarationObject(value, origin.section, origin.chain);
      if (!declaration || "unsupported" in declaration) refuse("consumer", "This consumer is computed. Bind it in source.");
      const container = target.kind === "service" || target.kind === "task";
      const property = container && request.kind === "secret" ? "secrets" : "environment";
      const position = propertyAt(declaration.object, [property, request.consumerVariable]);
      if (position.property || !["absent"].includes(position.editability.kind)) refuse("consumerVariable", "This environment variable already exists or comes from a computed mapping.");
      let specifier = path.relative(path.dirname(located.file), path.join(root, "framework-config/resources")).replaceAll("\\", "/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      let alias: string | undefined;
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly || !statement.moduleSpecifier.text.startsWith(".")) continue;
        const module = path.resolve(path.dirname(located.file), statement.moduleSpecifier.text.replace(/\.(?:js|ts)$/, ""));
        if (module !== path.join(root, "framework-config/resources")) continue;
        const names = statement.importClause?.namedBindings;
        if (names && ts.isNamedImports(names)) alias = names.elements.find((item) => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "resources")?.name.text;
        if (alias) break;
      }
      const imported = !!alias;
      if (!alias) {
        alias = "studioCreationResources";
        for (let index = 2; new RegExp(`\\b${alias}\\b`).test(text); index++) alias = `studioCreationResources${index}`;
      }
      const reference = `${alias}${keys.map((key) => `[${q(key)}]`).join("")}${request.kind === "secret" ? container ? ".value" : ".arn" : ""}`;
      text = insertExpression(text, source, position.container, position.missing, reference);
      put(relative, imported ? text : addImport(text, `import { resources as ${alias} } from ${q(specifier)};`, alias));
      impact.push(`Connects ${expected.select} to ${target.ref} as ${request.consumerVariable}, using the framework's resource delivery and permission resolution.`);
    }
    for (const mode of ["dev", "prod"]) {
      const file = `cdk-app/.env.${mode}.template`;
      if (existsSync(path.join(root, file)) && !new RegExp(`^\\s*(?:#\\s*)?${request.envName}\\s*=`, "m").test(read(file))) put(file, read(file).replace(/\s*$/, "\n") + `# ${request.envName}=\n`);
    }
    impact.push("Adds the catalog declaration and commented template keys. Authored environment files are never written. Inputs are strings; secret values are accepted only by the separate protected input lifecycle.");
  } else if (request.kind === "function" || request.kind === "route") {
    const section = request.category === "event" ? "events" : request.category === "http" ? "http" : "webSocket";
    const routeId = request.category === "http" ? `route:http:${request.path}` : `route:ws:${request.path}`;
    let declaration: string;
    let target = `lambda:${request.id}`;
    if (request.kind === "route" && request.existingTarget) {
      const existing = models[0]!.targets.find((target) => target.ref === request.existingTarget && target.role === request.category);
      if (!existing) return refuse("existingTarget", "Choose a routed Lambda of the same category.");
      const location = state.snapshot.source.entities[existing.ref]?.value;
      if (!location) throw new EditError(422, "The existing function's declaration could not be located.");
      const text = read(location.file);
      declaration = text.slice(location.start, location.end);
      const wrapper = `const entry = ${declaration};`;
      const parsed = parse("entry.ts", wrapper);
      const node = unwrap(parsed.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!.initializer!);
      if (!ts.isObjectLiteralExpression(node) || node.properties.some(ts.isSpreadAssignment)) throw new EditError(422, "Reuse requires an explicit routed Lambda declaration.");
      if (request.category === "http") {
        const rewritten = setProperty("entry.ts", wrapper, node, parsed, "methods", request.method === "*" ? q("*") : `[${q(request.method)}]`);
        const next = parse("entry.ts", rewritten);
        declaration = next.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!.initializer!.getText(next);
      }
      const source = parse(location.file, text);
      const value = expressionAt(source, location.start, location.end);
      const owner = value?.parent;
      const sectionObject = owner && ts.isPropertyAssignment(owner) ? owner.parent : undefined;
      if (!sectionObject || !ts.isObjectLiteralExpression(sectionObject) || sectionObject.properties.some(ts.isSpreadAssignment)) throw new EditError(422, "Reuse requires a literal section object, so its existing imports and local references can be preserved.");
      if (findProperty(sectionObject, request.path).property) return refuse("path", "This route key is already declared. Edit its methods in the existing declaration.");
      put(location.file, insertExpression(text, source, sectionObject, [request.path], declaration));
      target = existing.ref;
      impact.push("The new route reuses the existing function's authentication and all target settings; its construct identity and handler are preserved.");
    } else {
      uniqueTarget(request.id);
      const group = request.category === "event" ? "event_functions" : request.category === "http" ? "http_functions" : "websocket_functions";
      const directory = `/lambda_functions/${group}/${request.id}`;
      const auth = request.category === "http" && request.auth;
      const handler = auth
        ? 'import { authenticated } from "@repo/framework/runtime/auth";\nimport { jsonResponse } from "@repo/framework/runtime/http";\n\nexport const lambdaHandler = authenticated(async (_event, session) => {\n  return jsonResponse(200, { message: "Ready", userId: session.payload.sub });\n});\n'
        : request.category === "http"
        ? 'import type { APIGatewayProxyEvent } from "aws-lambda";\nimport { jsonResponse } from "@repo/framework/runtime/http";\n\nexport const lambdaHandler = async (_event: APIGatewayProxyEvent) => jsonResponse(200, { message: "Ready" });\n'
        : request.category === "webSocket"
        ? 'import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";\n\nexport const lambdaHandler = async (_event: APIGatewayProxyWebsocketEventV2) => ({ statusCode: 200, body: "Ready" });\n'
        : 'export interface Input { readonly message?: string }\nexport const lambdaHandler = async (input: Input) => ({ message: input.message ?? "Ready" });\n';
      fresh(`cdk-app${directory}/index.ts`, handler);
      declaration = `{ directory: ${q(directory)}, ${request.category !== "event" ? `id: ${q(request.id)}, deploy: ${q(request.deploy)},` : ""} runtime: ${q(request.runtime)}, packaging: "zip", architecture: ${q(request.architecture)}, memorySize: ${request.memory}, timeoutSeconds: ${request.timeout}, subnet: ${q(request.subnet)}, ${request.category === "http" ? `methods: ${request.method === "*" ? q("*") : `[${q(request.method)}]`}, ${auth ? "auth: true, userPool: true," : ""}` : ""} ${binding(request, false)} }`;
      register(section, request.id, `{ ${q(request.category === "event" ? request.id : request.path)}: ${declaration} }`, request.bindingResource ? bindingImport : "");
      expected.targets.push(target);
      impact.push(`Handler: cdk-app${directory}/index.ts. TypeScript zip packaging; other runtimes and images remain source-authored.`);
    }
    if (request.category !== "event") expected.routes.push(routeId);
    expected.select = request.kind === "route" ? routeId : target;
  } else if (request.kind === "task" || request.kind === "service") {
    uniqueTarget(request.id);
    const service = request.kind === "service";
    const directory = `/ecs_containers/${service ? "services" : "tasks"}/${request.id}`;
    const code = service
      ? `import { createServer } from "node:http";\n\ncreateServer((request, response) => {\n  response.setHeader("content-type", "application/json");\n  response.end(JSON.stringify(request.url === "/health" ? { status: "ok" } : { message: "Ready" }));\n}).listen(${request.port}, "0.0.0.0");\n`
      : 'const input = JSON.parse(process.env.FRAMEWORK_TASK_INPUT ?? "{}");\nif (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task input must be an object.");\n// Implement run-to-completion work here. A zero exit code reports success.\nconsole.log("Task completed");\n';
    fresh(`cdk-app${directory}/index.mjs`, code);
    if (service) fresh(`cdk-app${directory}/package.json`, JSON.stringify({ name: `@repo/${request.id}`, private: true, scripts: { dev: "node --watch index.mjs" } }, null, 2) + "\n");
    fresh(`cdk-app${directory}/Dockerfile`, `FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY cdk-app${directory}/index.mjs ./index.mjs\nUSER node\n${service ? `EXPOSE ${request.port}\n` : ""}CMD ["node", "index.mjs"]\n`);
    register(service ? "services" : "tasks", request.id, `{ ${q(service ? request.path : request.id)}: { directory: ${q(directory)}, ${service ? `id: ${q(request.id)}, methods: "*", port: ${request.port}, healthCheckPath: "/health", ${request.auth ? "auth: true," : ""}` : ""} deploy: ${q(request.deploy)}, ${binding(request, true)} cloud: { cpu: ${request.cpu}, memoryMiB: ${request.memory}, architecture: ${q(request.architecture)}, subnet: ${q(request.subnet)} } } }`, request.bindingResource ? bindingImport : "");
    expected.select = `${request.kind}:${request.id}`; expected.targets.push(expected.select);
    if (service) expected.routes.push(`route:service:${request.path}`);
    if (service) impact.push("The new workspace requires rebuilding local development images with dev:containers. Source creation does not start containers.");
    impact.push("The Docker build context is the repository root. Images use the framework's existing build, labeling and reconciliation paths. The reviewed operation includes the generated local Compose projection.");
  } else if (request.kind === "workflow") {
    uniqueTarget(request.id);
    const calls = request.steps.map((ref, index) => {
      const target = models[0]!.targets.find((target) => target.ref === ref && (target.kind === "task" || target.role === "event"));
      if (!target) return refuse("steps", "Initial steps must name existing event Lambdas or container tasks.");
      return `const step${index} = ${target.kind === "task" ? "runTask" : "invokeLambda"}(${q(target.id)}, { payload: ${index ? `step${index - 1}.output` : "input"} });`;
    });
    const result = request.steps.length ? `step${request.steps.length - 1}.output` : "input";
    register("workflows", request.id, `{ ${q(request.id)}: workflow<Record<string, unknown>>(({ input }) => {\n    ${calls.join("\n    ")}\n    return ${calls.length ? `sequence(${calls.map((_call, index) => `step${index}`).join(", ")}, succeed(${result}))` : "succeed(input)"};\n  }, { deploy: ${q(request.deploy)}, timeoutSeconds: ${request.timeout} }) }`, 'import { workflow, succeed, sequence, invokeLambda, runTask } from "@repo/framework/config";\n');
    expected.select = `workflow:${request.id}`; expected.targets.push(expected.select);
  } else if (request.kind === "agent") {
    uniqueTarget(request.id);
    for (const tool of request.tools) if (!models[0]!.targets.some((target) => target.role === "tool" && target.id === tool)) refuse("tools", "Choose existing tool IDs.");
    const modelDependencies = JSON.parse(readFileSync(path.join(root, "packages/models/package.json"), "utf8")).dependencies as Record<string, string>;
    const frameworkDependencies = JSON.parse(readFileSync(path.join(root, "packages/framework/package.json"), "utf8")).dependencies as Record<string, string>;
    if (!modelDependencies["@langchain/core"] || !frameworkDependencies.zod) throw new EditError(422, "The shared agent model and contract dependencies could not be resolved.");
    fresh(`agents/${request.id}/package.json`, JSON.stringify({ name: `@repo/${request.id}`, private: true, scripts: { typecheck: "tsc --noEmit" }, dependencies: { "@repo/framework": "*", "@repo/models": "*", "@langchain/core": modelDependencies["@langchain/core"], zod: frameworkDependencies.zod } }, null, 2) + "\n");
    fresh(`agents/${request.id}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: ["node"], skipLibCheck: true }, include: ["*.ts"] }, null, 2) + "\n");
    fresh(`agents/${request.id}/contract.ts`, 'import { z } from "zod";\n\nexport const contract = {\n  request: z.object({ message: z.string().min(1).max(8000) }),\n  response: z.object({ text: z.string() }),\n} as const;\n');
    fresh(`agents/${request.id}/index.ts`, `import { agent } from "@repo/framework/runtime/agentcore";\nimport { getModel, extractText, toModelMessages } from "@repo/models";\nimport { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";\nimport { contract } from "./contract";\n\nexport const handler = agent(${q(request.id)}, contract).respond(async (input, { tools, signal }) => {\n  const base = await getModel();\n  const model = tools.specs.length ? base.bindTools(tools.specs.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))) : base;\n  const messages: BaseMessage[] = [new HumanMessage(input.message)];\n  for (let turn = 0; turn < 8; turn += 1) {\n    const response = await model.invoke(toModelMessages(messages), { signal });\n    messages.push(response);\n    if (!response.tool_calls?.length) return { text: extractText(response.content) };\n    for (const call of response.tool_calls) {\n      if (!call.id) throw new Error("The model returned a tool call without an ID.");\n      const result = await tools.call(call.name, call.args);\n      messages.push(new ToolMessage({ tool_call_id: call.id, content: JSON.stringify(result) }));\n    }\n  }\n  throw new Error("The agent reached its tool-call limit.");\n});\n`);
    const extra = binding(request, false);
    const extraEnv = extra ? extra.replace(/^environment: \{ /, "").replace(/ \},$/, "") : "";
    register("agents", request.id, `{ ${q(request.id)}: { directory: ${q(`/agents/${request.id}`)}, deploy: ${q(request.deploy)}, ${request.auth ? "auth: true," : ""} ${request.path ? `route: ${q(request.path)},` : ""} tools: ${q(request.tools)}, environment: { ...models.environment, ${extraEnv} }, cloud: { access: models.access, requirements: models.requirements } } }`, 'import { models } from "../models";\n' + (request.bindingResource ? bindingImport : ""));
    expected.select = `agent:${request.id}`; expected.targets.push(expected.select);
    impact.push("Uses @repo/models' shared provider selection, model IDs, secrets and IAM. The request is stateless; each invocation has the framework's existing session ownership and cancellation behavior.", "Adds a workspace with declared dependencies and a TypeScript check. Rebuild local development images for the new workspace before invoking it locally.");
  } else if (request.kind === "stack") {
    const classFile = request.className.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const file = `cdk-app/lib/app/${classFile}.ts`;
    catalog([request.id], scopeCatalog(`resource.stack<${request.className}>()`, request.scope));
    let text = read("framework-config/resources.ts");
    put("framework-config/resources.ts", addImport(text, `import type { ${request.className} } from ${q(`../cdk-app/lib/app/${classFile}`)};`, request.className));
    fresh(file, `import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib";\nimport { Queue } from "aws-cdk-lib/aws-sqs";\nimport type { Construct } from "constructs";\nimport { linkResources } from "../framework/framework-resources";\nimport { resources } from "../../../framework-config/resources";\n\nexport class ${request.className} extends Stack {\n  public readonly queue: Queue;\n\n  constructor(scope: Construct, id: string, props?: StackProps) {\n    super(scope, id, props);\n    this.queue = new Queue(this, "Queue", { enforceSSL: true });\n    new CfnOutput(this, "QueueUrl", { value: this.queue.queueUrl, exportName: this.stackName + ":QueueUrl" });\n    linkResources(this, resources.${request.id});\n  }\n}\n`);
    let app = read("cdk-app/bin/cdk-app.ts");
    const source = parse("cdk-app/bin/cdk-app.ts", app);
    const orchestration = source.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((node) => ts.isIdentifier(node.name) && node.name.text === "orchestration"));
    if (!orchestration) throw new EditError(422, "Cannot locate the application stack registration point before orchestration.");
    const at = orchestration.getFullStart();
    const registration = `\n${request.scope !== "both" ? `if (mode === ${q(request.scope)}) {\n  ` : ""}new ${request.className}(app, stackId(${q(request.className)}), { env: stackEnv });${request.scope !== "both" ? "\n}" : ""}\n`;
    app = app.slice(0, at) + registration + app.slice(at);
    put("cdk-app/bin/cdk-app.ts", addImport(app, `import { ${request.className} } from ${q(`../lib/app/${classFile}`)};`, request.className));
    expected.select = `resource:${request.id}`; expected.resources.push(expected.select);
    impact.push(`Instantiates ${request.className} in ${request.scope} deployment graphs, before orchestration, and exposes its typed queue through linkResources. The stack identity is deployment-prefixed.`);
  } else {
    try { defineNetwork({ cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: { s3: request.s3, dynamodb: request.dynamodb }, interfaceEndpoints: request.endpoints as InterfaceEndpointService[] }); }
    catch (error) {
      if (error instanceof Error && /interfaceEndpoints|endpoint service/.test(error.message)) return refuse("endpoints", "Choose recognized, distinct interface endpoint services, such as ecr.api or logs.");
      return refuse("cidr", "Use a private /16, such as 10.0.0.0/16, and two or three zones.");
    }
    const file = "framework-config/network.ts";
    let text: string;
    if (!existsSync(path.join(root, file))) {
      const rootText = read("framework.config.ts");
      const { source, object } = objectCall("framework.config.ts", rootText, "defineFrameworkConfig");
      if (findProperty(object, "network").property || findProperty(object, "network").spread) throw new EditError(422, "The network is declared elsewhere. Edit its existing declaration in source.");
      fresh(file, 'import { defineNetwork } from "@repo/framework/config";\nexport const network = defineNetwork({ cidr: "10.0.0.0/16", zones: 2 });\n');
      put("framework.config.ts", addImport(insertExpression(rootText, source, object, ["network"], "studioNetwork"), 'import { network as studioNetwork } from "./framework-config/network";', "studioNetwork"));
    }
    text = read(file);
    const entries = { cidr: q(request.cidr), zones: String(request.zones), natGateway: String(request.nat), egressOnlyInternetGateway: String(request.ipv6), gatewayEndpoints: `{ s3: ${request.s3}, dynamodb: ${request.dynamodb} }`, interfaceEndpoints: q(request.endpoints) };
    for (const [key, value] of Object.entries(entries)) {
      const { source, object } = objectCall(file, text, "defineNetwork");
      const old = findProperty(object, key).property;
      if (old && ts.isPropertyAssignment(old) && old.initializer.getText(source).replace(/\s/g, "") === value.replace(/\s/g, "")) continue;
      text = setProperty(file, text, object, source, key, value);
    }
    put(file, text); expected.select = "island:vpc";
    expected.network = { cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: [...(request.s3 ? ["s3"] : []), ...(request.dynamodb ? ["dynamodb"] : [])], interfaceEndpoints: request.endpoints };
    impact.push("Configures the one shared network; no second VPC or new deployed identity is introduced.", `Cost-relevant settings: NAT ${request.nat ? "enabled (hourly plus data processing)" : "off"}; ${request.endpoints.length} interface endpoints in ${request.zones} zones (hourly plus data processing). Gateway endpoint and IPv6 egress choices are shown in the patch.`);
  }
  if (request.description) {
    const text = existsSync(path.join(root, DESCRIPTION_FILE)) ? read(DESCRIPTION_FILE) : "export const descriptions = {};\n";
    put(DESCRIPTION_FILE, rewriteDescription(text, expected.select, request.description));
  }
  for (const [file, text] of overrides) {
    if (!file.endsWith(".ts")) continue;
    const diagnostics = ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics ?? [];
    if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new EditError(422, `Generated source does not parse in ${toRelative(root, file)}.`);
  }
  return { overrides, before, expected, impact };
}
