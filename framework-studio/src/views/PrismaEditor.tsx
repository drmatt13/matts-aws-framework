import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  hoverTooltip, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, foldService, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { prismaAttributes, prismaCompletions, prismaDefinition, prismaFold, prismaLanguage, prismaScalars } from "./prisma-language";

export interface PrismaEditorDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly code?: string;
}
export interface PrismaEditorCursor { readonly from: number; readonly to: number; readonly line: number; readonly column: number }
export interface PrismaEditorHandle {
  reveal(from: number, to?: number, focus?: boolean): void;
  replace(from: number, to: number, text: string): void;
  replaceDocument(text: string): void;
  undo(): void;
  redo(): void;
  focus(): void;
  getSelection(): { from: number; to: number };
}
export interface PrismaEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCursor?: (cursor: PrismaEditorCursor) => void;
  readonly diagnostics?: readonly PrismaEditorDiagnostic[];
  readonly readOnly?: boolean;
  readonly onFormat?: () => void;
  /** Opens source review. This callback must never save without review. */
  readonly onSave?: () => void;
  readonly className?: string;
  readonly label?: string;
}

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "prisma-token-keyword" },
  { tag: [tags.typeName, tags.className], class: "prisma-token-type" },
  { tag: tags.definition(tags.variableName), class: "prisma-token-definition" },
  { tag: tags.meta, class: "prisma-token-attribute" },
  { tag: tags.string, class: "prisma-token-string" },
  { tag: [tags.number, tags.atom], class: "prisma-token-number" },
  { tag: tags.comment, class: "prisma-token-comment" },
  { tag: tags.function(tags.variableName), class: "prisma-token-function" },
  { tag: tags.invalid, class: "prisma-token-invalid" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "var(--sheet)", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.8", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 18px 0 8px" },
  ".cm-gutters": { border: "none", borderRight: "1px solid var(--rule)", color: "var(--faint)", backgroundColor: "var(--sheet)", paddingRight: "4px" },
  ".cm-activeLineGutter, .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--dev) 5%, transparent)" },
  ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "10px", minWidth: "32px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--dev) 22%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--dev) 14%, transparent)", outline: "1px solid color-mix(in srgb, var(--dev) 30%, transparent)" },
  ".cm-panels": { color: "var(--ink)", backgroundColor: "var(--wash)", fontFamily: "var(--sans)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--rule)" },
  ".cm-tooltip": { border: "1px solid var(--rule-strong)", borderRadius: "6px", backgroundColor: "var(--sheet)", color: "var(--ink)", fontFamily: "var(--sans)", boxShadow: "var(--shadow-popover)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "var(--ink)", backgroundColor: "var(--wash)" },
  ".cm-completionDetail": { color: "var(--graphite)", fontSize: "11px", marginLeft: "12px" },
  ".cm-tooltip.cm-tooltip-hover": { maxWidth: "360px", padding: "10px 12px", fontSize: "12px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--wash)", color: "var(--graphite)", border: "1px solid var(--rule)" },
});

const externalChange = Transaction.userEvent.of("input.external");
/** Minimal splice lets CodeMirror map the cursor through formatting and external document changes. */
export function editorChange(previous: string, next: string): { from: number; to: number; insert: string } | null {
  if (previous === next) return null;
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from++;
  let to = previous.length, end = next.length;
  while (to > from && end > from && previous[to - 1] === next[end - 1]) { to--; end--; }
  return { from, to, insert: next.slice(from, end) };
}
function diagnosticRanges(diagnostics: readonly PrismaEditorDiagnostic[], length: number): Diagnostic[] {
  return diagnostics.map(item => ({ ...item, from: Math.max(0, Math.min(length, item.from)), to: Math.max(0, Math.min(length, Math.max(item.from, item.to))), source: item.code ? `Prisma · ${item.code}` : "Prisma" }));
}

export const PrismaEditor = forwardRef<PrismaEditorHandle, PrismaEditorProps>(function PrismaEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Callbacks are current without reconstructing the editor and destroying undo/selection.
  const latest = useRef(props);
  latest.current = props;
  const readOnly = useRef(new Compartment());
  const reveal = (from: number, to = from, focus = true) => {
    const editor = view.current;
    if (!editor) return;
    const clamp = (offset: number) => Math.max(0, Math.min(editor.state.doc.length, offset));
    editor.dispatch({ selection: EditorSelection.single(clamp(from), clamp(to)), effects: EditorView.scrollIntoView(clamp(from), { y: "center" }) });
    if (focus) editor.focus();
  };
  const replace = (from: number, to: number, text: string) => {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    editor.dispatch({ changes: { from, to, insert: text }, annotations: [Transaction.userEvent.of("input.visual"), isolateHistory.of("full")] });
  };
  useImperativeHandle(ref, () => ({
    reveal, replace,
    replaceDocument(text) {
      const editor = view.current;
      if (!editor || editor.state.readOnly) return;
      const changes = editorChange(editor.state.doc.toString(), text);
      if (changes) editor.dispatch({ changes, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")] });
    },
    undo() { if (view.current) undo(view.current); },
    redo() { if (view.current) redo(view.current); },
    focus() { view.current?.focus(); },
    getSelection() { const selection = view.current?.state.selection.main; return { from: selection?.from ?? 0, to: selection?.to ?? 0 }; },
  }), []);

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: latest.current.value, extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
      rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(), indentUnit.of("  "),
      prismaLanguage, syntaxHighlighting(highlight), theme,
      search({ top: true }), autocompletion({ override: [prismaCompletions] }), lintGutter(),
      foldService.of((state, from, to) => prismaFold(state.doc.toString(), from, to)), foldGutter(),
      readOnly.current.of(EditorState.readOnly.of(!!latest.current.readOnly)),
      EditorView.contentAttributes.of({ "aria-label": latest.current.label ?? "Prisma schema source", "aria-describedby": "prisma-editor-keyboard-help", spellcheck: "false", autocapitalize: "off", autocomplete: "off", "data-gramm": "false" }),
      keymap.of([
        { key: "Mod-s", run: () => { latest.current.onSave?.(); return true; } },
        { key: "Mod-Shift-f", run: () => { latest.current.onFormat?.(); return true; } },
        { key: "Alt-Shift-f", run: () => { latest.current.onFormat?.(); return true; } },
        { key: "Mod-h", run: openSearchPanel },
        { key: "Mod-Alt-f", run: openSearchPanel },
        { key: "F12", run: editor => {
          const definition = prismaDefinition(editor.state.doc.toString(), editor.state.selection.main.head);
          if (definition) reveal(definition.from, definition.to);
          else editor.dispatch({ effects: EditorView.announce.of("No unambiguous definition in this draft.") });
          return true;
        } },
        { key: "Escape", run: editor => { editor.setTabFocusMode(3000); return false; } },
        ...completionKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab,
      ]),
      hoverTooltip((editor, offset) => {
        const line = editor.state.doc.lineAt(offset);
        const within = offset - line.from;
        const expression = /@@?[\w.]+|[A-Za-z_][\w.]*/g;
        for (const match of line.text.matchAll(expression)) {
          if (match.index > within || match.index + match[0].length < within) continue;
          const information = prismaAttributes[match[0]] ?? prismaScalars[match[0]];
          if (!information) return null;
          return { pos: line.from + match.index, end: line.from + match.index + match[0].length, above: true,
            create() { const dom = document.createElement("div"); dom.textContent = information; return { dom }; } };
        }
        return null;
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.isUserEvent("input.external"))) latest.current.onChange(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          const line = update.state.doc.lineAt(selection.head);
          latest.current.onCursor?.({ from: selection.from, to: selection.to, line: line.number, column: selection.head - line.from + 1 });
        }
      }),
    ] }) });
    view.current = editor;
    if (latest.current.diagnostics?.length) editor.dispatch(setDiagnostics(editor.state, diagnosticRanges(latest.current.diagnostics, editor.state.doc.length)));
    return () => { view.current = null; editor.destroy(); };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const changes = editorChange(editor.state.doc.toString(), props.value);
    if (changes) editor.dispatch({ changes, annotations: [externalChange, isolateHistory.of("full")] });
  }, [props.value]);
  useEffect(() => {
    const editor = view.current;
    if (editor) editor.dispatch(setDiagnostics(editor.state, diagnosticRanges(props.diagnostics ?? [], editor.state.doc.length)));
  }, [props.diagnostics]);
  useEffect(() => { view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)) }); }, [props.readOnly]);

  return <div data-prisma-editor data-ui="prisma-editor" className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${props.className ?? ""}`}>
    <div data-ui="prisma-editor-host" className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={host} />
    <span id="prisma-editor-keyboard-help" className="sr-only">Prisma 8 source editor. Tab indents; press Escape then Tab to leave. Control or Command F searches, Control or Command S reviews source changes, F12 goes to a definition. Completion suggests syntax; validation checks the contract.</span>
  </div>;
});
import "../styles/codemirror.css";
