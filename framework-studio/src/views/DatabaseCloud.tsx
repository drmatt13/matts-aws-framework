import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { useEffect, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseTarget } from "../../shared/database-workbench";
import type { DatabaseApplicationResult } from "../../shared/database-application";
import type { DatabaseCloudApproval, DatabaseCloudDestination } from "../../shared/database-cloud";
import { call } from "../http";
import { WorkbenchDialog, workbenchCardClasses, workbenchNoticeClasses } from "./WorkbenchUI";

export const databaseCloudApi = {
  prepare: (deployment: string, profile: string) => call<DatabaseCloudDestination>("/database/cloud/prepare", { deployment, profile }),
  review: (destination: DatabaseCloudDestination, confirmation: string) => call<DatabaseCloudApproval>("/database/cloud/review", { deployment: destination.identity.deployment, profile: destination.profile, preparationId: destination.id, confirmation }),
  apply: (reviewId: string, confirmation: string) => call<DatabaseApplicationResult>("/database/cloud/apply", { reviewId, confirmation }),
};

export function DatabaseCloud({ target, dirty, onOutcome, onBusyChange }: { readonly target: DatabaseTarget; readonly dirty: boolean; readonly onOutcome: () => void; readonly onBusyChange?: (busy: boolean) => void }) {
  const [deployment, setDeployment] = useState("");
  const [profile, setProfile] = useState("dev");
  const [destination, setDestination] = useState<DatabaseCloudDestination>();
  const [approval, setApproval] = useState<DatabaseCloudApproval>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"preparing" | "inspecting" | "applying">();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<DatabaseApplicationResult>();
  useBlocker({ shouldBlockFn: () => busy === "inspecting" || busy === "applying", enableBeforeUnload: !!busy });
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { setDestination(undefined); setApproval(undefined); setConfirmation(""); }, [deployment, profile, target.identity]);
  const prepare = async () => {
    setBusy("preparing"); setError(undefined); setResult(undefined);
    try { setDestination(await databaseCloudApi.prepare(deployment, profile)); setConfirmation(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  };
  const inspect = async () => {
    if (!destination) return;
    setBusy("inspecting"); setError(undefined);
    try { setApproval(await databaseCloudApi.review(destination, confirmation)); setDestination(undefined); setConfirmation(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setDestination(undefined); }
    finally { setBusy(undefined); onOutcome(); }
  };
  const apply = async () => {
    if (!approval) return;
    setBusy("applying"); setError(undefined);
    try { setResult(await databaseCloudApi.apply(approval.id, confirmation)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); setApproval(undefined); onOutcome(); }
  };
  const identity = destination?.identity ?? approval?.review.identity;
  const placement = destination ?? approval?.destination;
  return <section data-ui="workbench-card" className={workbenchCardClasses}><h3>Production database review</h3>
    <p>Select a named production deployment and AWS profile. Check destination only reads AWS metadata. Read-only inspection and the separately approved database write each launch a billed Fargate task using its declared VPC networking. Task public-IP assignment may be enabled; the database remains private and uses IAM/TLS. Empty storage initialization and migration application each require their own SQL review.</p>
    <div data-ui="workbench-observation-heading" className="flex flex-wrap items-center gap-3 [&_label]:grid [&_label]:gap-1.25 [&_label]:text-meta [&_select]:min-w-65 vp-480:[&_label]:w-full vp-480:[&_select]:min-w-0 vp-480:[&_select]:w-full"><label>Production deployment<Select aria-label="Production database deployment" value={deployment} disabled={!!busy} onChange={event => setDeployment(event.target.value)}><option value="">Choose a production deployment…</option>{target.handoffs?.map(item => <option key={item.deployment} value={item.deployment}>{item.deployment} · {item.account ?? "unpinned account"} · {item.region ?? "unpinned region"}</option>)}</Select></label><label>AWS profile<TextInput aria-label="Production database AWS profile" value={profile} disabled={!!busy} onChange={event => setProfile(event.target.value)} /></label><button className={buttonClasses({ variant: "quiet" })} disabled={!deployment || !profile.trim() || !!busy || dirty} onClick={() => void prepare()}>{busy === "preparing" ? "Checking destination…" : "Check database task destination"}</button></div>
    {error ? <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">{error}</p> : null}
    {result ? <p data-ui="workbench-notice" className={workbenchNoticeClasses(["applied", "unchanged"].includes(result.status) ? "neutral" : "warning")} role="status">{result.message}{result.diagnostic ? ` ${result.diagnostic.code}: ${result.diagnostic.action}` : ""}</p> : null}
    {identity ? <WorkbenchDialog title={destination ? "Authorize billed read-only database inspection" : approval?.review.kind === "initialize" ? "Review empty production database initialization" : "Review production SQL and authorize application"} busy={!!busy} onClose={() => { setDestination(undefined); setApproval(undefined); }} footer={<><button className={buttonClasses({ variant: "quiet" })} autoFocus disabled={!!busy} onClick={() => { setDestination(undefined); setApproval(undefined); }}>Back to database status</button>{destination ? <button data-variant="primary" className={buttonClasses({ variant: "primary" })} disabled={!!busy || dirty || confirmation !== `Inspect ${identity.deployment}`} onClick={() => void inspect()}>{busy === "inspecting" ? "Waiting for read-only task…" : "Start billed read-only task"}</button> : <button data-variant="primary" className={buttonClasses({ variant: "primary" })} disabled={!!busy || dirty || confirmation !== approval?.confirmation || (!approval?.review.initialization && !approval?.review.migrations.length)} onClick={() => void apply()}>{busy === "applying" ? "Waiting for reviewed database task…" : approval?.review.kind === "initialize" ? "Initialize reviewed production database" : "Apply reviewed production SQL"}</button>}</>}>
      <p><strong>{identity.deployment}</strong> · account {identity.account} · {identity.region} · profile {destination?.profile ?? approval?.profile}</p><p>Task definition <code>{identity.taskDefinitionArn}</code> · reviewed database protocol v1</p>
      {placement ? <section data-ui="workbench-card" className={workbenchCardClasses} aria-label="Database task networking"><h3>Declared task networking</h3><p>Cluster <code>{placement.launch.cluster}</code> · {placement.launch.launchType} · platform {placement.launch.platformVersion} · container {placement.launch.containerName}</p><p>Public IP assignment: <strong>{placement.launch.assignPublicIp ? "Enabled" : "Disabled"}</strong>. Database access remains private with IAM/TLS.</p><p>Subnets: {placement.launch.subnets.map(subnet => <code key={subnet}>{subnet}{" "}</code>)}</p><p>Security groups: {placement.launch.securityGroups.map(group => <code key={group}>{group}{" "}</code>)}</p><p>CloudWatch group <code>{placement.logs.group}</code> · stream prefix <code>{placement.logs.streamPrefix}</code></p></section> : null}
      {destination ? <ul>{destination.effects.map(effect => <li key={effect}>{effect}</li>)}</ul> : null}
      {approval?.review.initialization ? <section data-ui="workbench-card" className={workbenchCardClasses}><h3>Initialize verified empty production storage</h3><p>No application objects, extra user schemas, large objects, marker or ledger may exist. The same emptiness proof and exact additive plan are checked again inside the writer transaction. Existing populated storage is never adopted or reset. This creates modeled storage and Prisma control metadata; IAM roles remain infrastructure-owned.</p>{approval.review.initialization.operations.map(operation => <p key={operation.id}>{operation.label} · {operation.operationClass}</p>)}{approval.review.initialization.statements ? approval.review.initialization.statements.map((statement, index) => <pre key={index}>{statement.operationId} · {statement.phase}{"\n"}{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>) : approval.review.initialization.sql.map((sql, index) => <pre key={index}>{sql}</pre>)}<details open><summary>Prisma control schema and table DDL</summary>{approval.review.initialization.controlSql?.map((statement, index) => <pre key={index}>{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>)}</details></section> : null}
      {approval?.review.helpers?.map(helper => <details key={helper.file}><summary>Imported migration helper · {helper.file}</summary><pre>{helper.source}</pre></details>)}
      {approval ? <><p>Storage {approval.review.markerHash} → {approval.review.storageHash}</p><p className="text-caption text-graphite">Exact source/image inputs, marker identities, migration ledger and SQL are bound to review {approval.review.digest}. Approval expires {new Date(approval.expiresAt).toLocaleTimeString()}.</p>{approval.review.migrations.length ? approval.review.migrations.map(migration => <section data-ui="workbench-card" className={workbenchCardClasses} key={`${migration.spaceId}/${migration.dirName}`}><h3>{migration.spaceId}/{migration.dirName}</h3>{migration.sql.map((statement, index) => <pre key={index}>{statement.phase}{"\n"}{statement.sql}{statement.params?.length ? `\nParameters: ${JSON.stringify(statement.params)}` : ""}</pre>)}<details><summary>Executable migration source</summary><pre>{migration.source}</pre></details></section>) : approval.review.kind === "initialize" ? null : <p>No pending migrations were found. The database was unchanged.</p>}<p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")}>{approval.review.kind === "initialize" ? "Initialize starts another billed task and applies the reviewed additive SQL for modeled storage and Prisma control metadata. It repeats the empty-database check inside the writer transaction and refuses populated storage." : "Apply starts another billed task and can transform or delete data. It rechecks the exact path, marker, ledger and historical physical schema inside its database transaction before SQL executes."} Editing source cannot roll back a database. Closing Studio does not cancel a submitted task; inspect its recorded ARN before retrying an uncertain outcome.</p></> : null}
      <label data-ui="workbench-confirmation" className="mt-4 grid gap-2 text-label">Type <strong>{destination ? `Inspect ${identity.deployment}` : approval?.confirmation}</strong><TextInput aria-label="Confirm production database action" autoComplete="off" spellCheck={false} disabled={!!busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    </WorkbenchDialog> : null}
  </section>;
}
