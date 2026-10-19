import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CdkLinkIndex, ModelEdge } from "../../shared/model";
import type { StudioState } from "../snapshot";
import type { SourceFiles } from "../source";
import { scanCdkLinks } from "../source/cdk-links";
import { readLinkSites } from "../source/catalog";
import { literalKey } from "../source/syntax";
import { assertResourceFile } from "../resources-source";
import { removeProperty } from "./splice";
import { pruneImports, removeElement, removeStatement } from "./source-cleanup";

/** Native trigger identity independent of offsets, so an edit elsewhere in the file still matches. */
export function nativeSignature(index: CdkLinkIndex): string[] {
  return [
    ...index.edges.filter((edge) => edge.relation === "trigger" && edge.provenance === "source").map((edge) => `trigger|${edge.from}|${edge.to}|${edge.label}|${edge.source?.file}`),
    ...index.manualWiring.map((item) => `manual|${item.resource}|${item.reason}|${item.source.file}`),
  ].sort();
}

/** Studio writes CDK source only in a linked catalog stack's own file. */
export function assertStackFile(root: string, state: StudioState, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  const owned = [...state.built.catalog.values()].some((entry) => entry.stack?.location?.file === normalized);
  if (!owned || !/^cdk-app\/lib\/[A-Za-z0-9._/-]+\.ts$/.test(normalized) || normalized.split("/").includes("..")) throw new Error(`${normalized} is not a linked stack file Studio may edit.`);
  const file = path.resolve(root, normalized);
  assertResourceFile(root, file);
  return file;
}

/** Scan proposed stack text with the same conservative scanner as the snapshot. */
export function scanWith(root: string, state: StudioState, overrides: Readonly<Record<string, string>>): CdkLinkIndex {
  const read = (file: string) => { const absolute = path.resolve(root, file); return overrides[absolute] ?? readFileSync(absolute, "utf8"); };
  // Link sites are matched by offset, so they are re-read from the same proposed text.
  return scanCdkLinks(root, state.built.catalog, Object.fromEntries(readLinkSites(root, read)), read);
}

function nodeAt(source: ts.SourceFile, start: number, end: number, accept: (node: ts.Node) => boolean): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found || node.end < start || node.pos > end) return;
    if (node.getStart(source) === start && node.end === end && accept(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Deletes recognized native wiring exactly. Spans come from the current snapshot, never the client. */
export function planNativeRemovals(root: string, state: StudioState, edgeIds: readonly string[], files: SourceFiles): { readonly changes: ReadonlyMap<string, string>; readonly removed: readonly ModelEdge[] } {
  const removed = edgeIds.map((id) => {
    const edge = state.snapshot.source.cdkLinks.edges.find((item) => item.id === id && item.relation === "trigger" && item.provenance === "source");
    if (!edge?.source) throw new Error("This native trigger is no longer in source. Refresh and review again.");
    if (!edge.removal || "refused" in edge.removal) throw new Error(edge.removal && "refused" in edge.removal ? edge.removal.refused : "This native trigger must be removed in source.");
    return edge;
  });
  const changes = new Map<string, string>();
  for (const relative of new Set(removed.map((edge) => edge.source!.file))) {
    const file = assertStackFile(root, state, relative);
    const original = files.text(file);
    let text = original;
    const spans = removed.filter((edge) => edge.source!.file === relative).map((edge) => edge.removal as Extract<ModelEdge["removal"], { kind: string }>)
      .filter((span, index, all) => all.findIndex((other) => other.start === span.start) === index).sort((a, b) => b.start - a.start);
    for (const span of spans) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const node = nodeAt(source, span.start, span.end, (item) => span.kind === "property" ? ts.isPropertyAssignment(item) && ts.isObjectLiteralExpression(item.parent) : span.kind === "statement" ? ts.isExpressionStatement(item) : ts.isArrayLiteralExpression(item.parent));
      if (!node) throw new Error(`${relative} no longer matches the reviewed wiring. Refresh and review again.`);
      if (span.kind === "statement") text = removeStatement(text, node as ts.Statement, source);
      else if (span.kind === "element") text = removeElement(text, node.parent as ts.ArrayLiteralExpression, node as ts.Expression, source);
      else {
        const container = node.parent as ts.ObjectLiteralExpression;
        const containerStart = container.getStart(source);
        text = removeProperty(text, source, container, node as ts.PropertyAssignment);
        // Drop an emptied lambdaTriggers object unless a comment makes that the author's call.
        const next = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const emptied = nodeAt(next, containerStart, containerStart + 2, (item) => ts.isObjectLiteralExpression(item) && !item.properties.length);
        const owner = emptied?.parent;
        if (owner && ts.isPropertyAssignment(owner) && literalKey(owner) === "lambdaTriggers" && ts.isObjectLiteralExpression(owner.parent)) {
          try { text = removeProperty(text, next, owner.parent, owner); } catch { /* keep `lambdaTriggers: {}` beside its comment */ }
        }
      }
    }
    text = pruneImports(file, original, text);
    if (ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics?.length) throw new Error(`Removing this wiring would not parse in ${relative}.`);
    changes.set(file, text);
  }
  return { changes, removed };
}
