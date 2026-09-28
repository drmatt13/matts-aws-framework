import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { renderFeature } from "./scaffold-templates.js";

/** The emitted metadata used by the deliberately narrow owned-list/create recipe. */
export interface Metadata {
  schemaVersion: string;
  target: string;
  roots: Record<string, { model: string; namespace: string }>;
  domain: { namespaces: { public: { models: Record<string, Model> } } };
  storage: {
    namespaces: Record<
      string,
      {
        entries: {
          table: Record<
            string,
            {
              columns: Record<string, { default?: unknown }>;
              primaryKey?: { columns: string[] };
            }
          >;
        };
      }
    >;
  };
  execution: {
    mutations: {
      defaults: Array<{
        ref: { namespace: string; table: string; column: string };
        onCreate?: unknown;
      }>;
    };
  };
}
export interface Model {
  fields: Record<
    string,
    { nullable: boolean; type: { kind: string; codecId?: string } }
  >;
  relations: Record<
    string,
    {
      cardinality: string;
      on: { localFields: string[]; targetFields: string[] };
      to: { model: string; namespace: string };
    }
  >;
  storage: {
    namespaceId: string;
    table: string;
    fields: Record<string, { column: string }>;
  };
}
export interface Choices {
  model: string;
  publicFields: string[];
  createFields: string[];
  owner: string;
  query: string;
  mutation: string;
  selection: string[];
}
export interface Field {
  name: string;
  scalar: "ID" | "String" | "Boolean" | "Int" | "Float";
  input: "id" | "string" | "boolean" | "int" | "float";
  validation: string;
  sample: string | number | boolean;
}
export interface Feature extends Choices {
  singular: string;
  repository: string;
  fields: Field[];
}
export interface Change {
  path: string;
  before: string | null;
  after: string;
}
const schemaDirectory =
  "cdk-app/lambda_functions/http_functions/graphql-api/schema";
const reserved = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "default",
  "class",
  "function",
  "var",
  "let",
  "const",
  "new",
  "delete",
  "export",
  "import",
  "return",
  "await",
  "yield",
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "do",
  "else",
  "enum",
  "extends",
  "false",
  "finally",
  "for",
  "if",
  "in",
  "instanceof",
  "null",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "void",
  "while",
  "with",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "static",
]);

function identifier(value: string, label: string) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value) || reserved.has(value)) {
    throw new Error(
      `${label} must be an ordinary TypeScript/GraphQL identifier: ${value}`,
    );
  }
}

export function describeModel(metadata: Metadata, name: string) {
  identifier(name, "Model");
  if (!/^[A-Z]/.test(name))
    throw new Error("Model names must start with an uppercase letter.");
  if (metadata.schemaVersion !== "1" || metadata.target !== "postgres") {
    throw new Error(
      "The scaffolder supports emitted PostgreSQL contract version 1 only.",
    );
  }
  const model = metadata.domain.namespaces.public.models[name];
  if (!model)
    throw new Error(
      `Model ${name} is not emitted. Run npm --workspace @repo/database run generate first.`,
    );
  const roots = Object.entries(metadata.roots).filter(
    ([, root]) => root.model === name && root.namespace === "public",
  );
  if (roots.length !== 1)
    throw new Error(
      `${name} needs exactly one public root in the emitted contract.`,
    );
  const repository = roots[0][0];
  identifier(repository, "Repository root");
  const owners = Object.values(model.relations)
    .filter(
      (relation) =>
        relation.cardinality === "N:1" &&
        relation.to.model === "User" &&
        relation.to.namespace === "public" &&
        relation.on.localFields.length === 1 &&
        relation.on.targetFields.join() === "id",
    )
    .map((relation) => relation.on.localFields[0]);
  return { model, repository, owners };
}

function field(name: string, codec: string): Field {
  identifier(name, "Field");
  switch (codec) {
    case "pg/uuid@1":
      return {
        name,
        scalar: "ID",
        input: "id",
        validation: "z.uuid()",
        sample: "11111111-1111-4111-8111-111111111111",
      };
    case "pg/text@1":
      return {
        name,
        scalar: "String",
        input: "string",
        validation: "z.string()",
        sample: "Example",
      };
    case "pg/timestamptz-string@1":
      return {
        name,
        scalar: "String",
        input: "string",
        validation: "z.string()",
        sample: "2026-01-01T00:00:00.000Z",
      };
    case "pg/bool@1":
      return {
        name,
        scalar: "Boolean",
        input: "boolean",
        validation: "z.boolean()",
        sample: false,
      };
    case "pg/int4@1":
      return {
        name,
        scalar: "Int",
        input: "int",
        validation: "z.number().int().min(-2147483648).max(2147483647)",
        sample: 1,
      };
    case "pg/float8@1":
      return {
        name,
        scalar: "Float",
        input: "float",
        validation: "z.number()",
        sample: 1.5,
      };
    default:
      throw new Error(
        `Unsupported codec on ${name}: ${codec}. Author this feature directly; no files were written.`,
      );
  }
}

function validate(metadata: Metadata, choices: Choices): Feature {
  const { model, repository, owners } = describeModel(metadata, choices.model);
  const singular = choices.model[0].toLowerCase() + choices.model.slice(1);
  identifier(singular, "Model's value name");
  for (const key of ["owner", "query", "mutation"] as const)
    identifier(choices[key], key);
  if (!/^[a-z]/.test(choices.query) || !/^[a-z]/.test(choices.mutation))
    throw new Error("Operation names must start with a lowercase letter.");
  if (choices.query === choices.mutation)
    throw new Error("Query and mutation names must differ.");
  if (
    Object.keys(model.relations).length !== 1 ||
    !owners.includes(choices.owner)
  ) {
    throw new Error(
      "This recipe requires exactly one relation: the selected owner field must reference User.id.",
    );
  }
  const fields = Object.entries(model.fields).map(([name, value]) => {
    if (value.nullable || value.type.kind !== "scalar")
      throw new Error(
        `Unsupported field ${name}: this recipe supports non-null scalar fields only.`,
      );
    return field(name, value.type.codecId ?? "unknown");
  });
  const table =
    metadata.storage.namespaces[model.storage.namespaceId]?.entries.table[
      model.storage.table
    ];
  if (
    model.fields.id?.type.codecId !== "pg/uuid@1" ||
    model.fields[choices.owner]?.type.codecId !== "pg/uuid@1" ||
    table?.primaryKey?.columns.join() !== model.storage.fields.id?.column
  ) {
    throw new Error(
      "This recipe requires a single UUID id primary key and UUID owner field.",
    );
  }
  for (const [label, selected] of Object.entries({
    publicFields: choices.publicFields,
    createFields: choices.createFields,
    selection: choices.selection,
  })) {
    if (new Set(selected).size !== selected.length)
      throw new Error(`${label} contains duplicates.`);
    for (const name of selected) {
      if (!model.fields[name])
        throw new Error(`Unknown ${label} field: ${name}`);
      if (
        name === choices.owner ||
        /(?:Sub|Token|Secret|Hash|Key|Salt)$|^password/i.test(name)
      ) {
        throw new Error(
          `${name} is internal/sensitive; this recipe will not expose it. Author a reviewed custom feature instead.`,
        );
      }
    }
  }
  if (
    !choices.publicFields.includes("id") ||
    choices.createFields.length === 0 ||
    choices.selection.length === 0
  ) {
    throw new Error(
      "Select public id, at least one create field, and at least one screen field.",
    );
  }
  if (choices.selection.some((name) => !choices.publicFields.includes(name)))
    throw new Error("Screen fields must be selected public fields.");
  for (const name of choices.createFields) {
    if (
      name === "id" ||
      name === "createdAt" ||
      name === "updatedAt" ||
      model.fields[name].type.codecId === "pg/timestamptz-string@1"
    ) {
      throw new Error(`${name} is generated/read-only in this recipe.`);
    }
  }
  for (const [name, value] of Object.entries(model.fields)) {
    const column = model.storage.fields[name].column;
    const generated = metadata.execution.mutations.defaults.some(
      (entry) =>
        entry.ref.namespace === model.storage.namespaceId &&
        entry.ref.table === model.storage.table &&
        entry.ref.column === column &&
        entry.onCreate !== undefined,
    );
    if (
      name !== choices.owner &&
      !choices.createFields.includes(name) &&
      !value.nullable &&
      table.columns[column].default === undefined &&
      !generated
    ) {
      throw new Error(
        `Required field ${name} needs a create input or a contract default.`,
      );
    }
  }
  return { ...choices, repository, singular, fields };
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
function source(text: string) {
  return ts.createSourceFile(
    "feature.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
function addImport(text: string, module: string, imported?: string) {
  const statement = ts.factory.createImportDeclaration(
    undefined,
    imported
      ? ts.factory.createImportClause(
          false,
          undefined,
          ts.factory.createNamedImports([
            ts.factory.createImportSpecifier(
              false,
              undefined,
              ts.factory.createIdentifier(imported),
            ),
          ]),
        )
      : undefined,
    ts.factory.createStringLiteral(module),
  );
  return (
    printer.printNode(ts.EmitHint.Unspecified, statement, source(text)) +
    "\n" +
    text
  );
}
function registerRepository(text: string, feature: Feature) {
  const ast = source(text);
  let object: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "repositories"
    ) {
      let initializer = node.initializer;
      while (
        initializer &&
        (ts.isAsExpression(initializer) ||
          ts.isSatisfiesExpression(initializer) ||
          ts.isParenthesizedExpression(initializer))
      )
        initializer = initializer.expression;
      if (initializer && ts.isObjectLiteralExpression(initializer))
        object = initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (
    !object ||
    object.properties.some((property) => ts.isSpreadAssignment(property))
  )
    throw new Error(
      "Expected an explicit repositories object; register this feature manually.",
    );
  if (
    object.properties.some(
      (property) =>
        property.name?.getText(ast).replace(/["']/g, "") === feature.repository,
    )
  )
    throw new Error(`Repository ${feature.repository} already exists.`);
  const updated = ts.factory.updateObjectLiteralExpression(object, [
    ...object.properties,
    ts.factory.createPropertyAssignment(
      feature.repository,
      ts.factory.createIdentifier(`create${feature.model}Repository`),
    ),
  ]);
  return addImport(
    text.slice(0, object.getStart(ast)) +
      printer.printNode(ts.EmitHint.Expression, updated, ast) +
      text.slice(object.end),
    `./${feature.repository}.js`,
    `create${feature.model}Repository`,
  );
}

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

/** Plan first: no files are changed until every collision and metadata check passes. */
export function planFeature(
  root: string,
  metadata: Metadata,
  choices: Choices,
): Change[] {
  const feature = validate(metadata, choices);
  const generated = renderFeature(feature);
  const names = new Set([
    feature.model,
    `${feature.model}Summary`,
    `Create${feature.model}Input`,
    `${feature.mutation[0].toUpperCase()}${feature.mutation.slice(1)}Payload`,
    feature.query,
    feature.mutation,
  ]);
  for (const path of files(resolve(root, schemaDirectory))) {
    if (path.endsWith(".test.ts")) continue;
    const ast = source(readFileSync(path, "utf8"));
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        [
          "objectRef",
          "inputType",
          "enumType",
          "queryField",
          "mutationField",
        ].includes(node.expression.name.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        names.has(node.arguments[0].text)
      ) {
        throw new Error(
          `GraphQL name ${node.arguments[0].text} already exists in ${relative(root, path)}.`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const operationNames = [
    feature.query[0].toUpperCase() + feature.query.slice(1),
    feature.mutation[0].toUpperCase() + feature.mutation.slice(1),
    `${feature.model}Summary`,
  ];
  for (const path of files(resolve(root, "client-app/src/api"))) {
    const text = readFileSync(path, "utf8");
    for (const name of operationNames)
      if (
        new RegExp(`\\b(?:query|mutation|fragment)\\s+${name}\\b`).test(text)
      ) {
        throw new Error(
          `GraphQL document ${name} already exists in ${relative(root, path)}.`,
        );
      }
  }
  const changes: Change[] = Object.entries(generated.files).map(
    ([path, after]) => {
      if (existsSync(resolve(root, path)))
        throw new Error(`Refusing to overwrite ${path}.`);
      return { path, before: null, after };
    },
  );
  const contractsPath = "packages/database/src/contracts.ts";
  const contracts = readFileSync(resolve(root, contractsPath), "utf8");
  const declarations = source(contracts).statements.filter(
    (node) =>
      ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
  );
  for (const name of [
    `${feature.model}Record`,
    `Create${feature.model}Input`,
    `${feature.model}Repository`,
  ]) {
    if (declarations.some((node) => node.name.text === name))
      throw new Error(`Type ${name} already exists.`);
  }
  changes.push({
    path: contractsPath,
    before: contracts,
    after: contracts.trimEnd() + "\n\n" + generated.contracts,
  });
  const indexPath = "packages/database/src/index.ts";
  const index = readFileSync(resolve(root, indexPath), "utf8");
  changes.push({
    path: indexPath,
    before: index,
    after: registerRepository(index, feature),
  });
  const schemaPath = `${schemaDirectory}/index.ts`;
  const schema = readFileSync(resolve(root, schemaPath), "utf8");
  changes.push({
    path: schemaPath,
    before: schema,
    after: addImport(schema, `./${feature.singular}`),
  });
  return changes;
}

function destination(root: string, path: string) {
  const base = resolve(root);
  const absolute = resolve(base, path);
  const within = relative(base, absolute);
  if (isAbsolute(within) || within.startsWith("..") || absolute === base)
    throw new Error(`Invalid scaffold path: ${path}`);
  return absolute;
}

export function writeFeature(root: string, changes: Change[]) {
  for (const change of changes) {
    const path = destination(root, change.path);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== change.before)
      throw new Error(
        `${change.path} changed since preview. Nothing was written; preview again.`,
      );
  }
  const applied: Change[] = [];
  try {
    for (const change of changes) {
      const path = destination(root, change.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, change.after, {
        flag: change.before === null ? "wx" : "w",
      });
      applied.push(change);
    }
  } catch (error) {
    // Roll back only our own content; preserve any concurrent editor changes.
    for (const change of applied.reverse()) {
      const path = destination(root, change.path);
      if (readFileSync(path, "utf8") !== change.after) continue;
      if (change.before === null) unlinkSync(path);
      else writeFileSync(path, change.before);
    }
    throw error;
  }
}
