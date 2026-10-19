import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CdkLinkIndex, ModelEdge, NativeRemoval, SourceLocation } from "../../shared/model";
import { sha256 } from "../files";
import type { CatalogEntrySource } from "./catalog";
import { lineAndColumn, literalKey, parse, unwrap } from "./syntax";
import { COGNITO_TRIGGER_OPERATIONS } from "../../../packages/framework/src/config/triggers";

/** Conservative syntax scan of linked stack constructors. Never imports or synthesizes CDK. */
export function scanCdkLinks(
  repositoryRoot: string,
  catalog: ReadonlyMap<string, CatalogEntrySource>,
  links: Readonly<Record<string, readonly SourceLocation[]>>,
  /** Reads a stack file; edit validation scans proposed text before anything is written. */
  read: (file: string) => string = (file) => readFileSync(path.join(repositoryRoot, file), "utf8"),
): CdkLinkIndex {
  const files: Record<string, string> = {};
  const edges: ModelEdge[] = [];
  const manualWiring: CdkLinkIndex["manualWiring"][number][] = [];
  const notes = ["Source inference only: direct constructor statements, published local constructs, eventFunction aliases, Cognito hooks, SNS subscriptions, event sources, S3 notifications and EventBridge targets. Helpers, conditions, loops, dynamic names and runtime behavior require manual wiring review."];
  for (const [catalogPath, entry] of catalog) {
    const stack = entry.stack;
    if (!stack?.location) continue;
    const file = stack.location.file;
    const text = read(file);
    files[file] = sha256(text);
    const source = parse(file, text);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) {
      notes.push(`${file}: syntax errors; relationships omitted.`);
      continue;
    }
    const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === stack.className);
    const constructor = declaration?.members.find(ts.isConstructorDeclaration);
    if (!constructor?.body || !constructor.body.statements.some((statement) => ts.isExpressionStatement(statement) &&
      links[catalogPath]?.some((site) => site.file === file && site.start === statement.expression.getStart(source) && site.end === statement.expression.end))) continue;
    const members = new Set(stack.members.map((member) => member.name));
    const aliases = new Map<string, string>();
    const namespaces = new Map<string, string>();
    const imports = new Map<string, { module: string; name: string }>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        imports.set(element.name.text, { module: statement.moduleSpecifier.text, name: element.propertyName?.text ?? element.name.text });
      }
    }
    const isConstructor = (node: ts.NewExpression, module: string, name: string): boolean => {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return namespaces.get(expression.expression.text) === `aws-cdk-lib/${module}` && expression.name.text === name;
      const imported = ts.isIdentifier(expression) ? imports.get(expression.text) : undefined;
      return imported?.module === `aws-cdk-lib/${module}` && imported.name === name;
    };
    const eventAliases = new Map<string, string>();
    const eventRef = (expression: ts.Expression): string | undefined => {
      const value = unwrap(expression);
      if (ts.isIdentifier(value)) return eventAliases.get(value.text);
      if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return undefined;
      const imported = imports.get(value.expression.text);
      if (imported?.name !== "eventFunction" || path.resolve(path.dirname(path.join(repositoryRoot, file)), imported.module).replace(/\.ts$/, "") !== path.resolve(repositoryRoot, "cdk-app/lib/framework/framework-events")) return undefined;
      const id = value.arguments[1];
      return value.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword && id && ts.isStringLiteralLike(id) ? `lambda:${id.text}` : undefined;
    };
    const ref = (node: ts.Expression): string | undefined => {
      const value = unwrap(node);
      if (ts.isIdentifier(value)) return aliases.get(value.text);
      if (!ts.isPropertyAccessExpression(value)) return undefined;
      if (value.expression.kind === ts.SyntaxKind.ThisKeyword && members.has(value.name.text)) return `resource:${catalogPath}.${value.name.text}`;
      return ref(value.expression);
    };
    const references = (node: ts.Node): string[] => {
      const found = new Set<string>();
      const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        const id = ts.isExpression(child) ? ref(child) : undefined;
        if (id) { found.add(id); return; }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return [...found];
    };
    const locate = (node: ts.Node): SourceLocation => {
      const start = node.getStart(source);
      return { file, ...lineAndColumn(source, start), start, end: node.end };
    };
    const manual = (resource: string | undefined, node: ts.Node, reason = "Manual wiring, review required"): void => {
      const location = locate(node);
      if (!manualWiring.some((item) => item.resource === (resource ?? `resource:${catalogPath}`) && item.source.start === location.start)) manualWiring.push({ resource: resource ?? `resource:${catalogPath}`, source: location, reason });
    };
    const add = (from: string, to: string, label: string, node: ts.Node, relation: "cdk" | "trigger" = "cdk", removal?: NativeRemoval): void => {
      if (from === to) return;
      const start = node.getStart(source);
      const location = { file, ...lineAndColumn(source, start), start, end: node.end };
      const id = `${relation}:${from}->${to}#${file}:${start}:${label}`;
      if (edges.some((edge) => edge.id === id)) return;
      edges.push({ id, relation, from, to, label, provenance: "source", source: location, detail: `${relation === "trigger" ? "Native trigger" : "Inferred from CDK source"} · ${file}:${location.line}`, ...(removal ? { removal } : {}) });
    };
    const properties = (expression: ts.Expression | undefined): readonly ts.ObjectLiteralElementLike[] => {
      const value = expression && unwrap(expression);
      return value && ts.isObjectLiteralExpression(value) ? value.properties : [];
    };
    const property = (expression: ts.Expression | undefined, name: string): ts.Expression | undefined => {
      const prop = properties(expression).find((item) => literalKey(item) === name);
      return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
    };
    // A constructor-local construct can be published after all its native wiring.
    const variables = new Map<string, ts.Expression>();
    for (const statement of constructor.body.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const variable of statement.declarationList.declarations) {
      if (ts.isIdentifier(variable.name) && variable.initializer) variables.set(variable.name.text, variable.initializer);
    }
    for (const statement of constructor.body.statements) if (ts.isExpressionStatement(statement)) {
      const value = unwrap(statement.expression);
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(value.right)) {
        const initializer = variables.get(value.right.text);
        const id = ref(value.left);
        if (id && initializer && ts.isNewExpression(unwrap(initializer))) aliases.set(value.right.text, id);
      }
    }
    const resolve = (node: ts.Expression): ts.Expression => ts.isIdentifier(unwrap(node)) ? variables.get((unwrap(node) as ts.Identifier).text) ?? node : node;
    const direct = new Set(constructor.body.statements);
    // Only a span whose deletion removes exactly this wiring is offered; anything else is edited in source.
    const span = (kind: "property" | "statement" | "element", node: ts.Node): NativeRemoval => ({ kind, start: node.getStart(source), end: node.end });
    const statementOf = (node: ts.Node): NativeRemoval => ts.isExpressionStatement(node.parent) && direct.has(node.parent) ? span("statement", node.parent) : { refused: "This wiring is part of a larger expression or assignment; edit it in source." };
    const trigger = (from: string | undefined, expression: ts.Expression | undefined, label: string, node: ts.Node, removal: NativeRemoval = statementOf(node)) => {
      const to = expression && eventRef(expression);
      if (from && to) add(from, to, label, node, "trigger", removal);
      else manual(from, node);
    };
    const inspect = (expression: ts.Expression, owner?: string): void => {
      const value = unwrap(expression);
      if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && !eventRef(value)) {
        const resources = value.arguments.flatMap(references);
        for (const id of resources) manual(id, value);
      }
      if (ts.isNewExpression(value)) {
        const props = value.arguments?.[2];
        const hooks = property(props, "lambdaTriggers");
        if (hooks) {
          const entries = properties(resolve(hooks));
          if (!owner || !entries.length) manual(owner, hooks);
          for (const hook of entries) {
            if (ts.isPropertyAssignment(hook) && literalKey(hook)) trigger(owner, hook.initializer, literalKey(hook)!, hook, ts.isObjectLiteralExpression(unwrap(hooks)) ? span("property", hook) : { refused: "These hooks come from a variable; edit them in source." });
            else manual(owner, hook);
          }
        }
        if (owner && props) {
          for (const prop of properties(props)) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const name = literalKey(prop);
            if (name !== "lambdaTriggers") for (const target of references(prop.initializer)) add(owner, target, name === "deadLetterQueue" ? "Dead-letter queue" : `CDK reference · ${name ?? "property"}`, prop);
          }
        }
        if (isConstructor(value, "aws-events", "Rule")) {
          const pattern = property(props, "eventPattern");
          const targets = property(props, "targets");
          if (pattern && targets) for (const from of references(pattern)) for (const to of references(targets)) add(from, to, "EventBridge rule", value);
          const bus = property(props, "eventBus");
          const targetList = targets && unwrap(resolve(targets));
          if (targetList && ts.isArrayLiteralExpression(targetList)) for (const item of targetList.elements) {
            const target = unwrap(resolve(item));
            const literal = targetList === unwrap(targets);
            // Another target keeps the rule; a sole target removes only a standalone rule.
            const removal = !literal ? { refused: "These targets come from a variable; edit them in source." } : targetList.elements.length > 1 ? span("element", item) : ts.isExpressionStatement(value.parent) && direct.has(value.parent) ? span("statement", value.parent) : { refused: "The rule is assigned or referenced; edit it in source." };
            if (ts.isNewExpression(target) && isConstructor(target, "aws-events-targets", "LambdaFunction")) trigger(bus && ref(bus), target.arguments?.[0], "EventBridge rule", value, removal);
          }
        }
      }
      if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
        const from = ref(value.expression.expression);
        const subscription = value.arguments[0] && unwrap(resolve(value.arguments[0]));
        if (from && value.expression.name.text === "addSubscription" && subscription && ts.isNewExpression(subscription) && isConstructor(subscription, "aws-sns-subscriptions", "SqsSubscription")) {
          const to = subscription.arguments?.[0] && ref(subscription.arguments[0]);
          if (to) add(from, to, "SNS subscription", value);
        }
        const method = value.expression.name.text;
        const override = value.arguments[0];
        if (["addOverride", "addPropertyOverride"].includes(method) && override && ts.isStringLiteralLike(override) && ["LambdaConfig", "NotificationConfiguration", "Targets", "EventSourceArn"].some((name) => override.text.includes(name))) manual(from, value);
        if (method === "addSubscription" && subscription && ts.isNewExpression(subscription) && isConstructor(subscription, "aws-sns-subscriptions", "LambdaSubscription")) trigger(from, subscription.arguments?.[0], "SNS subscription", value);
        if (method === "addEventSource") {
          const fn = eventRef(value.expression.expression);
          const eventSource = subscription && unwrap(resolve(subscription));
          const types = [["SqsEventSource", "SQS"], ["DynamoEventSource", "DynamoDB stream"], ["S3EventSource", "S3 notification"]] as const;
          const type = eventSource && ts.isNewExpression(eventSource) ? types.find(([name]) => isConstructor(eventSource, "aws-lambda-event-sources", name)) : undefined;
          const resource = type && ts.isNewExpression(eventSource!) ? eventSource.arguments?.[0] : undefined;
          const sourceId = resource && ref(resource);
          if (sourceId && fn) add(sourceId, fn, type![1], value, "trigger", statementOf(value)); else manual(sourceId, value);
        }
        if (method === "addEventNotification" || method === "addObjectCreatedNotification" || method === "addObjectRemovedNotification") {
          const notification = value.arguments[method === "addEventNotification" ? 1 : 0];
          const destination = notification && unwrap(resolve(notification));
          if (destination && ts.isNewExpression(destination) && isConstructor(destination, "aws-s3-notifications", "LambdaDestination")) trigger(from, destination.arguments?.[0], method === "addEventNotification" ? value.arguments[0]?.getText(source) ?? "S3 notification" : method, value);
          else manual(from, value);
        }
        if (method === "addTrigger") {
          const operation = value.arguments[0];
          const hook = operation && ts.isPropertyAccessExpression(operation) ? Object.entries(COGNITO_TRIGGER_OPERATIONS).find(([, name]) => name === operation.name.text)?.[0] : undefined;
          trigger(from, value.arguments[1], hook ?? operation?.getText(source) ?? "Cognito hook", value);
        }
        if (method === "addSubscription" && (!subscription || !ts.isNewExpression(subscription) || !["SqsSubscription", "LambdaSubscription"].some((name) => isConstructor(subscription, "aws-sns-subscriptions", name)))) manual(from, value);
      }
    };
    for (const member of declaration!.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && members.has(member.name.text) && member.initializer) inspect(member.initializer, `resource:${catalogPath}.${member.name.text}`);
    }
    // Do not descend into branches or nested functions and imply they always execute.
    for (const statement of constructor.body.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const variable of statement.declarationList.declarations) {
          if (!variable.initializer) continue;
          const id = ref(variable.initializer);
          if (id && ts.isIdentifier(variable.name)) aliases.set(variable.name.text, id);
          const event = eventRef(variable.initializer);
          if (event && ts.isIdentifier(variable.name)) eventAliases.set(variable.name.text, event);
          inspect(variable.initializer, ts.isIdentifier(variable.name) ? aliases.get(variable.name.text) : undefined);
        }
      }
      if (!ts.isExpressionStatement(statement)) continue;
      const value = unwrap(statement.expression);
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) inspect(value.right, ref(value.left));
      else inspect(value);
    }
    // Unknown/conditional wiring is occupied conservatively; it never authorizes an edit.
    const findManual = (node: ts.Node, nested = false): void => {
      const indirect = nested || (ts.isStatement(node) && node !== constructor.body && !direct.has(node));
      if (indirect && ((ts.isPropertyAssignment(node) && literalKey(node) === "lambdaTriggers") || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["addTrigger", "addSubscription", "addEventSource", "addEventNotification"].includes(node.expression.name.text)))) {
        const ids = references(node);
        for (const id of ids.length ? ids : [`resource:${catalogPath}`]) manual(id, node);
      }
      ts.forEachChild(node, (child) => findManual(child, indirect));
    };
    findManual(constructor.body);
  }
  return { version: 2, files, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), notes, manualWiring };
}
