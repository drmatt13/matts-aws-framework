import { workbenchNoticeClasses } from "./WorkbenchUI";
import { cx } from "../ui/classes";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { workspaceToolbarClasses } from "../ui/Surface";
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
import { NavigationStrip, navigationItemClasses } from "./NavigationStrip";

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
  const workspaceControls = <div data-ui="workbench-workspace-controls" className="ml-auto flex shrink-0 items-center gap-2">
    <div ref={layoutControls} data-ui="workbench-view-modes" className="flex shrink-0 items-center gap-[2px] rounded-md border border-rule bg-paper p-[2px]" role="group" aria-label="Editing layout">{[{ id: "source" as const, label: "Focus source", icon: Code2 }, { id: "split" as const, label: "Split source and diagram", icon: Columns2 }, { id: "diagram" as const, label: "Focus diagram", icon: Table2 }].map(item => <button className="inline-flex h-[26px] min-h-[26px] w-7 cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent p-0 text-graphite hover:bg-wash hover:text-ink aria-pressed:border-rule-strong aria-pressed:bg-wash aria-pressed:text-ink" key={item.id} title={item.label} aria-label={item.label} aria-pressed={mode === item.id} onClick={() => { setMode(item.id); window.requestAnimationFrame(() => layoutControls.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()); }}><item.icon size={15} aria-hidden /></button>)}</div>
    <button ref={fullscreenTrigger} className={iconButtonClasses({ variant: "quiet", size: "compact" })} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen schema workspace"} title={!document.fullscreenEnabled ? "Fullscreen is unavailable in this browser" : fullscreen ? "Exit fullscreen · Esc" : "Fullscreen schema workspace"} disabled={!document.fullscreenEnabled} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}</button>
  </div>;
  const sourceStatus = <div data-ui="workbench-source-meta" className="flex flex-1 flex-wrap items-center gap-x-3 [&>span]:bg-transparent [&>span]:p-0 [&>span]:text-meta [&>span]:font-normal"><span data-ui="workbench-badge" className={`inline-flex items-center gap-1 rounded-sm bg-wash px-2 py-0 text-caption leading-[22px] whitespace-nowrap text-graphite ${session.dirty ? "border-[color-mix(in_srgb,var(--local)_45%,var(--rule))] text-local" : ""}`}>{session.dirty ? "Modified draft" : "Saved source"}</span><span data-ui="workbench-badge" className={`inline-flex items-center gap-1 rounded-sm bg-wash px-2 py-0 text-caption leading-[22px] whitespace-nowrap text-graphite ${validationCurrent && !valid ? "text-refuse" : ""}`} role="status">{valid ? <Check size={12} aria-hidden /> : validationCurrent ? <AlertTriangle size={12} aria-hidden /> : null}{status}</span></div>;
  const sourceActions = <div data-ui="workbench-source-tools" className="flex min-h-[50px] flex-wrap items-center justify-between gap-2 border-b border-rule px-[10px] py-2 [&_button]:h-7 [&_button]:min-h-7 [&_button]:px-2 [&_button]:py-0 [&_button]:text-caption">
    <button className="inline-flex h-7 min-h-7 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-0 font-sans text-caption leading-[1.5] font-medium text-graphite hover:border-rule hover:bg-wash hover:text-ink disabled:cursor-not-allowed disabled:opacity-45" disabled={formatting || !!state.busy} title="Format draft · Shift+Alt+F" onClick={() => void format()}>{formatting ? "Formatting…" : "Format"}</button>
    <div data-ui="workbench-actions" className="flex min-w-0 flex-wrap items-center gap-2"><button ref={validationTrigger} className={buttonClasses({ variant: "quiet", size: "compact" })} aria-label="Validate draft" disabled={!!state.busy || formatting} onClick={() => void session.validate()}>Validate</button>{session.dirty ? <button className={buttonClasses({ variant: "quiet", size: "compact" })} disabled={!!state.busy} onClick={() => setGuard("discard")}>Discard</button> : null}<button className={buttonClasses({ variant: "primary", size: "compact" })} aria-label="Review source changes" disabled={!session.dirty || !!state.busy || session.conflict || validationCurrent && !valid} onClick={() => void session.review()}>{state.busy === "review" ? "Preparing review…" : "Review changes"}</button></div>
  </div>;
  return <div data-ui="database-view database-workbench" className="group/workbench flex min-h-full min-w-0 flex-col gap-4 px-(--workspace-gutter) pb-6 fullscreen:h-full fullscreen:min-h-0 fullscreen:gap-[10px] fullscreen:overflow-auto fullscreen:bg-paper fullscreen:p-3" ref={workbench}>
    <h1 className="sr-only">Database</h1>
    <div data-ui="workspace-toolbar workbench-navigation" className={cx(workspaceToolbarClasses, "-mx-(--workspace-gutter) flex items-center justify-between gap-2 group-[:fullscreen]/workbench:hidden")}><NavigationStrip className="min-w-0 flex-1" label="Database workspace" activeKey={tab}>{[{ id: "schema" as const, label: "Schema", icon: FileCode2 }, { id: "history" as const, label: "History & migrations", icon: History }, { id: "database" as const, label: "Database status", icon: DatabaseIcon }, { id: "sql" as const, label: "Saved SQL", icon: Code2 }, { id: "retention" as const, label: "Data retention", icon: DatabaseIcon }].map(item => <button className={navigationItemClasses} key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}><item.icon size={15} aria-hidden />{item.label}</button>)}</NavigationStrip><button data-ui="workbench-help-toggle" className={cx(iconButtonClasses(), "shrink-0 border-transparent bg-transparent text-graphite")} title="How this works" aria-label="How this works" aria-haspopup="dialog" aria-expanded={help} aria-controls={help ? "database-workbench-help" : undefined} onClick={() => setHelp(true)}><CircleHelp size={16} aria-hidden /></button></div>
    {help ? <WorkbenchDialog id="database-workbench-help" size="help" title="How this works" onClose={() => setHelp(false)} footer={<button data-variant="primary" className={buttonClasses({ variant: "primary" })} onClick={() => setHelp(false)}>Got it</button>}><p data-ui="workbench-help-flow" className="font-medium text-graphite">Source → review → migration → database</p><ol><li><strong>Edit and review.</strong> Edit the Prisma draft, validate it, then review the exact source change before saving.</li><li><strong>Plan a migration.</strong> Use History & migrations to plan offline from an explicit historical baseline.</li><li><strong>Inspect a database.</strong> Choose a target in Database status to compare migration markers with its physical schema.</li></ol><p>Saving only writes <code>contract.prisma</code>. Generation, migration packages, database application and deployment are separate actions.</p><p className="text-graphite">New fields may also need repository, GraphQL, authorization and frontend changes; Studio does not expose them automatically.</p>{state.baseline?.capabilities.notes.length ? <details data-ui="workbench-help-capabilities" className="border-t border-rule pt-3 text-caption [&>summary]:cursor-pointer [&>summary]:text-graphite [&[open]>summary]:mb-3 [&_p+p]:pt-2"><summary>Editor capabilities</summary>{state.baseline.capabilities.notes.map(note => <p className="text-caption text-graphite" key={note}>{note}</p>)}</details> : null}</WorkbenchDialog> : null}
    {loadingError && tab !== "sql" && tab !== "retention" ? <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">{loadingError} Your draft is preserved. <button data-ui="linkish" className={buttonClasses({ variant: "link" })} onClick={() => void load()}>Retry loading source</button></div> : null}
    {fullscreenError ? <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">The browser could not change fullscreen mode. Use the source, split or diagram layout controls to adjust your workspace. <button data-ui="linkish" className={buttonClasses({ variant: "link" })} onClick={() => setFullscreenError(false)}>Dismiss</button></div> : null}
    {state.error ? <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">{state.error} <button data-ui="linkish" className={buttonClasses({ variant: "link" })} onClick={() => void load()}>Check latest saved source</button></div> : null}
    {session.conflict ? <section data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert"><strong>Saved source changed outside this session.</strong> Your draft and undo history are preserved. <button className={buttonClasses({ variant: "quiet", size: "compact" })} disabled={!!state.busy} onClick={() => setGuard("discard")}>Load saved source</button><button className={buttonClasses({ variant: "quiet" })} disabled={!!state.busy} onClick={() => { session.useLatestBaseline(); void session.review(); }}>Review draft against latest source</button></section> : null}
    {!state.baseline ? tab !== "sql" && tab !== "retention" ? <div data-ui="workbench-loading" className="px-6 py-[64px] text-center text-graphite" role="status">{loadingError ? "Source is unavailable. Resolve the error and retry." : "Loading the authored Prisma contract…"}</div> : null : <>
    <section hidden={tab !== "schema"} data-ui="workbench-schema" className="min-w-0 [&:not([hidden])]:flex [&:not([hidden])]:flex-[1_0_auto] [&:not([hidden])]:flex-col group-[:fullscreen]/workbench:min-h-0 group-[:fullscreen]/workbench:flex-1">
      <div data-ui="workbench-split" className="group/split grid min-w-0 flex-[1_0_420px] grid-cols-[minmax(280px,min(var(--source-width),calc(100%-289px)))_9px_minmax(280px,1fr)] overflow-hidden rounded-[7px] border border-rule-strong bg-sheet data-[mode=source]:grid-cols-1 data-[mode=diagram]:grid-cols-1 vp-850:flex vp-850:h-auto vp-850:min-h-0 vp-850:flex-none vp-850:flex-col group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:min-h-60 group-[:fullscreen]/workbench:flex-1" data-mode={mode} ref={split} style={{ "--source-width": `${ratio}%` } as CSSProperties}>
        <section data-ui="workbench-source-pane" className="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[mode=diagram]/split:hidden vp-850:h-120 vp-850:border-b vp-850:border-rule-strong group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:flex-1" aria-label="Prisma source pane"><header data-ui="workbench-panel-header" className="shrink-0"><div data-ui="workbench-pane-heading" className="flex min-h-[43px] flex-none flex-wrap items-center gap-2 border-b border-rule bg-sheet px-[10px] py-[5px] text-caption font-semibold vp-1100:px-1.75 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:whitespace-nowrap"><span title={snapshot.schema.file}><Code2 size={15} aria-hidden />Prisma source</span>{mode !== "diagram" ? sourceStatus : null}<a className={iconButtonClasses({ variant: "quiet", size: "compact" })} aria-label="Open in editor" title="Open contract.prisma in editor" href={editorLink(snapshot.repositoryRoot, { file: snapshot.schema.file, line: 1, column: 1, start: 0, end: 0 })}><ExternalLink size={15} aria-hidden /></a>{mode === "source" ? workspaceControls : null}</div>{mode !== "diagram" ? sourceActions : null}</header>
          <PrismaEditor ref={editor} value={state.source} onChange={source => session.setSource(source)} onCursor={cursorChanged} diagnostics={validationCurrent ? state.validation?.diagnostics : []} readOnly={!!state.busy} onSave={() => void session.review()} onFormat={() => void format()} />
          <footer data-ui="workbench-editor-status" className="flex flex-wrap items-center justify-between gap-[6px] border-t border-rule px-[10px] py-[7px] font-mono text-micro text-graphite [line-height:normal] vp-1100:[&>span:last-child]:hidden"><span>Ln {cursor.line}, Col {cursor.column}</span><span>Prisma 8 · static suggestions</span><span>⌘/Ctrl F · ⌘/Ctrl H</span></footer>
        </section>
        <div data-ui="workbench-resizer" className="cursor-col-resize touch-none border-x border-rule bg-paper hover:bg-dev focus-visible:bg-dev focus-visible:-outline-offset-2 group-data-[mode=source]/split:hidden group-data-[mode=diagram]/split:hidden vp-850:hidden" role="separator" tabIndex={0} aria-label="Resize source and diagram" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={ratio} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setRatio(value => event.key === "Home" ? 25 : event.key === "End" ? 75 : Math.max(25, Math.min(75, value + (event.key === "ArrowLeft" ? -2 : 2)))); } }} onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !split.current) return; const bounds = split.current.getBoundingClientRect(); setRatio(Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
        <section data-ui="workbench-diagram-pane" className="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[mode=source]/split:hidden vp-850:h-130 group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:flex-1" aria-label="Schema diagram pane"><header data-ui="workbench-panel-header" className="shrink-0"><div data-ui="workbench-pane-heading" className="flex min-h-[43px] flex-none flex-wrap items-center gap-2 border-b border-rule bg-sheet px-[10px] py-[5px] text-caption font-semibold vp-1100:px-1.75 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:whitespace-nowrap"><span><Table2 size={15} aria-hidden />Schema diagram</span>{mode === "diagram" ? sourceStatus : null}{mode !== "source" ? workspaceControls : null}</div>{mode === "diagram" ? sourceActions : null}</header>{state.diagram ? <DatabaseDiagram schema={state.diagram} selection={selection} onSelect={setSelection} onLocate={locate} retained={!valid} /> : <p data-ui="empty">Validate a model to see its diagram.</p>}</section>
      </div>
      {session.dirty && valid ? <p data-ui="workbench-impact" className="mt-[10px] mb-0 text-meta text-caption text-graphite" role="status">{storageChanged ? "Storage contract changed. After saving, plan and review a forward migration; existing rows may need a backfill." : behaviorChanged ? "Execution behavior changed with no storage change. Regenerate artifacts and check application behavior after saving." : "Source changed; storage and execution contracts are unchanged."}</p> : null}
      {validationCurrent && state.validation?.diagnostics.length ? <section data-ui="workbench-diagnostics" className="[&>h2]:font-condensed [&>h2]:text-[16px] [&>h2]:font-semibold group-[:fullscreen]/workbench:max-h-[25vh] group-[:fullscreen]/workbench:shrink-0 group-[:fullscreen]/workbench:overflow-auto" aria-label="Prisma diagnostics"><h2>Diagnostics</h2>{state.validation.diagnostics.map((diagnostic, index) => <button key={index} data-ui="workbench-diagnostic" className={"mt-[5px] flex w-full items-start gap-3 border border-rule bg-sheet p-[10px] text-left text-caption vp-480:flex-wrap [&>strong]:max-w-50 [&>strong]:text-micro [&>strong]:text-refuse [&>strong]:wrap-anywhere [&>span]:flex-1 vp-480:[&>span]:basis-full [&>code]:text-micro [&>code]:whitespace-nowrap "} data-severity={diagnostic.severity} onClick={() => { revealSource(diagnostic.from, diagnostic.to); }}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span><code>line {state.source.slice(0, diagnostic.from).split("\n").length}</code></button>)}</section> : null}
    </section>
    <section hidden={tab !== "history"}><DatabaseHistory snapshotRevision={snapshot.revision} active={tab === "history"} saved={state.baseline} draft={state.source} draftValidation={valid ? state.validation : undefined} dirty={session.dirty} onInstalled={() => { session.invalidateObservation(); void load(); }} /></section>
    <section hidden={tab !== "database"}><DatabaseEvidence active={tab === "database"} workbench={state.latest ?? state.baseline} session={session} observation={state.observation} dirty={session.dirty} onRefresh={() => void load()} /></section>
    </>}
    <section hidden={tab !== "sql"}><DatabaseSql active={tab === "sql"} /></section>
    {tab === "retention" ? <DataRetention kind="database" /> : null}
    {state.review ? <WorkbenchDialog title="Review source changes" busy={state.busy === "save"} onClose={() => session.closeReview()} footer={<><button className={buttonClasses({ variant: "quiet" })} autoFocus disabled={!!state.busy} onClick={() => session.closeReview()}>Back to editing</button><button data-variant="primary" className={buttonClasses({ variant: "primary" })} disabled={!!state.busy || session.conflict} onClick={() => void save()}>{state.busy === "save" ? "Saving…" : "Save schema"}</button></>}><p>Review the complete source before saving. The file revision and Prisma validation are checked again before writing.</p><ul>{state.review.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><SourceComparison before={state.review.before} after={state.review.after} /><p className="text-caption text-graphite">After saving, generate application artifacts and review downstream types, repositories, GraphQL exposure and writable-field policies. Plan a migration separately when storage changes.</p></WorkbenchDialog> : null}
    {guard ? <WorkbenchDialog title={guard === "navigation" ? "Leave your schema draft?" : "Discard schema draft?"} onClose={closeGuard} busy={!!state.busy} footer={<><button className={buttonClasses({ variant: "quiet" })} autoFocus disabled={!!state.busy} onClick={closeGuard}>Keep editing</button><button className={buttonClasses({ variant: "quiet" })} disabled={!!state.busy} onClick={discard}>{guard === "navigation" ? "Discard and continue" : "Discard draft"}</button><button data-variant="primary" className={buttonClasses({ variant: "primary" })} disabled={!!state.busy || session.conflict} onClick={() => { closeGuard(); void session.review(); }}>Review source changes</button></>}><p>Your unsaved Prisma text will be replaced with the latest saved source. No database or migration is changed. Editor undo can recover discarded text during this session.</p></WorkbenchDialog> : null}
    {/* Native fullscreen hides Shell's notifications outside this element. */}
    {fullscreen ? <div data-ui="toasts" className="fixed bottom-4 left-4 z-30 grid max-w-[min(460px,calc(100vw-32px))] gap-2" role="status" aria-live="polite">{toasts.map(item => <div key={item.id} data-ui="toast" className={`rounded-md px-4 py-3 text-step-minus1 text-sheet shadow-popover wrap-anywhere ${item.tone === "refuse" ? "bg-refuse" : "bg-ink"}`}>{item.text}</div>)}</div> : null}
  </div>;
}
