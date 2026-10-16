import ts from "typescript";
import type { LiteralValue } from "../../shared/api";
import { literalKey, unwrap } from "../source/syntax";

/**
 * Text edits that change one property and nothing else.
 *
 * The studio never re-prints a file: it replaces, inserts or removes a span
 * and leaves every other byte where it was — comments, blank lines, quotes,
 * `satisfies`, imports. Each operation works out the layout it is writing into
 * (one line or several, trailing commas or not, indentation) from the
 * properties already there, and refuses rather than guess where a guess could
 * lose something the author wrote.
 */

export type { LiteralValue };

export interface Anchors {
  /** Insert after the last of these present in the object… */
  readonly after: readonly string[];
  /** …otherwise before the first of these present… */
  readonly before: readonly string[];
  /** …otherwise after the last property. */
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The quote this file writes strings with, judged by the first string literal in it. */
export function quoteOf(sourceFile: ts.SourceFile): '"' | "'" {
  let quote: '"' | "'" | undefined;
  const visit = (node: ts.Node): void => {
    if (quote) return;
    if (ts.isStringLiteral(node) && !ts.isImportDeclaration(node.parent)) {
      const first = node.getText(sourceFile)[0];
      if (first === '"' || first === "'") quote = first;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return quote ?? '"';
}

export function formatLiteral(value: LiteralValue, quote: '"' | "'"): string {
  if (typeof value !== "string") return String(value);
  const escaped = value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`).replace(/\n/g, "\\n");
  return `${quote}${escaped}${quote}`;
}

function formatKey(key: string, quote: '"' | "'"): string {
  return IDENTIFIER.test(key) ? key : formatLiteral(key, quote);
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line;
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf("\n", position - 1) + 1;
}

/** The position of the line break ending the line `position` is on, before a `\r`. */
function lineBreak(text: string, position: number): number {
  const index = text.indexOf("\n", position);
  if (index === -1) return text.length;
  return text[index - 1] === "\r" ? index - 1 : index;
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Where a property's separating comma ends, if it has one. */
function commaAfter(text: string, end: number): { readonly present: boolean; readonly end: number } {
  let index = end;
  while (text[index] === " " || text[index] === "\t") index += 1;
  return text[index] === "," ? { present: true, end: index + 1 } : { present: false, end };
}

/** Only whitespace or a comment between two positions. */
function onlyTrivia(text: string, start: number, end: number): boolean {
  const rest = text.slice(start, end).trim();
  return rest === "" || rest.startsWith("//") || (rest.startsWith("/*") && rest.endsWith("*/"));
}

/** Replaces the literal a property holds, keeping any `as const` or parentheses around it. */
export function replaceValue(
  text: string,
  sourceFile: ts.SourceFile,
  property: ts.PropertyAssignment,
  value: LiteralValue,
): string {
  const literal = unwrap(property.initializer);
  const written = literal.getText(sourceFile)[0];
  const quote = written === '"' || written === "'" ? written : quoteOf(sourceFile);
  const start = literal.getStart(sourceFile);
  return `${text.slice(0, start)}${formatLiteral(value, quote)}${text.slice(literal.end)}`;
}

/**
 * Inserts `segments` into `container`: `["deploy"]` adds `deploy: value`, and
 * `["cloud", "subnet"]` adds `cloud: { subnet: value }` when `cloud` is missing.
 */
export function insertProperty(
  text: string,
  sourceFile: ts.SourceFile,
  container: ts.ObjectLiteralExpression,
  segments: readonly string[],
  value: LiteralValue,
  anchors: Anchors,
): string {
  const quote = quoteOf(sourceFile);
  const property = segments
    .slice(0, -1)
    .reduceRight(
      (inner, segment) => `${formatKey(segment, quote)}: { ${inner} }`,
      `${formatKey(segments[segments.length - 1]!, quote)}: ${formatLiteral(value, quote)}`,
    );
  const properties = container.properties;
  const containerStart = container.getStart(sourceFile);

  if (properties.length === 0) {
    return `${text.slice(0, containerStart)}{ ${property} }${text.slice(container.end)}`;
  }

  const singleLine = lineOf(sourceFile, containerStart) === lineOf(sourceFile, container.end - 1);
  const keyed = properties.map((element) => ({ element, key: literalKey(element) }));
  const after = [...keyed].reverse().find(({ key }) => key !== undefined && anchors.after.includes(key))?.element;
  const before = after ? undefined : keyed.find(({ key }) => key !== undefined && anchors.before.includes(key))?.element;
  const anchor = after ?? before ?? properties[properties.length - 1]!;
  const placeAfter = before === undefined;

  if (placeAfter) {
    const comma = commaAfter(text, anchor.end);
    const isLast = anchor === properties[properties.length - 1];
    const breakAt = lineBreak(text, comma.end);
    const ownLine = !singleLine && onlyTrivia(text, comma.end, breakAt) &&
      text.slice(lineStart(text, anchor.getStart(sourceFile)), anchor.getStart(sourceFile)).trim() === "";
    if (!ownLine) {
      // One line, or a layout with something after the anchor on its line: write inline.
      return comma.present
        ? `${text.slice(0, comma.end)} ${property},${text.slice(comma.end)}`
        : `${text.slice(0, anchor.end)}, ${property}${text.slice(anchor.end)}`;
    }
    const start = anchor.getStart(sourceFile);
    const indent = text.slice(lineStart(text, start), start);
    const trailing = !isLast || comma.present ? "," : "";
    const withComma = comma.present ? text : `${text.slice(0, anchor.end)},${text.slice(anchor.end)}`;
    const insertAt = comma.present ? breakAt : breakAt + 1;
    return `${withComma.slice(0, insertAt)}${eolOf(text)}${indent}${property}${trailing}${withComma.slice(insertAt)}`;
  }

  const leading = ts.getLeadingCommentRanges(text, anchor.pos) ?? [];
  const anchorStart = leading[0]?.pos ?? anchor.getStart(sourceFile);
  const start = lineStart(text, anchorStart);
  if (singleLine || text.slice(start, anchorStart).trim() !== "") {
    const at = anchor.getStart(sourceFile);
    return `${text.slice(0, at)}${property}, ${text.slice(at)}`;
  }
  const indent = text.slice(start, anchorStart);
  return `${text.slice(0, start)}${indent}${property},${eolOf(text)}${text.slice(start)}`;
}

/** Removes a property, its separator and its line. Refuses one that carries a comment. */
export function removeProperty(
  text: string,
  sourceFile: ts.SourceFile,
  container: ts.ObjectLiteralExpression,
  property: ts.ObjectLiteralElementLike,
): string {
  const start = property.getStart(sourceFile);
  const comma = commaAfter(text, property.end);
  if ((ts.getLeadingCommentRanges(text, property.pos) ?? []).length > 0 || (ts.getTrailingCommentRanges(text, comma.end) ?? []).length > 0) {
    throw new Error("This property has a comment beside it. Remove it in your editor, so the comment's fate is your decision.");
  }
  const containerStart = container.getStart(sourceFile);
  const singleLine = lineOf(sourceFile, containerStart) === lineOf(sourceFile, container.end - 1);
  const first = lineStart(text, start);
  const breakAt = lineBreak(text, comma.end);

  let removed: { readonly from: number; readonly to: number };
  if (!singleLine && text.slice(first, start).trim() === "" && text.slice(comma.end, breakAt).trim() === "") {
    const newline = text.indexOf("\n", breakAt);
    removed = { from: first, to: newline === -1 ? text.length : newline + 1 };
  } else if (comma.present) {
    let to = comma.end;
    while (text[to] === " " || text[to] === "\t") to += 1;
    removed = { from: start, to };
  } else {
    const index = container.properties.indexOf(property);
    const previous = index > 0 ? container.properties[index - 1] : undefined;
    removed = previous ? { from: previous.end, to: property.end } : { from: start, to: property.end };
  }

  const result = `${text.slice(0, removed.from)}${text.slice(removed.to)}`;
  const end = container.end - (removed.to - removed.from);
  const inner = result.slice(containerStart + 1, end - 1);
  return inner.trim() === "" ? `${result.slice(0, containerStart)}{}${result.slice(end)}` : result;
}
