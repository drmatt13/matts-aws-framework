import { Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseHistory } from "../../shared/database-history";
import type { DatabaseObservation, DatabaseWorkbench } from "../../shared/database-workbench";
import type { DatabaseApplicationResult, DatabaseApplicationReview, DatabaseOperationRecord } from "../../shared/database-application";
import type { DatabaseSession } from "../database-session";
import { call } from "../api";
import { historyApi, shortHash } from "./DatabaseHistory";
import { WorkbenchDialog } from "./WorkbenchUI";
import { DatabaseCloud } from "./DatabaseCloud";

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
  const [operations, setOperations] = useState<DatabaseOperationRecord[]>([]);
  const [operationError, setOperationError] = useState<string>();
  const [cloudBusy, setCloudBusy] = useState(false);
  useBlocker({ shouldBlockFn: () => applying || cloudBusy, enableBeforeUnload: applying || cloudBusy });
  const request = useRef(0);
  const target = workbench.targets.find(item => item.id === targetId);
  useEffect(() => {
    request.current++; session.invalidateObservation(); setInspecting(false); setError(undefined); setApplication(undefined); setApplicationResult(undefined);
  }, [targetId, workbench.revision, workbench.targets.map(item => item.identity).join(":"), session]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void historyApi.load().then(next => { if (current) { setHistory(previous => { if (previous && previous.revision !== next.revision) session.invalidateObservation(); return next; }); } }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    void call<DatabaseOperationRecord[]>("/database/application/operations").then(next => { if (current) { setOperations(next); setOperationError(undefined); } }).catch(() => { if (current) setOperationError("Database operation history could not be read. Refresh before retrying a previous unconfirmed write."); });
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
  const reviewApplication = async (initialize = false) => {
    if (!target || dirty) return;
    const id = ++request.current;
    setReviewing(true); setError(undefined); setConfirmation("");
    try {
      const result = await call<DatabaseApplicationReview>("/database/application/review", { targetId: target.id, sourceHash: workbench.revision, ...(initialize ? { initialize: true } : {}) });
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
      void call<DatabaseOperationRecord[]>("/database/application/operations").then(setOperations).catch(() => setOperationError("Operation history could not refresh. The application result above remains authoritative."));
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
    <div className="workbench-observation-heading"><label>Database target<select aria-label="Database target" value={targetId} disabled={applying || cloudBusy} onChange={event => setTargetId(event.target.value)}><option value="">Choose a database…</option>{workbench.targets.map(item => <option key={item.id} value={item.id}>{item.label}{item.available ? "" : item.id === "production" ? " · VPC task review" : " · inspection unavailable"}</option>)}</select></label><button className="primary" disabled={!target?.available || !history || inspecting || applying || reviewing || cloudBusy} onClick={() => void inspect()}>{inspecting ? "Inspecting selected database…" : "Inspect database"}</button>{current?.migrationState.status === "pending" && target?.id === "local:postgres" ? <button className="quiet" disabled={dirty || reviewing || applying} onClick={() => void reviewApplication()}>{reviewing ? "Reviewing target and pending migrations…" : "Review database application"}</button> : null}{current?.status === "observed" && current.marker.status === "missing" && target?.id === "local:postgres" ? <button className="quiet" disabled={dirty || reviewing || applying} onClick={() => void reviewApplication(true)}>{reviewing ? "Checking empty database and planning…" : "Review empty database initialization"}</button> : null}</div>
    {target ? <p className="workbench-target-note muted">{target.detail}</p> : <p className="small muted">The Development / Production graph is not a database selection. Choose a target explicitly.</p>}
    {target?.handoffs?.length ? <DatabaseCloud target={target} dirty={dirty} onBusyChange={setCloudBusy} onOutcome={() => { void call<DatabaseOperationRecord[]>("/database/application/operations").then(setOperations).catch(() => setOperationError("Operation history could not refresh. Inspect the recorded task before retrying.")); }} /> : target?.id === "production" ? <p className="workbench-notice">No valid production targets were found. Configure the named production deployment in cdk-app/cdk.json, then refresh. No database command has run.</p> : null}
    {dirty ? <p className="workbench-notice">Your unsaved draft differs from saved source. This inspection compares the database with the <strong>saved authored contract</strong>; the editor draft is a separate proposal.</p> : null}
    {error ? <p className="workbench-notice warning" role="alert">{error}</p> : null}
    {applicationResult ? <p className={`workbench-notice ${["applied", "unchanged"].includes(applicationResult.status) ? "" : "warning"}`} role="status">{applicationResult.message}</p> : null}
    {applicationResult?.diagnostic ? <p className="workbench-notice warning" role="alert"><code>{applicationResult.diagnostic.code}</code>{applicationResult.diagnostic.sqlState ? ` · SQLSTATE ${applicationResult.diagnostic.sqlState}` : ""} · {applicationResult.diagnostic.action} <button className="quiet" disabled={inspecting || applying} onClick={() => void inspect()}>Inspect again</button></p> : null}
    {operationError ? <p className="workbench-notice warning" role="alert">{operationError}</p> : null}
    {operations.length ? <details className="workbench-card"><summary>Database operation history ({operations.length})</summary><p>Records survive Studio restarts. Interrupted operations are never resumed automatically; inspect the selected target and ledger before requesting another review.</p>{operations.map(operation => <div key={operation.id}><strong>{operation.targetLabel} · {operation.kind} · {operation.status}</strong><p className="small muted">{new Date(operation.startedAt).toLocaleString()} · last observed {new Date(operation.updatedAt).toLocaleString()} · last stage: {operation.stage} · source {shortHash(operation.sourceHash)}</p><p>{operation.result?.message ?? operation.message ?? "Execution was interrupted or is still running. Database effects are unconfirmed; inspect before retrying."}</p>{operation.result?.diagnostic ? <code>{operation.result.diagnostic.code}</code> : null}{operation.reviewDigest ? <p className="small">Reviewed operation digest <code>{operation.reviewDigest}</code></p> : null}{operation.taskArn ? <p className="small">Task <code>{operation.taskArn}</code> · client token <code>{operation.requestId}</code>. Inspect this exact task and its CloudWatch stream before retrying.</p> : null}{operation.cloudRecovery ? <details><summary>Recorded AWS recovery destination</summary><p>Profile <code>{operation.cloudRecovery.profile}</code> · region <code>{operation.cloudRecovery.region}</code> · cluster <code>{operation.cloudRecovery.cluster}</code></p><p>CloudWatch group <code>{operation.cloudRecovery.logGroup}</code> · stream <code>{operation.cloudRecovery.logStream}</code></p>{!operation.taskArn ? <p>If submission returned no ARN, locate the task with ECS list-tasks using started-by <code>{operation.requestId}</code> in this recorded cluster. Do not submit another write to discover its status.</p> : null}</details> : null}{operation.migrations.length ? <p className="small">Reviewed packages: {operation.migrations.join(", ")}</p> : null}</div>)}</details> : null}
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
    <section className="workbench-card" style={{ marginTop: 16 }}><h3>The next safe action</h3><ol className="workbench-step-list"><li>Review and save the source proposal.</li><li>Generate application artifacts with <code>npm --workspace @repo/database run generate</code> and review repositories, GraphQL authorization and client impact.</li><li>Choose the intended historical baseline and plan a migration offline.</li><li>Review SQL, constraints, destructive changes and data transformations.</li><li>Apply the reviewed migration only with explicit target approval, then inspect again.</li></ol><p className="small muted">Local startup verifies storage without applying migrations, pruning users or setting up test identity. A failed verification leaves PostgreSQL available for inspection and a separately reviewed initialization/migration. Production retains private IAM/TLS access.</p></section>
    {application ? <WorkbenchDialog title="Authorize reviewed database application" busy={applying} onClose={() => setApplication(undefined)} footer={<><button className="quiet" autoFocus disabled={applying} onClick={() => setApplication(undefined)}>Back to database status</button><button className="primary" disabled={applying || confirmation !== application.confirmation || dirty} onClick={() => void apply()}>{applying ? "Applying reviewed database change…" : application.kind === "initialize" ? "Initialize reviewed empty database" : "Apply reviewed migration"}</button></>}>
      <p><strong>{application.targetLabel}</strong> · {application.kind === "initialize" ? "Initialize verified empty storage" : "Apply reviewed migration path"} · target identity <code>{shortHash(application.targetIdentity)}</code> · {shortHash(application.from)} → {shortHash(application.to)}</p><ul>{application.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
      {application.initialization ? <section className="workbench-card"><h3>Reviewed initialization SQL</h3>{application.initialization.operations.map(operation => <p key={operation.id}>{operation.label} · {operation.operationClass}</p>)}{application.initialization.statements ? application.initialization.statements.map((statement, index) => <pre key={index}>{statement.operationId} · {statement.phase}{"\n"}{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>) : application.initialization.sql.map((sql, index) => <pre key={index}>{sql}</pre>)}<details><summary>Prisma control schema and table DDL</summary>{application.initialization.controlSql?.map((statement, index) => <pre key={index}>{statement.sql}</pre>)}</details></section> : null}
      {application.migrations.map(migration => <section className="workbench-card" key={migration.id}><h3>{migration.name}</h3>{migration.operations.map((operation, index) => <div key={index}><p><strong>{operation.label}</strong> · {operation.operationClass}</p>{operation.statements.map((statement, at) => <pre key={at}>{statement.phase}{"\n"}{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>)}</div>)}<details><summary>Executable migration source</summary><pre>{migration.source}</pre></details></section>)}
      <p className="workbench-notice warning">This changes the selected database and may transform or delete data. Source undo does not roll back a database. The reviewed target and historical schema are checked again before execution.</p><label className="workbench-confirmation">Type <strong>{application.confirmation}</strong> to authorize this application<input aria-label="Confirm database target" autoComplete="off" spellCheck={false} value={confirmation} disabled={applying} onChange={event => setConfirmation(event.target.value)} /></label>
    </WorkbenchDialog> : null}
  </div>;
}
