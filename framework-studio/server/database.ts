import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ArrayLiteralAst, GenericBlockDeclarationAst, ModelDeclarationAst, NamespaceDeclarationAst,
  StringLiteralExprAst, parse, type AttributeAst, type AstNode, type ExpressionAst,
} from "@prisma/orm-framework/psl-parser/syntax";
import { parseCompose } from "../../packages/framework/scripts/compose-services";
import { isMap, isScalar, parseDocument } from "yaml";
import type { DeclaredSchema, LocalDatabase, SchemaIndex, SchemaRelation, SchemaTable } from "../shared/database";
import type { ModeModel, SourceLocation } from "../shared/model";
import { sha256 } from "./files";

export const CONTRACT_FILE = "packages/database/prisma/contract.prisma";

/** Read the authored PSL using Prisma's syntax parser, independently of generated artifacts. */
export function parseDeclaredSchema(text: string, file = CONTRACT_FILE): DeclaredSchema {
  const parsed = parse(text, file);
  const sourceFile = parsed.sources.sourceFileFor(parsed.document.syntax);
  const location = (node: AstNode): SourceLocation => {
    const start = node.syntax.offset;
    const position = sourceFile.positionAt(start);
    return { file, line: position.line + 1, column: position.character + 1, start, end: node.syntax.endOffset };
  };
  const raw = (node: AstNode | undefined) => node ? text.slice(node.syntax.offset, node.syntax.endOffset).trim() : "";
  const nameOf = (attribute: AttributeAst) => raw(attribute.name());
  const attribute = (items: Iterable<AttributeAst>, name: string) => [...items].find((item) => nameOf(item) === name);
  const argument = (item: AttributeAst | undefined, name?: string): ExpressionAst | undefined =>
    [...(item?.argList()?.args() ?? [])].find((arg) => arg.name()?.name() === name)?.value();
  const value = (item: AttributeAst | undefined, name?: string) => {
    const expression = argument(item, name);
    return expression instanceof StringLiteralExprAst ? expression.value() : expression ? raw(expression) : undefined;
  };
  const fields = (item: AttributeAst | undefined, name?: string): string[] => {
    const expression = argument(item, name);
    if (!(expression instanceof ArrayLiteralAst)) return [];
    // Indexed fields may include sort/operator options: retain the field identity.
    return [...expression.elements()].map((element) => raw(element).split("(")[0]!.trim());
  };
  const problems = parsed.diagnostics.map((diagnostic) => `${file}:${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
  const tables: SchemaTable[] = [];
  const relations: SchemaRelation[] = [];
  const enums: { name: string; values: string[] }[] = [];
  const models: { node: ModelDeclarationAst; namespace: string }[] = [];
  for (const declaration of parsed.document.declarations()) {
    if (declaration instanceof ModelDeclarationAst) models.push({ node: declaration, namespace: "public" });
    else if (declaration instanceof NamespaceDeclarationAst) {
      for (const member of declaration.declarations()) {
        if (member instanceof ModelDeclarationAst) models.push({ node: member, namespace: declaration.name()?.name() ?? "public" });
        else if (member instanceof GenericBlockDeclarationAst && member.keyword()?.text === "enum") {
          enums.push({ name: `${declaration.name()?.name()}.${member.name()?.name()}`, values: [...member.entries()].map((entry) => raw(entry.key())) });
        }
      }
    } else if (declaration instanceof GenericBlockDeclarationAst && declaration.keyword()?.text === "enum") {
      enums.push({ name: declaration.name()?.name() ?? "", values: [...declaration.entries()].map((entry) => raw(entry.key())) });
    } else {
      problems.push(`Declaration ${raw(declaration).split("\n")[0]} is not displayed as a table.`);
    }
  }
  // A recovered syntax tree can omit columns or relationships. Show errors instead of a partial diagram.
  if (parsed.diagnostics.length) return { file, hash: sha256(text), tables: [], relations: [], enums: [], problems };
  const tableId = (namespace: string, model: string) => `schema:${namespace}.${model}`;
  for (const { node, namespace } of models) {
    const model = node.name()?.name();
    if (!model) continue;
    const attributes = [...node.attributes()];
    const id = tableId(namespace, model);
    const indexes: SchemaIndex[] = [];
    for (const item of attributes) {
      const name = nameOf(item);
      if (name !== "id" && name !== "index" && name !== "unique") continue;
      indexes.push({
        name: value(item, "map") ?? value(item, "name"),
        kind: name === "id" ? "primary" : name === "unique" || value(item, "unique") === "true" ? "unique" : "index",
        fields: fields(item), predicate: value(item, "where"), declaration: raw(item), source: location(item),
      });
    }
    const columns = [];
    for (const field of node.fields()) {
      const name = field.name()?.name();
      const type = field.typeAnnotation();
      if (!name || !type) continue;
      const attrs = [...field.attributes()];
      const relation = attribute(attrs, "relation");
      if (relation) {
        const localFields = fields(relation, "fields");
        const references = fields(relation, "references");
        // Back references carry no FK; the owning side supplies the connector.
        if (!localFields.length) continue;
        const target = raw(type.name());
        const targetId = target.includes(":") ? undefined : target.includes(".") ? `schema:${target}` : tableId(namespace, target);
        if (!targetId || !models.some((candidate) => tableId(candidate.namespace, candidate.node.name()?.name() ?? "") === targetId)) {
          problems.push(`${model}.${name}: related model ${target} is outside this contract diagram.`);
          continue;
        }
        const targetNode = models.find((candidate) => tableId(candidate.namespace, candidate.node.name()?.name() ?? "") === targetId)!.node;
        if (references.length !== localFields.length || localFields.some((name) => ![...node.fields()].some((field) => field.name()?.name() === name)) || references.some((name) => ![...targetNode.fields()].some((field) => field.name()?.name() === name))) {
          problems.push(`${model}.${name}: foreign-key fields or references are unresolved.`);
          continue;
        }
        relations.push({ id: `${id}.${name}`, name, from: id, to: targetId, fields: localFields, references,
          cardinality: "N:1", nullable: type.isOptional(), onDelete: value(relation, "onDelete") ?? "Restrict",
          onUpdate: value(relation, "onUpdate") ?? "Restrict", source: location(field) });
        continue;
      }
      for (const kind of ["id", "unique"] as const) {
        const item = attribute(attrs, kind);
        if (item) indexes.push({ name: value(item, "map") ?? value(item, "name"), kind: kind === "id" ? "primary" : "unique", fields: [name], declaration: raw(item), source: location(item) });
      }
      columns.push({ name, column: value(attribute(attrs, "map")) ?? name, type: raw(type), nullable: type.isOptional(),
        primaryKey: false, unique: false, default: value(attribute(attrs, "default")), source: location(field) });
    }
    tables.push({ id, model, namespace, table: value(attribute(attributes, "map")) ?? model,
      columns: columns.map((column) => ({ ...column,
        primaryKey: indexes.some((index) => index.kind === "primary" && index.fields.includes(column.name)),
        unique: indexes.some((index) => index.kind !== "index" && !index.predicate && index.fields.length === 1 && index.fields[0] === column.name),
      })), indexes, source: location(node) });
  }
  return { file, hash: sha256(text), tables, enums, problems,
    relations: relations.map((relation) => {
      const table = tables.find((table) => table.id === relation.from)!;
      return { ...relation,
        nullable: table.columns.some((column) => relation.fields.includes(column.name) && column.nullable),
        cardinality: table.indexes.some((index) => index.kind !== "index" && !index.predicate && index.fields.length > 0 && index.fields.every((field) => relation.fields.includes(field))) ? "1:1" : "N:1",
      };
    }),
  };
}

export function readDeclaredSchema(root: string): DeclaredSchema {
  try { return parseDeclaredSchema(readFileSync(path.join(root, CONTRACT_FILE), "utf8")); }
  catch { return { file: CONTRACT_FILE, hash: "", tables: [], relations: [], enums: [], problems: [`Cannot read ${CONTRACT_FILE}.`] }; }
}

/** A narrow projection of authored Compose facts. Never return environment or connection values. */
export function readLocalDatabases(root: string): { services: readonly LocalDatabase[]; problems: readonly string[] } {
  const file = "docker-compose.yml";
  if (!existsSync(path.join(root, file))) return { services: [], problems: [] };
  try {
    const text = readFileSync(path.join(root, file), "utf8");
    const service = parseCompose(text).services?.postgres;
    if (!service) return { services: [], problems: [] };
    // Use YAML node ranges: `postgres` can also occur in dependency anchors before services.
    const services = parseDocument(text).get("services", true);
    const key = isMap(services) ? services.items.find((item) => isScalar(item.key) && item.key.value === "postgres")?.key : undefined;
    if (!isScalar(key) || !key.range) return { services: [], problems: ["The Compose postgres declaration could not be located."] };
    const start = key.range[0];
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const image = typeof service.image === "string" && /^[\w./:@-]+$/.test(service.image) ? service.image : "Image configured in Compose";
    const volumes = (Array.isArray(service.volumes) ? service.volumes : []).flatMap((entry) => {
      const source = typeof entry === "string" ? entry.split(":")[0] : entry && typeof entry === "object" ? entry.source : undefined;
      return typeof source === "string" && /^[\w-]+$/.test(source) ? [source] : [];
    });
    return { services: [{ id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image, volumes, enabled: true,
      source: { file, line: text.slice(0, start).split("\n").length, column: start - lineStart + 1, start, end: key.range[1] } }], problems: [] };
  } catch {
    // YAML errors can contain source excerpts, including secrets; expose only the file name.
    return { services: [], problems: [`Cannot read PostgreSQL from ${file}. Check the Compose YAML.`] };
  }
}

export function withLocalDatabases(model: ModeModel, services: readonly LocalDatabase[]): ModeModel {
  const postgres = services[0];
  const targets = new Map(model.targets.map((target) => [target.ref, target]));
  const edgeIds = new Set(model.edges.map((edge) => edge.id));
  return { ...model, localServices: services.map((service) => ({ ...service, enabled: model.mode === "dev" })),
    edges: model.edges.flatMap((edge) => {
      const target = targets.get(edge.from);
      if (!postgres || model.mode !== "dev" || edge.relation !== "database" || !target?.lanes.local || edge.to === postgres.id) return [edge];
      if (edgeIds.has(`${edge.id}:local`)) return [edge];
      const local = { ...edge, id: `${edge.id}:local`, to: postgres.id, provenance: "derived" as const,
        detail: "Local execution uses Compose PostgreSQL through the framework database binding. Writer and reader roles share this database." };
      return target.lanes.dev ? [edge, local] : [local];
    }),
  };
}
