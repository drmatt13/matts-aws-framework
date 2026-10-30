import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CommentReviewOptions, SourceCommentReview } from "../../shared/api";
import { sha256, toRelative } from "../files";
import { EditError } from "./io";

interface ReviewContext {
  readonly root: string;
  readonly choices: Readonly<Record<string, "keep" | "remove">>;
  readonly originals: Map<string, ts.SourceFile>;
  readonly reviews: Map<string, SourceCommentReview>;
  readonly removedPositions: Set<string>;
}
const context = new AsyncLocalStorage<ReviewContext>();

/** Each batch has its own comment decisions, including concurrent async callers. */
export function withCommentReview<T>(root: string, options: CommentReviewOptions | undefined, run: () => T): T {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "comments"))) throw new EditError(400, "Invalid comment review options.");
  const choices = options?.comments ?? {};
  if (!choices || typeof choices !== "object" || Array.isArray(choices) || Object.entries(choices).some(([id, choice]) => !/^[a-f0-9]{64}$/.test(id) || choice !== "keep" && choice !== "remove")) throw new EditError(400, "Choose Keep or Remove for each reviewed comment.");
  return context.run({ root, choices, originals: new Map(), reviews: new Map(), removedPositions: new Set() }, run);
}

export function reviewedComments(deferUnusedChoices = false): readonly SourceCommentReview[] {
  const state = context.getStore();
  if (!state) return [];
  if (!deferUnusedChoices && Object.keys(state.choices).some(id => !state.reviews.has(id))) throw new EditError(409, "The comments changed since this review. Review the latest source and choose again.");
  return [...state.reviews.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

/** A source worker shares choices; the owning batch validates their complete inventory. */
export function currentCommentOptions(): CommentReviewOptions | undefined {
  const state = context.getStore(); return state ? { comments: state.choices } : undefined;
}
export function removedCommentPositions(): readonly string[] {
  return [...(context.getStore()?.removedPositions ?? [])];
}
/** Internal worker continuation, never populated from an HTTP request. */
export function continueCommentPositions(positions: readonly string[]): void {
  const state = context.getStore();
  if (!state && positions.length) throw new EditError(422, "Comment positions require an owning source review.");
  positions.forEach(position => state!.removedPositions.add(position));
}
export function absorbReviewedComments(comments: readonly SourceCommentReview[]): void {
  const state = context.getStore();
  if (!state && comments.length) throw new EditError(422, "Source comment review requires the owning batch.");
  for (const comment of comments) {
    const previous = state!.reviews.get(comment.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(comment)) throw new EditError(409, "The comments changed during source review. Your draft is preserved; review again.");
    state!.reviews.set(comment.id, comment);
  }
}

/** Locate a separator through trivia without mistaking comment contents for code. */
export function followingComma(text: string, position: number): Span | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  scanner.setTextPos(position);
  return scanner.scan() === ts.SyntaxKind.CommaToken ? { from: scanner.getTokenPos(), to: scanner.getTextPos() } : undefined;
}

/** Use parser token boundaries: comment-like text in strings/regexes is source data. */
function commentRanges(source: ts.SourceFile): readonly ts.CommentRange[] {
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (position: number) => {
    for (const range of [...ts.getLeadingCommentRanges(source.text, position) ?? [], ...ts.getTrailingCommentRanges(source.text, position) ?? []]) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node): void => { collect(node.pos); collect(node.end); for (const child of node.getChildren(source)) visit(child); };
  visit(source);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

interface Span { readonly from: number; readonly to: number }

/** Remove code while offering a bounded decision for every comment it carries.
 * Outside a batch review, the original conservative refusal remains in force. */
export function removeWithComments(text: string, source: ts.SourceFile, node: ts.Node, spans: readonly Span[], trailingPosition = node.end): string {
  const associated = new Map<number, ts.CommentRange>();
  for (const range of [...ts.getLeadingCommentRanges(text, node.pos) ?? [], ...ts.getTrailingCommentRanges(text, trailingPosition) ?? []]) associated.set(range.pos, range);
  const nodeStart = node.getStart(source);
  for (const range of commentRanges(source)) if (range.pos >= nodeStart && range.end <= node.end || spans.some(span => range.pos < span.to && range.end > span.from) || range.kind === ts.SyntaxKind.MultiLineCommentTrivia && range.pos >= node.pos && range.end <= nodeStart && !/[\r\n]/.test(text.slice(range.end, nodeStart))) associated.set(range.pos, range);
  if (!associated.size) return applySpans(text, spans, []);
  const state = context.getStore();
  if (!state) throw new Error("This source has a comment beside or inside it. Review this change in Studio to keep or remove the comment, or resolve it in your editor.");
  const absolute = path.resolve(state.root, source.fileName);
  let original = state.originals.get(absolute);
  if (!original) {
    let saved: string;
    try { saved = readFileSync(absolute, "utf8"); } catch { saved = text; }
    original = ts.createSourceFile(absolute, saved, ts.ScriptTarget.Latest, true);
    state.originals.set(absolute, original);
  }
  const originalRanges = commentRanges(original);
  const allCurrent = commentRanges(source);
  const retained: ts.CommentRange[] = [];
  const removed = [...spans];
  const removedPositions: string[] = [];
  for (const range of associated.values()) {
    const prose = text.slice(range.pos, range.end);
    const occurrence = allCurrent.filter(item => item.pos < range.pos && text.slice(item.pos, item.end) === prose).length;
    const origin = originalRanges.filter(item => original!.text.slice(item.pos, item.end) === prose && !state.removedPositions.has(`${absolute}:${item.pos}`))[occurrence];
    // New comments are not authored by these transformations. An uncertain match
    // is kept and requires manual resolution rather than inheriting a decision.
    const at = origin?.pos ?? range.pos;
    const location = original.getLineAndCharacterOfPosition(Math.min(at, original.text.length));
    const file = toRelative(state.root, absolute);
    const id = sha256(`${file}\0${sha256(original.text)}\0${at}\0${prose}`);
    const manualReason = /@ts-(?:ignore|expect-error|nocheck|check)\b|\b(?:eslint|biome|deno-lint)-|\b(?:prettier|istanbul|c8)\s+ignore|[#@]\s*(?:sourceMappingURL|sourceURL)=|[#@]__\w+__|\bwebpack\w*\s*:|@vite-\w+/.test(prose)
      ? "This comment controls tooling or diagnostics. Move or remove it in your editor so it cannot apply to different code."
      : !origin ? "This comment could not be matched to saved source. Resolve it in your editor, then retry the review." : undefined;
    const resolution = manualReason ? "keep" : state.choices[id] ?? "keep";
    const line = location.line + 1, column = location.character + 1;
    state.reviews.set(id, { id, file, line, column, text: prose, resolution, vscodeUrl: `vscode://file/${encodeURI(absolute)}:${line}:${column}`, ...(manualReason ? { manualReason } : {}) });
    if (resolution === "keep") retained.push(range);
    else {
      if (origin) removedPositions.push(`${absolute}:${origin.pos}`);
      const first = text.lastIndexOf("\n", range.pos - 1) + 1;
      const newline = text.indexOf("\n", range.end);
      const last = newline === -1 ? text.length : newline;
      removed.push(text.slice(first, range.pos).trim() === "" && text.slice(range.end, last).trim() === "" ? { from: first, to: newline === -1 ? last : newline + 1 } : { from: range.pos, to: range.end });
    }
  }
  removedPositions.forEach(position => state.removedPositions.add(position));
  return applySpans(text, removed, retained);
}

function applySpans(text: string, spans: readonly Span[], retained: readonly ts.CommentRange[]): string {
  const merged: { from: number; to: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to);
    else merged.push({ ...span });
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const span of merged.reverse()) {
    const comments = retained.filter(range => range.pos >= span.from && range.end <= span.to).sort((a, b) => a.pos - b.pos);
    const first = text.lastIndexOf("\n", span.from - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(first))![0];
    let replacement = comments.map(range => text.slice(range.pos, range.end)).join(`${eol}${indent}`);
    if (replacement && span.from === first) replacement = indent + replacement;
    if (comments.at(-1)?.kind === ts.SyntaxKind.SingleLineCommentTrivia && !/^[ \t]*\r?\n/.test(text.slice(span.to))) replacement += `${eol}${indent}`;
    else if (replacement && !/\s/.test(text[span.to] ?? " ")) replacement += " ";
    text = text.slice(0, span.from) + replacement + text.slice(span.to);
  }
  return text;
}
