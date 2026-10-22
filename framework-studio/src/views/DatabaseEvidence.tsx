import { Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseHistory } from "../../shared/database-history";
import type { DatabaseObservation, DatabaseWorkbench } from "../../shared/database-workbench";
import type { DatabaseApplicationResult, DatabaseApplicationReview } from "../../shared/database-application";
import type { DatabaseSession } from "../database-session";
import { call } from "../api";
import { historyApi, shortHash } from "./DatabaseHistory";
import { WorkbenchDialog } from "./WorkbenchUI";

export function DatabaseEvidence({ active, workbench, session, observation, dirty, onRefresh }: { readonly active: boolean; readonly workbench: DatabaseWorkbench; readonly session: DatabaseSession; readonly observation?: DatabaseObservation; readonly dirty: boolean; readonly onRefresh: () => void }) {
  const [targetId, setTargetId] = useState("");
  const [history, setHistory] = useState<DatabaseHistory>();
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string>();
  const [application, setApplication] = useState<DatabaseApplicationReview>();
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [applicationResult, setApplicationResult] = useState<DatabaseApplicationResult>();
  useBlocker({ shouldBlockFn: () => applying, enableBeforeUnload: applying });
  const request = useRef(0);
  const target = workbench.targets.find(item => item.id === targetId);
  useEffect(() => {
    request.current++; session.invalidateObservation(); setInspecting(false); setError(undefined); setApplication(undefined); setApplicationResult(undefined);
  }, [targetId, workbench.revision, workbench.targets.map(item => item.identity).join(":"), session]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void historyApi.load().then(next => { if (current) { setHistory(previous => { if (previous && previous.revision !== next.revision) session.invalidateObservation(); return next; }); } }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [active, workbench, session]);
  const inspect = async () => {
    if (!target || !history) return;
    const id = ++request.current;
    const sessionRequest = session.beginObservation(target.id);
    setInspecting(true); setError(undefined);
    try {
      const result = await call<DatabaseObservation>("/database/workbench/inspect", { targetId: target.id, expectedRevision: workbench.revision });
      if (id === request.current && result.targetId === target.id && result.targetIdentity === target.identity) {
        session.acceptObservation(sessionRequest, result);
        if (result.historyRevision !== history.revision) void historyApi.load().then(setHistory);
      }
    } catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === request.current) setInspecting(false); }
  };
  const reviewApplication = async () => {
    if (!target || dirty) return;
    const id = ++request.current;
    setReviewing(true); setError(undefined); setConfirmation("");
    try {
      const result = await call<DatabaseApplicationReview>("/database/application/review", { targetId: target.id, sourceHash: workbench.revision });
      if (id === request.current && result.targetIdentity === target.identity) setApplication(result);
    } catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { setReviewing(false); }
  };
  const apply = async () => {
    if (!application) return;
    setApplying(true); setError(undefined);
    const sessionRequest = session.beginObservation(application.targetId);
    try {
      const result = await call<DatabaseApplicationResult>("/database/application/apply", { reviewId: application.id, confirmation });
      setApplicationResult(result); setApplication(undefined);
      if (result.observation) session.acceptObservation(sessionRequest, result.observation);
    } catch (error) { setError(`Application could not be confirmed: ${error instanceof Error ? error.message : String(error)} Inspect this target before retrying; database effects may be unconfirmed.`); setApplication(undefined); }
    finally { setApplying(false); }
  };
  const current = observation && observation.targetId === target?.id && observation.targetIdentity === target.identity && observation.savedRevision === workbench.revision && (!history || observation.historyRevision === history.revision) && observation.status !== "stale" ? observation : undefined;
  const migrationState = current?.migrationState.status ?? "unknown";
  const migrationLabel = migrationState === "current" ? "At saved storage contract" : migrationState === "pending" ? "Pending migration path" : migrationState === "divergent" ? "History diverges" : "Unknown";
  const physicalLabel = current?.physical.status === "matches" ? "Matches saved storage" : current?.historicalPhysical?.status === "matches" ? "Matches historical storage" : current?.physical.status === "differs" ? "Differs from saved storage" : "Unknown";
  return <div className="workbench-evidence">
    <header className="workbench-content-heading"><div><h2>What does this database actually contain?</h2><p>Compare saved source, migration history, and modeled physical storage. Every inspection is a read-only observation of the target you choose.</p></div><button className="quiet" onClick={onRefresh}><RefreshCw size={14} /> Refresh source & targets</button></header>
    <div className="workbench-observation-heading"><label>Database target<select aria-label="Database target" value={targetId} disabled={applying} onChange={event => setTargetId(event.target.value)}><option value="">Choose a database…</option>{workbench.targets.map(item => <option key={item.id} value={item.id}>{item.label}{item.available ? "" : " · inspection unavailable"}</option>)}</select></label><button className="primary" disabled={!target || !history || inspecting || applying || reviewing} onClick={() => void inspect()}>{inspecting ? "Inspecting selected database…" : "Inspect database"}</button>{current?.migrationState.status === "pending" && target?.id === "local:postgres" ? <button className="quiet" disabled={dirty || reviewing || applying} onClick={() => void reviewApplication()}>{reviewing ? "Reviewing target and pending migrations…" : "Review database application"}</button> : null}</div>
    {target ? <p className="workbench-target-note muted">{target.detail}</p> : <p className="small muted">The Development / Production graph is not a database selection. Choose a target explicitly.</p>}
    {dirty ? <p className="workbench-notice">Your unsaved draft differs from saved source. This inspection compares the database with the <strong>saved authored contract</strong>; the editor draft is a separate proposal.</p> : null}
    {error ? <p className="workbench-notice warning" role="alert">{error}</p> : null}
    {applicationResult ? <p className={`workbench-notice ${applicationResult.status === "applied" ? "" : "warning"}`} role="status">{applicationResult.message}</p> : null}
    <section className="workbench-card workbench-representations" aria-label="Schema representations"><h3>Five distinct sources of evidence</h3><dl>
      <div><dt>Editor draft</dt><dd>{dirty ? "Unsaved proposal · separate from this database comparison" : "Same text as saved source"}</dd></div>
      <div><dt>Saved Prisma source</dt><dd>{workbench.validation.valid ? "Valid contract" : "Invalid contract"} · <code>{shortHash(workbench.revision)}</code></dd></div>
      <div><dt>Emitted contract & migration graph</dt><dd>{workbench.emitted?.message ?? "Emitted artifacts have not been observed."}<br /><span className="small muted">{workbench.emitted?.file} · {workbench.emitted?.observedAt ? `read ${new Date(workbench.emitted.observedAt).toLocaleTimeString()}` : ""} · {history?.heads.length ?? "?"} migration graph heads</span></dd></div>
      <div><dt>Database marker & ledger</dt><dd>{current?.status === "observed" ? `${current.marker.status} · ${current.ledger.length} recorded applications` : "Unknown · no successful target observation"}</dd></div>
      <div><dt>Physical PostgreSQL schema</dt><dd>{current ? physicalLabel : "Unknown · marker equality alone is insufficient"}</dd></div>
    </dl></section>
    <div className="workbench-evidence-grid">
      <section className="workbench-card"><h3>Saved source → migration history</h3><div className="workbench-evidence-status">{history ? history.heads.includes(workbench.validation.storageHash ?? "") ? "Storage has a graph head" : "Needs investigation" : "Unknown"}</div><p>{history?.heads.includes(workbench.validation.storageHash ?? "") ? "Saved storage matches a terminal contract in the on-disk migration graph. This does not establish whether any database has applied it." : "Compare saved source with migration history. A missing plan, branch or incomplete snapshot can prevent a known path."}</p><p><code>{shortHash(workbench.validation.storageHash)}</code> · {history?.migrations.length ?? "?"} migration packages</p></section>
      <section className="workbench-card"><h3>Database migration evidence</h3><div className={`workbench-evidence-status ${migrationState === "current" ? "good" : migrationState === "unknown" ? "" : "warning"}`}>{migrationState === "current" ? <Check size={17} /> : null}{migrationLabel}</div><p>{!current ? "No current observation for this target. A schema file and migration folders alone cannot establish database state." : current.marker.status === "missing" ? "No Prisma migration marker was found. The physical schema may still exist; do not infer an origin or sign it automatically." : `Marker: ${current.marker.status}. ${current.marker.storageHash ? `Storage contract ${shortHash(current.marker.storageHash)}.` : ""}`}</p>{current?.ledger.length ? <p>{current.ledger.length} recorded migration applications</p> : null}</section>
      <section className="workbench-card"><h3>Observed physical schema</h3><div className={`workbench-evidence-status ${current?.physical.status === "matches" ? "good" : current?.physical.status === "differs" ? "warning" : ""}`}>{physicalLabel}</div><p>{!current ? "Inspect to compare PostgreSQL’s modeled schema with saved source. Matching a migration marker alone never proves a physical match." : current.status !== "observed" ? "No physical observation was obtained for this target. Review the inspection result below." : current.historicalPhysical?.status === "matches" && current.physical.status === "differs" ? "The database matches the verified historical contract at its marker. A known forward path can explain the difference from saved source." : current.historicalPhysical?.status === "differs" ? "Physical storage differs from the known marker contract. Investigate drift before applying a migration." : current.physical.status === "matches" ? "Prisma strict verification accepts modeled physical storage. Data transformations, backfill completion and application correctness remain separate." : "Physical evidence is incomplete or differs. Review detailed issues before deciding what changes are needed."}</p></section>
    </div>
    {current ? <section className="workbench-card"><h3>{target?.label} · observation</h3><p role="status">{current.message}</p><div className="workbench-provenance"><span>{current.status === "observed" ? "Observed" : "Attempted"} {new Date(current.observedAt).toLocaleString()}</span><span>Baseline: {current.baseline.label}</span><span>Source revision: <code>{shortHash(current.savedRevision)}</code></span><span>Target identity: <code>{shortHash(current.targetIdentity)}</code></span></div>
      {current.physical.issues.length || current.physical.warnings.length ? <details open><summary>Physical comparison findings</summary>{[...current.physical.issues, ...current.physical.warnings].map((issue, index) => <pre key={index}>{issue}</pre>)}</details> : null}
      {current.historicalPhysical ? <details open={current.historicalPhysical.status === "differs"}><summary>Historical physical baseline · {shortHash(current.historicalPhysical.storageHash)} · {current.historicalPhysical.status}</summary><p>This separately verifies physical storage against the known contract named by the database marker.</p>{[...current.historicalPhysical.issues, ...current.historicalPhysical.warnings].map((issue, index) => <pre key={index}>{issue}</pre>)}</details> : null}
      {current.ledger.length ? <details><summary>Database application history</summary><p className="small muted">These are observed application times, separate from migration creation.</p>{current.ledger.map((entry, index) => <p key={index}><strong>{entry.name}</strong> · applied {new Date(entry.appliedAt).toLocaleString()}<br /><code>{shortHash(entry.from)} → {shortHash(entry.to)}</code></p>)}</details> : null}
      <details><summary>Evidence limits</summary>{current.limits.map(limit => <p key={limit}>{limit}</p>)}</details>
    </section> : <div className="workbench-empty">{inspecting ? "Reading Prisma marker, application ledger and physical schema. No database writes…" : "Database state is unknown until an explicit inspection succeeds."}</div>}
    <section className="workbench-card" style={{ marginTop: 16 }}><h3>The next safe action</h3><ol className="workbench-step-list"><li>Review and save the source proposal.</li><li>Generate application artifacts and review downstream impact.</li><li>Choose the intended historical baseline and plan a migration offline.</li><li>Review SQL, constraints, destructive changes and data transformations.</li><li>Apply the reviewed migration only with explicit target approval, then inspect again.</li></ol><p className="small muted">Inspection never starts Compose: startup can apply migrations and clean application data. Studio keeps database networking and private IAM/TLS requirements intact.</p></section>
    {application ? <WorkbenchDialog title="Authorize reviewed database application" busy={applying} onClose={() => setApplication(undefined)} footer={<><button className="quiet" autoFocus disabled={applying} onClick={() => setApplication(undefined)}>Back to database status</button><button className="primary" disabled={applying || confirmation !== application.confirmation || dirty} onClick={() => void apply()}>{applying ? "Applying reviewed migrations…" : "Apply reviewed migration"}</button></>}>
      <p><strong>{application.targetLabel}</strong> · target identity <code>{shortHash(application.targetIdentity)}</code> · {shortHash(application.from)} → {shortHash(application.to)}</p><ul>{application.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
      {application.migrations.map(migration => <section className="workbench-card" key={migration.id}><h3>{migration.name}</h3>{migration.operations.map((operation, index) => <div key={index}><p><strong>{operation.label}</strong> · {operation.operationClass}</p>{operation.statements.map((statement, at) => <pre key={at}>{statement.phase}{"\n"}{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>)}</div>)}<details><summary>Executable migration source</summary><pre>{migration.source}</pre></details></section>)}
      <p className="workbench-notice warning">This changes the selected database and may transform or delete data. Source undo does not roll back a database. The reviewed target and historical schema are checked again before execution.</p><label className="workbench-confirmation">Type <strong>{application.confirmation}</strong> to authorize this application<input aria-label="Confirm database target" autoComplete="off" spellCheck={false} value={confirmation} disabled={applying} onChange={event => setConfirmation(event.target.value)} /></label>
    </WorkbenchDialog> : null}
  </div>;
}
