import { AlertTriangle, Check, CircleHelp, Code2, Columns2, Database as DatabaseIcon, ExternalLink, FileCode2, History, Maximize2, Minimize2, Table2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { ApiError, call } from "../api";
import type { DatabaseObservation, DatabaseSourceReview, DatabaseValidation, DatabaseWorkbench, DatabaseSaveResult } from "../../shared/database-workbench";
import { DatabaseSession } from "../database-session";
import { DatabaseDiagram, type SchemaSelection } from "./DatabaseDiagram";
import { PrismaEditor, type PrismaEditorHandle } from "./PrismaEditor";
import { DatabaseHistory } from "./DatabaseHistory";
import { DatabaseEvidence } from "./DatabaseEvidence";
import { WorkbenchDialog, SourceComparison } from "./WorkbenchUI";
import { useStudio } from "../studio";
import { DatabaseSql } from "./DatabaseSql";
import { DataRetention } from "./DataRetention";
import { NavigationStrip } from "./NavigationStrip";

const basePath = "/database/workbench";
export const databaseApi = {
  load: async (signal?: AbortSignal) => {
    const result = await call<DatabaseWorkbench>(basePath, undefined, signal);
    if (typeof result.source !== "string" || typeof result.revision !== "string" || !result.validation || !result.capabilities || !Array.isArray(result.targets)) throw new ApiError(409, "The running server does not support this database workbench. Restart npm run studio in this checkout, then retry. Your draft is preserved.");
    return result;
  },
  validate: (source: string, signal?: AbortSignal) => call<DatabaseValidation>(`${basePath}/validate`, { source }, signal),
  review: (source: string, expectedRevision: string) => call<DatabaseSourceReview>(`${basePath}/review`, { source, expectedRevision }),
  save: (reviewId: string) => call<DatabaseSaveResult>(`${basePath}/save`, { reviewId }),
  format: (source: string) => call<{ source: string }>(`${basePath}/format`, { source }),
  inspect: (targetId: string, expectedRevision: string, historyRevision: string) => call<DatabaseObservation>(`${basePath}/inspect`, { targetId, expectedRevision, historyRevision }),
};

export function Database() {
  const { snapshot, selected, toast, toasts } = useStudio();
  const [session] = useState(() => new DatabaseSession(databaseApi));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [loadingError, setLoadingError] = useState<string>();
  const [tab, setTab] = useState<"schema" | "history" | "database" | "sql" | "retention">("schema");
  const [mode, setMode] = useState<"split" | "source" | "diagram">("split");
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [selection, setSelection] = useState<SchemaSelection | undefined>(() => selected?.startsWith("schema:") ? { table: selected } : undefined);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [ratio, setRatio] = useState(49);
  const [formatting, setFormatting] = useState(false);
  const [help, setHelp] = useState(false);
  const [guard, setGuard] = useState<"discard" | "navigation">();
  const pendingNavigation = useRef<((block: boolean) => void) | undefined>(undefined);
  const editor = useRef<PrismaEditorHandle>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const fullscreenReturn = useRef<{ mode: typeof mode } | undefined>(undefined);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const layoutControls = useRef<HTMLDivElement>(null);
  const validationTrigger = useRef<HTMLButtonElement>(null);
  const fullscreenPending = useRef(false);
  const split = useRef<HTMLDivElement>(null);
  const sourceNow = useRef(state.source); sourceNow.current = state.source;
  const loadRequest = useRef(0);
  const load = async () => {
    const request = ++loadRequest.current;
    try { const next = await databaseApi.load(); if (request === loadRequest.current) { session.sync(next); setLoadingError(undefined); } }
    catch (error) { if (request === loadRequest.current) setLoadingError(String(error instanceof Error ? error.message : error)); }
  };
  useEffect(() => { void load(); }, [snapshot.revision]);
  useEffect(() => {
    // Private connections and migration files can change without changing the graph.
    const onFocus = () => void load(); window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (!state.baseline || state.validationVersion === state.version || state.busy) return;
    const timer = window.setTimeout(() => void session.validate(), 650);
    return () => window.clearTimeout(timer);
  }, [state.version, state.baseline, state.busy]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    const element = workbench.current;
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === element;
      setFullscreen(active);
      if (!active && fullscreenReturn.current) {
        const previous = fullscreenReturn.current;
        fullscreenReturn.current = undefined;
        setMode(previous.mode);
        window.requestAnimationFrame(() => fullscreenTrigger.current?.focus());
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  const toggleFullscreen = async () => {
    const element = workbench.current;
    if (!element || fullscreenPending.current) return;
    fullscreenPending.current = true;
    setFullscreenError(false);
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else {
        fullscreenReturn.current = { mode };
        await element.requestFullscreen();
      }
    } catch {
      if (fullscreenReturn.current && document.fullscreenElement !== element) {
        setMode(fullscreenReturn.current.mode);
        fullscreenReturn.current = undefined;
      }
      setFullscreenError(true);
    } finally { fullscreenPending.current = false; }
  };
  useEffect(() => {
    const onExit = (event: BeforeUnloadEvent) => { if (session.dirty || session.getSnapshot().busy) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", onExit); return () => window.removeEventListener("beforeunload", onExit);
  }, [session]);
  useBlocker({ enableBeforeUnload: false, shouldBlockFn: ({ current, next }) => {
    if (current.pathname === next.pathname || !session.dirty && !state.busy) return false;
    return new Promise<boolean>(resolve => { pendingNavigation.current = resolve; setGuard("navigation"); });
  } });
  const closeGuard = () => { pendingNavigation.current?.(true); pendingNavigation.current = undefined; setGuard(undefined); };
  const discard = () => { session.discard(); pendingNavigation.current?.(false); pendingNavigation.current = undefined; setGuard(undefined); if (guard === "discard") window.requestAnimationFrame(() => validationTrigger.current?.focus()); };
  const format = async () => {
    const source = state.source;
    setFormatting(true);
    try { const result = await databaseApi.format(source); if (sourceNow.current === source) editor.current?.replaceDocument(result.source); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), "refuse"); }
    finally { setFormatting(false); }
  };
  const revealSource = (from: number, to: number) => {
    if (mode === "diagram") { setMode("split"); window.requestAnimationFrame(() => editor.current?.reveal(from, to)); }
    else editor.current?.reveal(from, to);
  };
  const locate = (source: SourceLocation) => { if (session.currentValid) revealSource(source.start, source.end); };
  const cursorChanged = (position: { from: number; to: number; line: number; column: number }) => {
    setCursor({ line: position.line, column: position.column });
    if (!session.currentValid) return;
    const schema = session.getSnapshot().diagram;
    const table = schema?.tables.find(item => position.from >= item.source.start && position.from <= item.source.end);
    if (!table) return;
    const field = table.columns.find(item => position.from >= item.source.start && position.from <= item.source.end);
    const relation = schema?.relations.find(item => position.from >= item.source.start && position.from <= item.source.end);
    setSelection({ table: table.id, field: field?.name, relation: relation?.id });
  };
  const save = async () => { const result = await session.save(); if (result) { toast(result.message, result.refresh === "complete" ? "plain" : "refuse"); void load(); } };
  const validationCurrent = state.validationVersion === state.version;
  const valid = validationCurrent && state.validation?.valid;
  const savedValidation = state.baseline?.validation;
  const storageChanged = valid && savedValidation?.storageHash !== state.validation?.storageHash;
  const behaviorChanged = valid && savedValidation?.executionHash !== state.validation?.executionHash;
  const status = state.validating ? "Validating…" : !validationCurrent ? "Validation pending" : valid ? "Valid Prisma 8" : "Invalid draft";
  const workspaceControls = <div className="workbench-workspace-controls">
    <div ref={layoutControls} className="workbench-view-modes" role="group" aria-label="Editing layout">{[{ id: "source" as const, label: "Focus source", icon: Code2 }, { id: "split" as const, label: "Split source and diagram", icon: Columns2 }, { id: "diagram" as const, label: "Focus diagram", icon: Table2 }].map(item => <button className="icon-button" key={item.id} title={item.label} aria-label={item.label} aria-pressed={mode === item.id} onClick={() => { setMode(item.id); window.requestAnimationFrame(() => layoutControls.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()); }}><item.icon size={15} aria-hidden /></button>)}</div>
    <button ref={fullscreenTrigger} className="icon-button" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen schema workspace"} title={!document.fullscreenEnabled ? "Fullscreen is unavailable in this browser" : fullscreen ? "Exit fullscreen · Esc" : "Fullscreen schema workspace"} disabled={!document.fullscreenEnabled} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}</button>
  </div>;
  const sourceStatus = <div className="workbench-source-meta"><span className={`workbench-badge ${session.dirty ? "modified" : ""}`}>{session.dirty ? "Modified draft" : "Saved source"}</span><span className={`workbench-badge ${validationCurrent && !valid ? "invalid" : ""}`} role="status">{valid ? <Check size={12} aria-hidden /> : validationCurrent ? <AlertTriangle size={12} aria-hidden /> : null}{status}</span></div>;
  const sourceActions = <div className="workbench-source-tools">
    <button className="quiet" disabled={formatting || !!state.busy} title="Format draft · Shift+Alt+F" onClick={() => void format()}>{formatting ? "Formatting…" : "Format"}</button>
    <div className="workbench-actions"><button ref={validationTrigger} className="quiet" aria-label="Validate draft" disabled={!!state.busy || formatting} onClick={() => void session.validate()}>Validate</button>{session.dirty ? <button className="quiet" disabled={!!state.busy} onClick={() => setGuard("discard")}>Discard</button> : null}<button className="primary" aria-label="Review source changes" disabled={!session.dirty || !!state.busy || session.conflict || validationCurrent && !valid} onClick={() => void session.review()}>{state.busy === "review" ? "Preparing review…" : "Review changes"}</button></div>
  </div>;
  return <div className="database-view database-workbench" ref={workbench}>
    <h1 className="sr-only">Database</h1>
    <div className="workspace-toolbar workbench-navigation"><NavigationStrip className="workbench-tabs" label="Database workspace" activeKey={tab}>{[{ id: "schema" as const, label: "Schema", icon: FileCode2 }, { id: "history" as const, label: "History & migrations", icon: History }, { id: "database" as const, label: "Database status", icon: DatabaseIcon }, { id: "sql" as const, label: "Saved SQL", icon: Code2 }, { id: "retention" as const, label: "Data retention", icon: DatabaseIcon }].map(item => <button key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}><item.icon size={15} aria-hidden />{item.label}</button>)}</NavigationStrip><button className="icon-button workbench-help-toggle" title="How this works" aria-label="How this works" aria-haspopup="dialog" aria-expanded={help} aria-controls={help ? "database-workbench-help" : undefined} onClick={() => setHelp(true)}><CircleHelp size={16} aria-hidden /></button></div>
    {help ? <WorkbenchDialog id="database-workbench-help" className="workbench-help" title="How this works" onClose={() => setHelp(false)} footer={<button className="primary" onClick={() => setHelp(false)}>Got it</button>}><p className="workbench-help-flow">Source → review → migration → database</p><ol><li><strong>Edit and review.</strong> Edit the Prisma draft, validate it, then review the exact source change before saving.</li><li><strong>Plan a migration.</strong> Use History &amp; migrations to plan offline from an explicit historical baseline.</li><li><strong>Inspect a database.</strong> Choose a target in Database status to compare migration markers with its physical schema.</li></ol><p>Saving only writes <code>contract.prisma</code>. Generation, migration packages, database application and deployment are separate actions.</p><p className="muted">New fields may also need repository, GraphQL, authorization and frontend changes; Studio does not expose them automatically.</p>{state.baseline?.capabilities.notes.length ? <details className="workbench-help-capabilities"><summary>Editor capabilities</summary>{state.baseline.capabilities.notes.map(note => <p className="small muted" key={note}>{note}</p>)}</details> : null}</WorkbenchDialog> : null}
    {loadingError && tab !== "sql" && tab !== "retention" ? <div className="workbench-notice warning" role="alert">{loadingError} Your draft is preserved. <button className="linkish" onClick={() => void load()}>Retry loading source</button></div> : null}
    {fullscreenError ? <div className="workbench-notice warning" role="alert">The browser could not change fullscreen mode. Use the source, split or diagram layout controls to adjust your workspace. <button className="linkish" onClick={() => setFullscreenError(false)}>Dismiss</button></div> : null}
    {state.error ? <div className="workbench-notice warning" role="alert">{state.error} <button className="linkish" onClick={() => void load()}>Check latest saved source</button></div> : null}
    {session.conflict ? <section className="workbench-notice warning" role="alert"><strong>Saved source changed outside this session.</strong> Your draft and undo history are preserved. <button className="quiet" disabled={!!state.busy} onClick={() => setGuard("discard")}>Load saved source</button><button className="quiet" disabled={!!state.busy} onClick={() => { session.useLatestBaseline(); void session.review(); }}>Review draft against latest source</button></section> : null}
    {!state.baseline ? tab !== "sql" && tab !== "retention" ? <div className="workbench-loading" role="status">{loadingError ? "Source is unavailable. Resolve the error and retry." : "Loading the authored Prisma contract…"}</div> : null : <>
    <section hidden={tab !== "schema"} className="workbench-schema">
      <div className="workbench-split" data-mode={mode} ref={split} style={{ "--source-width": `${ratio}%` } as CSSProperties}>
        <section className="workbench-source-pane" aria-label="Prisma source pane"><header className="workbench-panel-header"><div className="workbench-pane-heading"><span title={snapshot.schema.file}><Code2 size={15} aria-hidden />Prisma source</span>{mode !== "diagram" ? sourceStatus : null}<a className="icon-button" aria-label="Open in editor" title="Open contract.prisma in editor" href={editorLink(snapshot.repositoryRoot, { file: snapshot.schema.file, line: 1, column: 1, start: 0, end: 0 })}><ExternalLink size={15} aria-hidden /></a>{mode === "source" ? workspaceControls : null}</div>{mode !== "diagram" ? sourceActions : null}</header>
          <PrismaEditor ref={editor} value={state.source} onChange={source => session.setSource(source)} onCursor={cursorChanged} diagnostics={validationCurrent ? state.validation?.diagnostics : []} readOnly={!!state.busy} onSave={() => void session.review()} onFormat={() => void format()} />
          <footer className="workbench-editor-status"><span>Ln {cursor.line}, Col {cursor.column}</span><span>Prisma 8 · static suggestions</span><span>⌘/Ctrl F · ⌘/Ctrl H</span></footer>
        </section>
        <div className="workbench-resizer" role="separator" tabIndex={0} aria-label="Resize source and diagram" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={ratio} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setRatio(value => event.key === "Home" ? 25 : event.key === "End" ? 75 : Math.max(25, Math.min(75, value + (event.key === "ArrowLeft" ? -2 : 2)))); } }} onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !split.current) return; const bounds = split.current.getBoundingClientRect(); setRatio(Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
        <section className="workbench-diagram-pane" aria-label="Schema diagram pane"><header className="workbench-panel-header"><div className="workbench-pane-heading"><span><Table2 size={15} aria-hidden />Schema diagram</span>{mode === "diagram" ? sourceStatus : null}{mode !== "source" ? workspaceControls : null}</div>{mode === "diagram" ? sourceActions : null}</header>{state.diagram ? <DatabaseDiagram schema={state.diagram} selection={selection} onSelect={setSelection} onLocate={locate} retained={!valid} /> : <p className="empty">Validate a model to see its diagram.</p>}</section>
      </div>
      {session.dirty && valid ? <p className="workbench-impact small muted" role="status">{storageChanged ? "Storage contract changed. After saving, plan and review a forward migration; existing rows may need a backfill." : behaviorChanged ? "Execution behavior changed with no storage change. Regenerate artifacts and check application behavior after saving." : "Source changed; storage and execution contracts are unchanged."}</p> : null}
      {validationCurrent && state.validation?.diagnostics.length ? <section className="workbench-diagnostics" aria-label="Prisma diagnostics"><h2>Diagnostics</h2>{state.validation.diagnostics.map((diagnostic, index) => <button key={index} className={`workbench-diagnostic ${diagnostic.severity}`} onClick={() => { revealSource(diagnostic.from, diagnostic.to); }}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span><code>line {state.source.slice(0, diagnostic.from).split("\n").length}</code></button>)}</section> : null}
    </section>
    <section hidden={tab !== "history"}><DatabaseHistory snapshotRevision={snapshot.revision} active={tab === "history"} saved={state.baseline} draft={state.source} draftValidation={valid ? state.validation : undefined} dirty={session.dirty} onInstalled={() => { session.invalidateObservation(); void load(); }} /></section>
    <section hidden={tab !== "database"}><DatabaseEvidence active={tab === "database"} workbench={state.latest ?? state.baseline} session={session} observation={state.observation} dirty={session.dirty} onRefresh={() => void load()} /></section>
    </>}
    <section hidden={tab !== "sql"}><DatabaseSql active={tab === "sql"} /></section>
    {tab === "retention" ? <DataRetention kind="database" /> : null}
    {state.review ? <WorkbenchDialog title="Review source changes" busy={state.busy === "save"} onClose={() => session.closeReview()} footer={<><button className="quiet" autoFocus disabled={!!state.busy} onClick={() => session.closeReview()}>Back to editing</button><button className="primary" disabled={!!state.busy || session.conflict} onClick={() => void save()}>{state.busy === "save" ? "Saving…" : "Save schema"}</button></>}><p>Review the complete source before saving. The file revision and Prisma validation are checked again before writing.</p><ul>{state.review.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><SourceComparison before={state.review.before} after={state.review.after} /><p className="small muted">After saving, generate application artifacts and review downstream types, repositories, GraphQL exposure and writable-field policies. Plan a migration separately when storage changes.</p></WorkbenchDialog> : null}
    {guard ? <WorkbenchDialog title={guard === "navigation" ? "Leave your schema draft?" : "Discard schema draft?"} onClose={closeGuard} busy={!!state.busy} footer={<><button className="quiet" autoFocus disabled={!!state.busy} onClick={closeGuard}>Keep editing</button><button className="quiet" disabled={!!state.busy} onClick={discard}>{guard === "navigation" ? "Discard and continue" : "Discard draft"}</button><button className="primary" disabled={!!state.busy || session.conflict} onClick={() => { closeGuard(); void session.review(); }}>Review source changes</button></>}><p>Your unsaved Prisma text will be replaced with the latest saved source. No database or migration is changed. Editor undo can recover discarded text during this session.</p></WorkbenchDialog> : null}
    {/* Native fullscreen hides Shell's notifications outside this element. */}
    {fullscreen ? <div className="toasts" role="status" aria-live="polite">{toasts.map(item => <div key={item.id} className={`toast ${item.tone === "refuse" ? "refuse" : ""}`}>{item.text}</div>)}</div> : null}
  </div>;
}
