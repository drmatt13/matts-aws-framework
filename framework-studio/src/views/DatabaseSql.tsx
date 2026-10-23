import { useEffect, useState } from "react";
import { call } from "../api";
import type { SavedSqlCommand, SqlCatalog, SqlExecutionResult, SqlExecutionReview, SqlSourceReview } from "../../shared/database-sql";
import { SourceComparison, WorkbenchDialog } from "./WorkbenchUI";

export const databaseSqlApi = {
  load: () => call<SqlCatalog>("/database/sql"),
  review: (command: SavedSqlCommand, expectedRevision: string | null) => call<SqlSourceReview>("/database/sql/review", { command, expectedRevision }),
  save: (id: string) => call<{ message: string; revision: string }>("/database/sql/save", { id }),
  executionReview: (path: string, revision: string, targetId: string, parameters: unknown) => call<SqlExecutionReview>("/database/sql/execute-review", { path, revision, targetId, parameters }),
  execute: (id: string, confirmation: string) => call<SqlExecutionResult>("/database/sql/execute", { id, confirmation }),
};
const empty = (): SavedSqlCommand => ({ name: "demo_seed", kind: "seed", intent: "repeatable", description: "Add disposable demo data", parameters: ["label"], sql: "INSERT INTO demo_items(label) VALUES ($1) ON CONFLICT (label) DO NOTHING RETURNING label;" });

export function DatabaseSql({ active }: { readonly active: boolean }) {
  const [catalog, setCatalog] = useState<SqlCatalog>();
  const [selected, setSelected] = useState<string>();
  const [command, setCommand] = useState<SavedSqlCommand>(empty);
  const [revision, setRevision] = useState<string | null>(null);
  const [parameterNames, setParameterNames] = useState("label");
  const [parameters, setParameters] = useState('["Studio demo"]');
  const [target, setTarget] = useState("local:postgres");
  const [sourceReview, setSourceReview] = useState<SqlSourceReview>();
  const [executionReview, setExecutionReview] = useState<SqlExecutionReview>();
  const [approval, setApproval] = useState("");
  const [result, setResult] = useState<SqlExecutionResult>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>();
  const load = async () => { const value = await databaseSqlApi.load(); if (!Array.isArray(value.commands)) throw new Error("Restart npm run studio to enable saved SQL commands."); setCatalog(value); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  useEffect(() => { if (active) void run(load); }, [active]);
  useEffect(() => { setResult(undefined); }, [command, parameters, parameterNames, target]);
  const persisted = catalog?.commands.find(item => item.path === selected);
  const current: SavedSqlCommand = { ...command, parameters: parameterNames.split(",").map(value => value.trim()).filter(Boolean) };
  const dirty = !persisted || JSON.stringify(current) !== JSON.stringify(persisted.command);
  const choose = (path?: string) => {
    const item = catalog?.commands.find(item => item.path === path);
    const next = item?.command ?? empty(); setSelected(item?.path); setCommand(next); setRevision(item?.revision ?? null); setParameterNames(next.parameters.join(", ")); setResult(undefined); setMessage(undefined); setError(undefined);
  };
  return <div className="database-sql">
    <header className="workbench-content-heading"><div><h2>Saved SQL</h2><p>Save reusable SQL in <code>packages/database/sql/</code>, then review execution against an explicitly selected database. Saving never runs SQL. Schema migrations remain in History & migrations.</p></div></header>
    {error ? <p className="workbench-notice warning" role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    <div className="workbench-actions sql-catalog"><label>Saved command <select aria-label="Saved SQL command" value={selected ?? ""} disabled={busy} onChange={event => choose(event.target.value || undefined)}><option value="">New command</option>{catalog?.commands.map(item => <option key={item.path} value={item.path}>{item.command.kind} / {item.command.name}</option>)}</select></label><button className="quiet" disabled={busy} onClick={() => void run(load)}>Refresh SQL catalog</button></div>
    {catalog?.issues.map(issue => <p key={issue} className="reason small">{issue}</p>)}
    <fieldset disabled={busy} className="sql-fields"><legend>Repository command</legend>
      <label>Name <input aria-label="SQL command name" value={command.name} onChange={event => { setCommand({ ...command, name: event.target.value }); if (persisted) { setSelected(undefined); setRevision(null); } }} /></label>
      <label>Category <select aria-label="SQL category" value={command.kind} onChange={event => { setCommand({ ...command, kind: event.target.value as SavedSqlCommand["kind"] }); if (persisted) { setSelected(undefined); setRevision(null); } }}><option value="seed">Seed / demo data</option><option value="backfill">One-time backfill</option><option value="operation">Operational SQL</option><option value="inspection">Read-only inspection</option></select></label>
      <label>Execution intent <select aria-label="SQL execution intent" value={command.intent} onChange={event => setCommand({ ...command, intent: event.target.value as SavedSqlCommand["intent"] })}><option value="repeatable">Repeatable — SQL owns idempotence</option><option value="once">Once per command and parameter set</option></select></label>
      <label>Description <input aria-label="SQL description" value={command.description} onChange={event => setCommand({ ...command, description: event.target.value })} /></label>
      <label>Parameter names, in $1, $2 order <input aria-label="SQL parameter names" value={parameterNames} onChange={event => setParameterNames(event.target.value)} /></label>
      <label className="sql-source">SQL <textarea aria-label="SQL source" spellCheck={false} rows={10} value={command.sql} onChange={event => setCommand({ ...command, sql: event.target.value })} /></label>
      <div className="sql-source sql-source-actions"><p className="small muted">Changing the name or category creates a new file and preserves the original command.</p>
      <button className="primary" disabled={!dirty} onClick={() => void run(async () => setSourceReview(await databaseSqlApi.review(current, revision)))}>Review SQL source</button></div>
    </fieldset>
    <fieldset disabled={busy}><legend>Explicit execution</legend>
      <label>Database target <select aria-label="SQL database target" value={target} onChange={event => { setTarget(event.target.value); setExecutionReview(undefined); }}><option value="local:postgres">Local PostgreSQL</option><option value="production">Production RDS — protected task required</option></select></label>
      <p className="small muted">{target === "production" ? "Saved SQL executes locally only. Open Database status to review the named production deployment and its protected IAM/TLS migration task; that separate workflow does not run arbitrary saved SQL." : catalog?.targets.find(item => item.id === target)?.detail}</p>
      <label>Parameter values as a JSON array <textarea aria-label="SQL parameter values" rows={2} value={parameters} onChange={event => setParameters(event.target.value)} /></label>
      <p className="small muted">Use public or disposable data. Parameter values and result rows are excluded from persistent Studio history. One statement runs in a transaction; a connection lost during COMMIT can leave an uncertain outcome.</p>
      <button className="primary" disabled={!persisted || dirty} onClick={() => void run(async () => { setApproval(""); setExecutionReview(await databaseSqlApi.executionReview(persisted!.path, persisted!.revision, target, JSON.parse(parameters))); })}>Review execution</button>{dirty ? <p className="small muted">Save and reload the reviewed command before executing it.</p> : null}
    </fieldset>
    {result ? <section aria-label="SQL execution result"><h3>{result.name} · {result.status} · {result.targetLabel}</h3><p className="small"><code>{result.path}</code> · {result.revision.slice(0, 12)}</p><p role="status">{result.message}</p>{result.sqlState ? <code>SQLSTATE {result.sqlState}</code> : null}<p>{result.truncated ? "At least " : ""}{result.rowCount ?? 0} rows{result.truncated ? " · first 100 shown" : ""}</p><pre>{JSON.stringify(result.rows, null, 2)}</pre></section> : null}
    <section aria-label="SQL operation history"><h3>Operation history</h3><p className="small muted">Restart never replays writes. Interrupted records remain uncertain until the target is inspected. Source edits and rows are not database rollback.</p>{!catalog?.history.length ? <p>No saved SQL executions recorded.</p> : catalog.history.map(item => <details key={item.id}><summary>{item.name} · {item.status} · {item.targetLabel}</summary><p>{item.message}</p><code>{item.startedAt} · {item.id}</code><p className="small">{item.path} · revision {item.revision.slice(0, 12)} · database {item.database}{item.sqlState ? ` · SQLSTATE ${item.sqlState}` : ""}</p></details>)}</section>
    {sourceReview ? <WorkbenchDialog title="Review saved SQL source" busy={busy} onClose={() => setSourceReview(undefined)} footer={<><button className="quiet" disabled={busy} onClick={() => setSourceReview(undefined)}>Back</button><button className="primary" disabled={busy} onClick={() => void run(async () => { const response = await databaseSqlApi.save(sourceReview.id); await load(); setSelected(sourceReview.path); setCommand(sourceReview.command); setRevision(response.revision); setSourceReview(undefined); setMessage(response.message); })}>Save SQL source</button></>}>
      {error ? <p role="alert" className="reason">{error}</p> : null}
      <p><code>{sourceReview.path}</code></p><p>Writes the reviewed repository file only. No database is contacted.</p><SourceComparison before={sourceReview.before ?? ""} after={sourceReview.after} />
    </WorkbenchDialog> : null}
    {executionReview ? <WorkbenchDialog title="Approve SQL execution" busy={busy} onClose={() => setExecutionReview(undefined)} footer={<><button className="quiet" disabled={busy} onClick={() => setExecutionReview(undefined)}>Cancel</button><button className="primary" disabled={busy || approval !== executionReview.confirmation} onClick={() => void run(async () => { const value = await databaseSqlApi.execute(executionReview.id, approval); setResult(value); setExecutionReview(undefined); await load(); })}>Execute reviewed SQL</button></>}>
      {error ? <p role="alert" className="reason">{error}</p> : null}
      <p><strong>{executionReview.targetLabel}</strong> · target identity <code>{executionReview.targetIdentity.slice(0, 16)}</code></p><p><code>{executionReview.path}</code> · {executionReview.command.intent}</p><ul>{executionReview.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><pre>{executionReview.command.sql}</pre><p>Bound values: <code>{JSON.stringify(executionReview.parameters)}</code></p><label>Type <code>{executionReview.confirmation}</code><input aria-label="SQL execution confirmation" autoComplete="off" value={approval} onChange={event => setApproval(event.target.value)} /></label>
    </WorkbenchDialog> : null}
  </div>;
}
