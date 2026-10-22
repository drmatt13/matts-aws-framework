import { Tokenizer, type TokenKind } from "@prisma/orm-framework/psl-parser/tokenizer";
import { AttributeArgAst, FieldDeclarationAst, parse, SyntaxNode, type SyntaxToken } from "@prisma/orm-framework/psl-parser/syntax";
import { StreamLanguage, syntaxTree, type StringStream } from "@codemirror/language";
import { type CompletionContext, type CompletionResult, snippetCompletion } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

/** Lexical assistance for this checkout's Prisma 8 dialect, not a semantic language server. */
export const prismaScalars: Readonly<Record<string, string>> = {
  String: "Text stored in PostgreSQL.", Boolean: "A true or false value.",
  Int: "A signed 32-bit integer.", BigInt: "A signed 64-bit integer.", Float: "A floating-point value.",
  Decimal: "An exact decimal stored as PostgreSQL numeric. Use Numeric(p, s) to configure precision and scale.",
  Numeric: "An exact decimal with optional precision and scale, e.g. Numeric(12, 2).",
  VarChar: "Variable-length text with an optional maximum character length, e.g. VarChar(255).",
  Char: "Fixed-length, blank-padded text with an optional character length.",
  SmallInt: "A signed 16-bit integer.", Real: "A single-precision floating-point number.",
  Uuid: "A PostgreSQL UUID. Common default: @default(uuid()).", Json: "A JSON value stored as PostgreSQL json.", Jsonb: "A JSON value stored as PostgreSQL binary jsonb.", Bytes: "Binary data.",
  Inet: "An IPv4 or IPv6 address with an optional subnet mask.",
  DateTime: "An instant stored as PostgreSQL timestamptz and represented as Temporal.Instant.",
  Timetz: "A time of day with a UTC offset stored as PostgreSQL timetz.",
  TimestamptzJsDate: "An instant represented as JavaScript Date, with millisecond precision limits.",
  Date: "A date using Temporal.PlainDate. DateString uses PostgreSQL text instead.",
  DateString: "A PostgreSQL date represented as text; no global Temporal needed.",
  Timestamp: "A timestamp without time zone using Temporal.PlainDateTime. Supports precision, e.g. Timestamp(6).",
  TimestampString: "A timestamp without time zone represented as text. Supports precision, e.g. TimestampString(6).",
  Timestamptz: "A timestamp with time zone using Temporal.Instant. Supports precision, e.g. Timestamptz(6).",
  TimestamptzString: "A timestamp with time zone represented as text. Supports precision, e.g. TimestamptzString(6).",
  Time: "A time using Temporal.PlainTime. Supports fractional precision, e.g. Time(6).",
  TimeString: "A time represented as PostgreSQL text. Supports fractional precision, e.g. TimeString(6).",
};

export const prismaAttributes: Readonly<Record<string, string>> = {
  "@id": "Declare a primary key. map names its PostgreSQL constraint.",
  "@unique": "Declare a unique field constraint. map names its PostgreSQL constraint.",
  "@default": "Declare a default expression, for example uuid(), now(), or false.",
  "@map": "Map a Prisma field to a physical PostgreSQL column. Keeps a database column stable when renaming the field.",
  "@relation": "Declare relationship fields, referenced fields, and referential actions. The owning side names fields and references.",
  "@@id": "Declare a composite primary key using Prisma field names.",
  "@@index": "Declare an index. unique: true creates a unique index. map names the physical index.",
  "@@unique": "Declare a composite unique constraint using Prisma field names.",
  "@@map": "Map a Prisma model to its physical PostgreSQL table name.",
  "@@check": "Declare a SQL check constraint. Validation determines supported arguments.",
};
const keywords = new Set(["model", "enum", "native_enum", "type", "types", "namespace", "view"]);

interface LexicalState { multilineString: boolean; afterAttribute: boolean; afterDeclaration: boolean; depth: number }
/** Exported for dialect regression tests. Token boundaries come from the pinned tokenizer. */
export function prismaToken(stream: StringStream, state: LexicalState): string | null {
  if (state.multilineString) {
    while (!stream.eol()) {
      const character = stream.next();
      if (character === "\\") stream.next();
      else if (character === "`") { state.multilineString = false; break; }
    }
    return "string";
  }
  const token = new Tokenizer(stream.string.slice(stream.pos)).next();
  stream.pos += Math.max(1, token.text.length);
  const kind: TokenKind = token.kind;
  if (kind === "Whitespace" || kind === "Newline") return null;
  if (kind === "Comment") return "comment";
  if (kind === "StringLiteral") {
    if (token.text.startsWith("`") && !hasClosingBacktick(token.text)) state.multilineString = true;
    return "string";
  }
  if (kind === "NumberLiteral") return "number";
  if (kind === "At" || kind === "DoubleAt") { state.afterAttribute = true; return "meta"; }
  if (kind === "Dot" || kind === "Colon") return "punctuation";
  if (kind === "Ident") {
    if (state.afterAttribute) { state.afterAttribute = false; return "meta"; }
    if (state.afterDeclaration) { state.afterDeclaration = false; return "def"; }
    if (keywords.has(token.text)) { state.afterDeclaration = token.text !== "types"; return "keyword"; }
    if (token.text === "true" || token.text === "false" || token.text === "null") return "atom";
    if (/^[A-Z]/.test(token.text)) return "typeName";
    if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "functionName";
    return "variableName";
  }
  if (kind === "LBrace") state.depth++;
  if (kind === "RBrace") state.depth = Math.max(0, state.depth - 1);
  state.afterAttribute = state.afterDeclaration = false;
  return kind === "Invalid" ? "invalid" : "punctuation";
}
function hasClosingBacktick(text: string): boolean {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return true;
  }
  return false;
}
export const prismaLanguage = StreamLanguage.define<LexicalState>({
  name: "Prisma 8",
  startState: () => ({ multilineString: false, afterAttribute: false, afterDeclaration: false, depth: 0 }),
  token: prismaToken,
  tokenTable: { functionName: tags.function(tags.variableName) },
  indent(state, after, context) {
    if (state.multilineString) return null;
    return Math.max(0, state.depth - (/^\s*\}/.test(after) ? 1 : 0)) * context.unit;
  },
  languageData: { commentTokens: { line: "//" }, closeBrackets: { brackets: ["(", "[", "{", '"', "'", "`"] } },
});

export interface PrismaSymbol { name: string; from: number; to: number; kind: string; scope?: string; text: string }
/** On-demand CST navigation. A recovered draft remains navigable; it is never used as validation. */
export function prismaSymbols(text: string): readonly PrismaSymbol[] {
  const result = parse(text, "contract.prisma");
  const symbols: PrismaSymbol[] = [];
  const declarationKinds = new Set(["ModelDeclaration", "CompositeTypeDeclaration", "GenericBlockDeclaration", "Namespace", "NamedTypeDeclaration"]);
  for (const element of result.document.syntax.descendants()) {
    if (!(element instanceof SyntaxNode) || (!declarationKinds.has(element.kind) && element.kind !== "FieldDeclaration")) continue;
    const identifier = [...element.childNodes()].find(node => node.kind === "Identifier");
    if (!identifier) continue;
    const parent = [...element.ancestors()].find(node => node !== element && ["ModelDeclaration", "CompositeTypeDeclaration", "GenericBlockDeclaration", "Namespace"].includes(node.kind));
    const parentName = parent && [...parent.childNodes()].find(node => node.kind === "Identifier");
    symbols.push({ name: text.slice(identifier.offset, identifier.endOffset), from: identifier.offset, to: identifier.endOffset,
      kind: element.kind, scope: parentName ? text.slice(parentName.offset, parentName.endOffset) : undefined,
      text: text.slice(element.offset, element.endOffset).split("\n")[0]!.trim() });
  }
  return symbols;
}

export function prismaDefinition(text: string, offset: number): PrismaSymbol | undefined {
  const parsed = parse(text, "contract.prisma");
  const token = parsed.document.syntax.tokenAtOffset(offset).rightBiased();
  if (!token || token.kind !== "Ident") return undefined;
  const symbols = prismaSymbols(text);
  // A field reference is only resolved within its own model. Ambiguous names do not jump.
  const owner = [...token.parent.ancestors()].find(node => node.kind === "ModelDeclaration" || node.kind === "CompositeTypeDeclaration");
  const ownerName = owner && [...owner.childNodes()].find(node => node.kind === "Identifier");
  const scope = ownerName ? text.slice(ownerName.offset, ownerName.endOffset) : undefined;
  const argumentNode = [...token.parent.ancestors()].find(node => node.kind === "AttributeArg");
  if (argumentNode && new AttributeArgAst(argumentNode).name()?.name() === "references") {
    const relationField = [...token.parent.ancestors()].find(node => node.kind === "FieldDeclaration");
    const target = relationField && new FieldDeclarationAst(relationField).typeAnnotation()?.name()?.path().at(-1);
    const targetModels = symbols.filter(symbol => symbol.kind === "ModelDeclaration" && symbol.name === target);
    const referenced = symbols.filter(symbol => symbol.kind === "FieldDeclaration" && symbol.scope === target && symbol.name === token.text);
    return targetModels.length === 1 && referenced.length === 1 ? referenced[0] : undefined;
  }
  const fields = symbols.filter(symbol => symbol.kind === "FieldDeclaration" && symbol.scope === scope && symbol.name === token.text);
  if (fields.length === 1 && !hasAncestor(token, "TypeAnnotation")) return fields[0];
  const declarations = symbols.filter(symbol => symbol.kind !== "FieldDeclaration" && symbol.name === token.text);
  return declarations.length === 1 ? declarations[0] : undefined;
}
function hasAncestor(token: SyntaxToken, kind: string) { return [...token.parent.ancestors()].some(node => node.kind === kind); }

export function prismaCompletions(context: CompletionContext): CompletionResult | null {
  const syntax = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (syntax.name === "string" || syntax.name === "comment") return null;
  const word = context.matchBefore(/@@?[\w.-]*|[\w.-]+/);
  if (!word && !context.explicit) return null;
  const from = word?.from ?? context.pos;
  const before = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, from);
  // Never offer code inside comments or strings. The pinned lexical tokenizer handles all quote styles.
  const linePrefix = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
  const tokenizer = new Tokenizer(linePrefix);
  for (let token = tokenizer.next(), offset = 0; token.kind !== "Eof"; offset += token.text.length, token = tokenizer.next()) {
    if (token.kind === "Comment" || (token.kind === "StringLiteral" && offset + token.text.length >= linePrefix.length && !/["'`]$/.test(token.text.slice(1)))) return null;
  }
  if (word?.text.startsWith("@")) return { from, options: Object.entries(prismaAttributes).filter(([label]) => word.text.startsWith("@@") ? label.startsWith("@@") : !label.startsWith("@@")).map(([label, info]) => ({ label, type: "property", info, detail: "Prisma 8 syntax" })), validFor: /^@@?[\w.]*$/ };
  const options = Object.entries(prismaScalars).map(([label, info]) => ({ label, type: "type", info, detail: "PostgreSQL scalar" }));
  if (context.explicit) for (const symbol of prismaSymbols(context.state.doc.toString()).filter(symbol => symbol.kind !== "FieldDeclaration")) options.push({ label: symbol.name, type: "class", info: symbol.text, detail: "Declared in draft" });
  if (!before.trim()) options.push(...["model", "enum", "type", "namespace"].map(label => ({ label, type: "keyword", info: `Declare a ${label}.`, detail: "Prisma 8 syntax" })));
  return { from, options: [...options, ...(context.explicit ? [
    snippetCompletion("@relation(fields: [${fieldId}], references: [${id}], onDelete: ${Restrict})", { label: "@relation(…)", detail: "Owning relationship", type: "property" }),
    snippetCompletion('@@index([${field}], map: "${index_name}")', { label: "@@index(…)", detail: "Named index", type: "property" }),
  ] : [])], validFor: /^[\w.]*$/ };
}

/** Fold only braced declarations; tokenization skips braces in strings and comments. */
export function prismaFold(text: string, lineFrom: number, lineTo: number): { from: number; to: number } | null {
  if (!/^\s*(?:model|type|enum|native_enum|namespace|types|view)\b/.test(text.slice(lineFrom, lineTo))) return null;
  const tokenizer = new Tokenizer(text.slice(lineFrom));
  let offset = lineFrom, depth = 0, from: number | undefined;
  for (let token = tokenizer.next(); token.kind !== "Eof"; offset += token.text.length, token = tokenizer.next()) {
    if (token.kind === "LBrace") { if (from === undefined) from = offset + 1; depth++; }
    if (token.kind === "RBrace" && --depth === 0 && from !== undefined) return offset > lineTo ? { from, to: offset } : null;
  }
  return null;
}
