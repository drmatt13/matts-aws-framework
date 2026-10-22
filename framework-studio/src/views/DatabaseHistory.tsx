import { Check, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseHistory as HistoryData, DatabaseMigration, DatabaseMigrationInstallResult, DatabaseMigrationReview, DatabaseSchemaComparison } from "../../shared/database-history";
import type { DatabaseValidation, DatabaseWorkbench } from "../../shared/database-workbench";
import { call } from "../api";
import { WorkbenchDialog } from "./WorkbenchUI";

export const historyApi = {
  load: (signal?: AbortSignal) => call<HistoryData>("/database/history", undefined, signal),
  compare: (from: string, to: string, source?: string, signal?: AbortSignal) => call<DatabaseSchemaComparison>("/database/history/compare", { from, to, source }, signal),
  plan: (body: { name: string; from: string; expectedSourceHash: string; expectedHistoryRevision: string }, signal?: AbortSignal) => call<DatabaseMigrationReview>("/database/history/plan", body, signal),
  install: (reviewId: string) => call<DatabaseMigrationInstallResult>("/database/history/install", { reviewId }),
  discard: (reviewId: string) => call("/database/history/discard", { reviewId }),
};
export const shortHash = (value: string | null | undefined) => value ? value.slice(0, 12) : "empty storage";

function MigrationOperations({ operations }: { readonly operations: DatabaseMigration["operations"] }) {
  return <>{operations.length ? operations.map((operation, index) => <details key={`${operation.id}-${index}`} className="workbench-card"><summary><strong>{operation.label}</strong> <span className="small muted">{operation.operationClass}</span></summary>{operation.summary ? <p>{operation.summary}</p> : null}{operation.statements.map((statement, at) => <div key={at}><p className="small muted">{statement.phase}{statement.description ? ` · ${statement.description}` : ""}</p><pre>{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre></div>)}</details>) : <p className="small muted">No emitted storage operations.</p>}</>;
}
function Changes({ comparison }: { readonly comparison: DatabaseSchemaComparison }) {
  const visible = comparison.changes.filter(change => !comparison.changes.some(parent => parent !== change && parent.plane === change.plane && parent.kind === change.kind && parent.kind !== "changed" && parent.path.length < change.path.length && parent.path.every((part, index) => change.path[index] === part)));
  return <><div className="workbench-provenance"><span>Storage: {comparison.storageChanged ? "changed" : "unchanged"}</span><span>Execution: {comparison.executionChanged ? "changed" : "unchanged"}</span><span>Domain: {comparison.domainChanged ? "changed" : "unchanged"}</span></div>
    {!comparison.changes.length ? <p className="small">These semantic contracts are equal. Authored comments and formatting are outside this comparison.</p> : <div className="workbench-comparison-changes">{(["storage", "domain", "execution"] as const).map(plane => {
      const changes = visible.filter(change => change.plane === plane);
      return changes.length ? <section key={plane}><h4>{plane === "storage" ? "Physical storage" : plane === "domain" ? "Prisma models & fields" : "Execution behavior"}</h4>{changes.map((change, index) => {
        const children = comparison.changes.filter(child => child !== change && child.plane === change.plane && child.path.length > change.path.length && change.path.every((part, at) => child.path[at] === part));
        const path = change.path.filter(part => !["database", "namespaces", "models"].includes(part)).join(" → ");
        return <details className={`workbench-change ${change.kind}`} key={index}><summary><strong>{change.kind}</strong> · {path || change.entity}{children.length ? <span className="small muted"> · {children.length} nested changes</span> : null}</summary>{change.explanation ? <p>{change.explanation}</p> : null}{children.length ? <ul>{children.map((child, at) => <li key={at}>{child.kind} · {child.path.slice(change.path.length).join(" → ")}</li>)}</ul> : null}<pre>{JSON.stringify({ before: change.before, after: change.after }, null, 2)}</pre></details>;
      })}</section> : null;
    })}</div>}
    <details><summary className="small muted">Comparison evidence and limits</summary><p className="small">{shortHash(comparison.fromStorageHash)} → {shortHash(comparison.toStorageHash)} · {new Date(comparison.observedAt).toLocaleString()}</p>{comparison.limitations.map(item => <p key={item} className="small muted">{item}</p>)}</details></>;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Display emitted snapshot data as such; no historical PSL or source ranges are fabricated. */
function HistoricalSchema({ contract, empty }: { readonly contract: unknown; readonly empty?: boolean }) {
  const namespaces = record(record(record(contract).storage).namespaces);
  return <div className="workbench-historical-schema">{empty ? <p className="small muted">Empty storage</p> : !Object.keys(namespaces).length ? <p className="small muted">Semantic snapshot unavailable</p> : Object.entries(namespaces).flatMap(([namespace, space]) => Object.entries(record(record(record(space).entries).table)).map(([name, value]) => {
    const table = record(value);
    const primary = record(table.primaryKey).columns as string[] | undefined;
    return <article key={`${namespace}.${name}`}><header><strong>{namespace}.{name}</strong></header>{Object.entries(record(table.columns)).map(([column, value]) => { const field = record(value); return <div key={column}><code>{column}</code><span>{String(field.nativeType ?? field.codecId)}{Object.keys(record(field.typeParams)).length ? `(${Object.values(record(field.typeParams)).join(", ")})` : ""}{field.nullable ? " · nullable" : ""}{primary?.includes(column) ? " · PK" : ""}</span></div>; })}<footer>{Array.isArray(table.indexes) ? table.indexes.length : 0} indexes · {Array.isArray(table.foreignKeys) ? table.foreignKeys.length : 0} foreign keys</footer></article>;
  }))}</div>;
}

export function DatabaseHistory({ active, saved, draft, draftValidation, dirty, onInstalled, snapshotRevision }: { readonly snapshotRevision: string; readonly active: boolean; readonly saved: DatabaseWorkbench; readonly draft: string; readonly draftValidation?: DatabaseValidation; readonly dirty: boolean; readonly onInstalled: () => void }) {
  const [history, setHistory] = useState<HistoryData>();
  const [selectedId, setSelectedId] = useState<string>();
  const [from, setFrom] = useState("saved");
  const [to, setTo] = useState("saved");
  const [comparison, setComparison] = useState<DatabaseSchemaComparison>();
  const [busy, setBusy] = useState<"load" | "compare" | "plan" | "install">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [planning, setPlanning] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [name, setName] = useState("");
  const [review, setReview] = useState<DatabaseMigrationReview>();
  useBlocker({ shouldBlockFn: () => busy === "install", enableBeforeUnload: busy === "install" });
  const generation = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (review) backButton.current?.focus(); }, [review]);
  const controller = useRef<AbortController | undefined>(undefined);
  const load = async () => {
    const id = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy("load"); setError(undefined);
    try { const next = await historyApi.load(controller.current.signal); if (id === generation.current) { setHistory(next); setComparison(undefined); } }
    catch (error) { if (id === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === generation.current) setBusy(undefined); }
  };
  useEffect(() => { generation.current++; controller.current?.abort(); setBusy(undefined); setComparison(undefined); setReview(undefined); }, [saved.revision, saved.configRevision, draft, snapshotRevision]);
  useEffect(() => { if (active) void load(); }, [active, saved.revision, saved.configRevision, snapshotRevision]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const selected = history?.migrations.find(item => item.id === selectedId);
  const options = [{ value: "saved", label: "Current saved source" }, ...(draftValidation ? [{ value: "draft", label: dirty ? "Unsaved editor draft" : "Current draft (= saved)" }] : []), { value: "empty", label: "Empty storage" }, ...history?.snapshots.map(item => ({ value: item.hash, label: `${shortHash(item.hash)}${history.heads.includes(item.hash) ? " · graph head" : ""}${item.available ? "" : " · unavailable"}` })) ?? []];
  const compare = async (origin = from, target = to) => {
    const id = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setFrom(origin); setTo(target); setBusy("compare"); setError(undefined); setComparison(undefined);
    try { const result = await historyApi.compare(origin, target, draft, controller.current.signal); if (id === generation.current) setComparison(result); }
    catch (error) { if (id === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === generation.current) setBusy(undefined); }
  };
  const choose = (migration: DatabaseMigration) => { setSelectedId(migration.id); void compare(migration.from ?? "empty", migration.to); };
  const plan = async () => {
    if (!history) return;
    const id = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy("plan"); setError(undefined);
    try { const result = await historyApi.plan({ name, from: baseline, expectedSourceHash: saved.revision, expectedHistoryRevision: history.revision }, controller.current.signal); if (id === generation.current) setReview(result); }
    catch (error) { if (id === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === generation.current) setBusy(undefined); }
  };
  const discardReview = () => { if (busy === "install") return; if (review) void historyApi.discard(review.id); setReview(undefined); setPlanning(false); };
  const cancelPlan = () => { generation.current++; controller.current?.abort(); setBusy(undefined); setNotice("Planning cancelled. The checkout and database were not changed."); };
  const install = async () => {
    if (!review) return;
    setBusy("install"); setError(undefined);
    try { const result = await historyApi.install(review.id); setNotice(result.message); setReview(undefined); setPlanning(false); onInstalled(); void load(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  };
  return <div className="workbench-history">
    <header className="workbench-content-heading"><div><h2>Follow the schema’s evolution</h2><p>Migration packages form a graph of storage contracts. Compare before and after states, review operations, and plan the next forward change.</p></div><div className="workbench-actions"><button className="quiet" disabled={!!busy} onClick={() => void load()}><RefreshCw size={14} /> Refresh history</button><button className="primary" disabled={!!busy || !history || dirty || !saved.validation.valid} title={dirty ? "Save or discard the draft before planning from saved source" : "Creates a review in a disposable source copy; no checkout or database writes"} onClick={() => { setPlanning(true); setError(undefined); }}>Plan migration</button></div></header>
    {dirty ? <p className="workbench-notice">History can compare the valid draft. Migration planning uses saved source; review and save your draft first.</p> : null}
    {notice ? <p className="workbench-notice" role="status">{notice}</p> : null}
    {error && !planning ? <p className="workbench-notice warning" role="alert">{error}</p> : null}
    {!history ? <p className="workbench-empty">{busy === "load" ? "Reading migration metadata, operations and semantic snapshots…" : "History is unavailable. Refresh to retry."}</p> : <>
      <div className="workbench-history-summary"><p className="small muted">{history.migrations.length} migration packages · {history.heads.length} graph {history.heads.length === 1 ? "head" : "heads"} · read {new Date(history.observedAt).toLocaleTimeString()}</p>{history.issues.length ? <details className="workbench-notice warning"><summary>{history.issues.length} history findings · review before planning</summary>{history.issues.map((issue, index) => <p key={index}><strong>{issue.code}</strong> {issue.message} {issue.path ? <code>{issue.path}</code> : null}</p>)}</details> : null}</div>
      <div className="workbench-history-grid"><nav className="workbench-history-list" aria-label="Migration graph">{history.migrations.map(migration => <button className="workbench-history-edge" key={migration.id} aria-pressed={selectedId === migration.id} onClick={() => choose(migration)}><strong><GitBranch size={13} aria-hidden /> {migration.name}</strong><code>{shortHash(migration.from)} → {shortHash(migration.to)}</code><small>Created {new Date(migration.createdAt).toLocaleString()} · {migration.integrity === "verified" ? "metadata verified" : "modified package"}</small>{history.heads.includes(migration.to) ? <span className="workbench-badge">Graph head</span> : null}</button>)}{!history.migrations.length ? <p className="workbench-empty">No migration packages found. Planning from empty storage requires an explicit baseline choice.</p> : null}</nav>
      <div className="workbench-history-detail"><section className="workbench-card"><h3>Compare semantic schemas</h3><div className="workbench-comparison-controls"><label>From<select value={from} disabled={!!busy} onChange={event => { setFrom(event.target.value); setComparison(undefined); }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>To<select value={to} disabled={!!busy} onChange={event => { setTo(event.target.value); setComparison(undefined); }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button className="quiet" disabled={!!busy} onClick={() => void compare()}>{busy === "compare" ? "Comparing…" : "Compare schemas"}</button></div>{comparison ? <Changes comparison={comparison} /> : <p className="small muted">Select a migration for its before → after changes, or choose any two contracts above.</p>}</section>
      {selected ? <><section className="workbench-card"><h3>{selected.name}</h3><p>Created {new Date(selected.createdAt).toLocaleString()}. Database application time is separate and appears only in a target observation.</p><p className="small">{selected.integrity === "verified" ? <Check size={12} /> : null} Metadata and emitted operation integrity: <strong>{selected.integrity}</strong>. Historical TypeScript is read as text, never executed.</p>{selected.pendingPlaceholders ? <p className="workbench-notice warning">Data transformation placeholders remain. Review and implement them before database application.</p> : null}{selected.issues.map((issue, index) => <p key={index} className="small">{issue.message}</p>)}<details><summary>Migration source</summary><p className="small muted">{selected.sourcePath}</p><pre>{selected.source ?? "Source unavailable"}</pre></details><div className="workbench-historical-pair">{[{ hash: selected.from, label: "Before" }, { hash: selected.to, label: "After" }].map(item => <details key={item.label} open><summary>{item.label} semantic snapshot</summary><p className="small muted">Emitted contract JSON. Original authored Prisma text and comments are not preserved by migration snapshots.</p><HistoricalSchema empty={!item.hash} contract={history.snapshots.find(snapshot => snapshot.hash === item.hash)?.contract} /><details><summary>Full emitted contract JSON</summary><pre>{item.hash ? JSON.stringify(history.snapshots.find(snapshot => snapshot.hash === item.hash)?.contract ?? "Snapshot unavailable", null, 2) : "Empty storage"}</pre></details></details>)}</div></section><MigrationOperations operations={selected.operations} /></> : <section className="workbench-card"><h3>History preserves evidence</h3><p>Edges connect contract hashes; creation time never chooses the migration path. Missing or modified history stays visible.</p><p>To restore an older design, author a new source change and plan a forward migration. Editor undo changes a draft; it does not roll back a database.</p></section>}
      </div></div>
    </>}
    {planning ? <WorkbenchDialog title={review ? "Review migration artifacts" : "Plan a forward migration"} onClose={discardReview} busy={busy === "install" || busy === "plan"} footer={<>{busy === "plan" ? <button className="quiet" onClick={cancelPlan}>Cancel planning</button> : <button ref={backButton} className="quiet" autoFocus disabled={busy === "install"} onClick={discardReview}>Back to history</button>}{review ? <button className="primary" disabled={!!busy || review.noOp} onClick={() => void install()}>{busy === "install" ? "Installing artifacts…" : "Save migration package"}</button> : <button className="primary" disabled={!!busy || !baseline || !name || dirty} onClick={() => void plan()}>{busy === "plan" ? "Planning in disposable workspace…" : "Create migration review"}</button>}</>}>
      {error ? <p className="workbench-notice warning" role="alert">{error}</p> : null}
      {review ? <><p><strong>{review.summary}</strong></p><p>Source: unchanged · database: not contacted · migration artifacts: {review.noOp ? "none needed" : "review only"}.</p>{review.warnings.map((warning, index) => <p key={index} className="workbench-notice warning">{warning}</p>)}<MigrationOperations operations={review.operations} /><h3>Actual proposed artifacts ({review.artifacts.length})</h3><div className="workbench-plan-artifacts">{review.artifacts.map(artifact => <details key={artifact.path} className="workbench-card"><summary><code>{artifact.path}</code></summary><pre>{artifact.contents}</pre></details>)}</div><p className="small muted">Saving installs only the reviewed new files after rechecking source, configuration and migration history. Existing migration packages stay immutable. Generate application artifacts separately. Database application requires a separately reviewed target.</p></> : <><p>Reads saved source and the selected historical contract. Prisma emits and plans in a disposable workspace. Review the actual files before saving them into this checkout.</p><div className="workbench-comparison-controls"><label>Migration name<input aria-label="Migration name" placeholder="add_project_summary" value={name} onChange={event => setName(event.target.value)} disabled={!!busy} /></label><label>Baseline contract<select aria-label="Migration baseline" value={baseline} onChange={event => setBaseline(event.target.value)} disabled={!!busy}><option value="">Choose the intended baseline…</option>{history?.snapshots.filter(snapshot => snapshot.available && history.migrations.some(migration => migration.space === "app" && (migration.from === snapshot.hash || migration.to === snapshot.hash))).map(snapshot => <option key={snapshot.hash} value={snapshot.hash}>{shortHash(snapshot.hash)}{history.heads.includes(snapshot.hash) ? " · graph head" : ""}{saved.validation.storageHash === snapshot.hash ? " · same saved storage" : ""}</option>)}{!history?.migrations.length ? <option value="empty">Empty storage · new migration graph</option> : null}</select></label></div><p className="small muted">A graph head is a navigation hint. Confirm which contract is your intended origin; Studio never substitutes the newest folder or an orphaned snapshot.</p><p className="workbench-notice warning">Required fields, drops, constraints and data transformations need human review. A schema plan cannot prove that existing rows satisfy a new requirement or that a backfill is complete.</p></>}
    </WorkbenchDialog> : null}
  </div>;
}
