import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Mode } from "../../shared/model";
import type { StatefulInventory, StatefulKind, StatefulPlan, StatefulSelection, StatefulSource } from "../../shared/stateful-resources";
import type { TeardownPlanView } from "../../shared/deploy";
import { call } from "../api";
import { deployApi } from "../deploy/api";
import { useStudio } from "../studio";
import { WorkbenchDialog } from "./WorkbenchUI";

const title = (kind: StatefulKind) => kind === "database" ? "Database" : "Cognito User Pool";
const resourceType = (kind: StatefulKind) => kind === "database" ? "AWS::RDS::DBInstance" : "AWS::Cognito::UserPool";

export function LifecycleDisclosure({ selection }: { readonly selection: StatefulSelection }) {
  const [open, setOpen] = useState(false);
  return <details className="state-panel" onToggle={event => setOpen(event.currentTarget.open)}><summary>Stateful retention and retained-resource references</summary>{open ? <DataRetention selection={selection} /> : null}</details>;
}

export function DataRetention({ kind, selection: suppliedSelection }: { readonly kind?: StatefulKind; readonly selection?: StatefulSelection }) {
  const { snapshot, mode: selectedMode, draft, draftState, live } = useStudio();
  const [mode, setMode] = useState<Mode>(suppliedSelection?.mode ?? selectedMode);
  const [source, setSource] = useState<StatefulSource>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>();
  const [plan, setPlan] = useState<StatefulPlan>();
  const generation = useRef(0);
  const sourceBusy = draft.dirty || !!draftState.busy || live.evaluating || draft.conflict;
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const load = async (selected: Mode, request: number) => { const next = await call<StatefulSource>(`/stateful-resources/source?mode=${selected}`); if (generation.current === request) setSource(next); };
  useEffect(() => { setMode(suppliedSelection?.mode ?? selectedMode); }, [suppliedSelection?.mode, selectedMode]);
  useEffect(() => { const request = ++generation.current; setSource(undefined); setPlan(undefined); setError(undefined); setMessage(undefined); void load(mode, request).catch(error => { if (generation.current === request) setError(error instanceof Error ? error.message : String(error)); }); return () => { generation.current++; }; }, [mode, snapshot.revision]);
  const kinds: readonly StatefulKind[] = kind ? [kind] : ["database", "cognito"];
  return <section className="data-retention" aria-label="Stateful retention and reuse"><h2>Retention and reuse</h2>
    <p>Configure each resource in TypeScript, review the change, then deploy separately. Existing policies inherit <code>RETAIN_STATEFUL_RESOURCES</code> until explicitly changed.</p>
    {error ? <p className="reason" role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    {sourceBusy ? <p className="small muted">Finish or discard the current source draft before changing lifecycle configuration.</p> : null}
    <label>Environment <select aria-label="Retention environment" value={mode} disabled={busy || sourceBusy || !!suppliedSelection} onChange={event => setMode(event.target.value as Mode)}><option value="dev">Development</option><option value="prod">Production</option></select></label>
    {source?.problems.map(problem => <p key={problem} className="reason" role="alert">{problem}</p>)}
    <div className="stateful-policies">{kinds.map(resource => { const value = source?.resources[resource]; const effective = value?.retention ?? (source?.legacy.retain ? "retain" : "remove");
      return <section key={resource} className="stateful-policy"><h3>{title(resource)}</h3><p><strong>Configured intent:</strong> {source ? `${effective === "retain" ? "Retain" : "Remove"}${value?.retention ? " · explicit TypeScript policy" : " · inherited legacy policy"}` : "Loading source…"}</p>
        <p><strong>Management:</strong> {value?.reference ? "Externally referenced; the original resource stays outside this stack’s management." : "Framework-managed when deployed."}</p>
        {value?.reference ? <p><code>{"userPoolId" in value.reference ? value.reference.userPoolId : value.reference.instanceIdentifier}</code></p> : null}
        <label>{title(resource)} policy <select aria-label={`${title(resource)} retention policy`} value={value?.retention ?? "inherit"} disabled={busy || sourceBusy || !source || !!source.problems.length || !!value?.reference} onChange={event => { const retention = event.target.value; void run(async () => setPlan(await call<StatefulPlan>("/stateful-resources/retention/plan", { mode, kind: resource, retention, hash: source!.hash, revision: snapshot.revision }))); }}><option value="inherit">Inherit legacy input</option><option value="retain">Retain</option><option value="remove">Remove</option></select></label>
        {value?.reference ? <p className="small">This policy applies to managed creation only. Deleting this deployment does not delete the externally referenced resource or change its protection.</p> : null}
        {resource === "database" && mode === "dev" ? <p className="small">Development uses local PostgreSQL. This AWS policy does not control Docker volumes.</p> : null}
      </section>; })}</div>
    {source ? <p className="small muted"><code>{source.file}</code> · legacy fallback from <code>{source.legacy.file}</code>: {source.legacy.configured ? String(source.legacy.retain) : "absent; existing default false"}. Deployment context overrides and custom input files require review in Deploy.</p> : null}
    <StatefulRecovery key={`${kind ?? "all"}:${mode}:${suppliedSelection?.deployment ?? ""}:${suppliedSelection?.profile ?? ""}:${suppliedSelection?.region ?? ""}`} mode={mode} kinds={kinds} selection={suppliedSelection} disabled={busy || sourceBusy || !source} onReview={async payload => { const request = generation.current; await run(async () => { const reviewed = await call<StatefulPlan>("/stateful-resources/reference/plan", { ...payload, hash: source!.hash, revision: snapshot.revision }); if (generation.current === request) setPlan(reviewed); }); }} />
    <details><summary>Local PostgreSQL persistence</summary><p>The <code>postgres_data</code> volume survives ordinary Compose stop/restart and container recreation. Reconnect with the same Compose project and volume. Removing that volume permanently deletes its data. No volume or schema is changed here.</p></details>
    <details><summary>Retain, reference, import and restore</summary><p>Retain leaves a physical resource and its ongoing costs after stack deletion. Reference connects a new deployment to that same externally managed resource. It does not give CloudFormation management authority. Import into CloudFormation and restore from snapshot require separate procedures; this workspace does not execute them.</p><p>RDS requires its original compatible network, encryption key, secret and IAM database login. Cognito requires the original pool and a usable existing app client; providers, domains, groups and triggers remain separate dependencies. Deleted pools, users and passwords cannot be recreated by referencing a new empty pool.</p></details>
    {plan ? <WorkbenchDialog title="Review lifecycle source" busy={busy} onClose={() => setPlan(undefined)} footer={<><button className="quiet" disabled={busy} onClick={() => setPlan(undefined)}>Cancel</button><button className="primary" disabled={busy || sourceBusy} onClick={() => void run(async () => { const result = await call<{ message: string }>("/stateful-resources/apply", { planId: plan.planId }); setPlan(undefined); setMessage(result.message); await load(mode, generation.current); })}>Save lifecycle source</button></>}>
      {error ? <p role="alert" className="reason">{error}</p> : null}<ul>{plan.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>{(plan.inspection?.evidence?.checks ?? plan.inspection?.checks)?.length ? <details><summary>Read-only compatibility evidence</summary><ul>{(plan.inspection?.evidence?.checks ?? plan.inspection?.checks)?.map(check => <li key={check}>{check}</li>)}</ul></details> : null}{plan.inspection?.warnings?.map(warning => <p key={warning} className="reason">{warning}</p>)}{plan.changes.map(change => <pre key={change.file}>{change.diff.unified}</pre>)}
    </WorkbenchDialog> : null}
  </section>;
}

function StatefulRecovery({ mode, kinds, selection: supplied, disabled, onReview }: { mode: Mode; kinds: readonly StatefulKind[]; selection?: StatefulSelection; disabled: boolean; onReview(payload: Record<string, unknown>): Promise<void> }) {
  const overview = useQuery({ queryKey: ["deploy", "overview"], queryFn: () => deployApi.overview(), staleTime: 15_000 });
  const [profile, setProfile] = useState(supplied?.profile ?? "dev"), [deployment, setDeployment] = useState(supplied?.deployment ?? ""), [region, setRegion] = useState(supplied?.region ?? "");
  const [kind, setKind] = useState<StatefulKind>(kinds[0]!);
  const [id, setId] = useState(""), [originalDeployment, setOriginalDeployment] = useState(""), [clientId, setClientId] = useState("");
  const [inventory, setInventory] = useState<StatefulInventory>(), [deployed, setDeployed] = useState<TeardownPlanView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [policyError, setPolicyError] = useState<string>();
  const context = JSON.stringify([mode, profile, deployment, region]); const latest = useRef(context); latest.current = context;
  useEffect(() => { setInventory(undefined); setDeployed(undefined); setError(undefined); setPolicyError(undefined); setId(""); setOriginalDeployment(""); setClientId(""); }, [context]);
  const selection = { mode, profile, deployment, region };
  const target = overview.data?.targets.find(target => target.name === deployment && target.mode === mode);
  const candidates = inventory?.ledgers.flatMap(ledger => [...ledger.observations].reverse().flatMap(observation => observation.resources.filter(resource => resource.type === resourceType(kind) && resource.physicalId).map(resource => ({ ...resource, originalDeployment: ledger.deployment, phase: observation.phase, observedAt: observation.createdAt })))) ?? [];
  const unique = candidates.filter((candidate, at) => candidates.findIndex(other => other.physicalId === candidate.physicalId && other.originalDeployment === candidate.originalDeployment) === at);
  const inspect = async () => { const captured = context; setBusy(true); setError(undefined); setPolicyError(undefined); setInventory(undefined); setDeployed(undefined);
    const results = await Promise.allSettled([call<StatefulInventory>("/stateful-resources/inventory", { selection }), deployApi.teardown(profile, deployment, mode, region)]);
    if (latest.current === captured) { const [records, policies] = results; if (records.status === "fulfilled") setInventory(records.value); else setError(records.reason instanceof Error ? records.reason.message : String(records.reason)); if (policies.status === "fulfilled" && policies.value.ok) setDeployed(policies.value.value); else setPolicyError(policies.status === "rejected" ? String(policies.reason) : policies.value.ok ? "" : policies.value.problem.message); } setBusy(false);
  };
  return <section className="stateful-recovery" aria-label="Retained resource references"><h3>Inspect protection and retained resources</h3><p>Read deployed templates and saved teardown evidence, then review an explicit reference. A saved observation alone does not prove that a resource is still available.</p>
    <div className="stateful-context"><label>AWS profile<input aria-label="Lifecycle AWS profile" value={profile} disabled={busy || !!supplied} onChange={event => setProfile(event.target.value)} /></label><label>Destination deployment<select aria-label="Lifecycle destination" value={deployment} disabled={busy || !!supplied} onChange={event => { const target = overview.data?.targets.find(target => target.name === event.target.value); setDeployment(event.target.value); setRegion(target?.region ?? overview.data?.profiles.find(entry => entry.name === profile)?.region ?? region); }}><option value="">Select destination</option>{overview.data?.targets.filter(target => target.mode === mode).map(target => <option key={target.name} value={target.name}>{target.name}</option>)}</select></label><label>Region<input aria-label="Lifecycle region" value={region} disabled={busy || !!supplied || !!target?.region} onChange={event => setRegion(event.target.value)} /></label></div>
    <button className="quiet" disabled={busy || disabled || !profile || !target || !region} onClick={() => void inspect()}>{busy ? "Inspecting…" : "Inspect deployed protection and inventory"}</button>
    {overview.error ? <p role="alert">Deployment destinations unavailable: {overview.error.message}</p> : null}{error ? <p role="alert" className="reason">{error}</p> : null}
    <p><strong>Deployed retention:</strong> {!deployed ? "Unverified for this destination." : `${deployed.remains.filter(resource => kinds.some(kind => resource.type === resourceType(kind))).length} stateful resource policies leave a resource or snapshot; inspect the exact consequences below.`}</p>
    {policyError ? <p role="alert">Deployed template inspection unavailable: {policyError}</p> : null}
    {deployed ? <details open><summary>Observed teardown consequences</summary><ul>{deployed.remains.filter(resource => kinds.some(kind => resource.type === resourceType(kind))).map(resource => <li key={`${resource.stack}/${resource.logicalId}`}><code>{resource.stack}/{resource.logicalId}</code> · {resource.policy}</li>)}</ul>{!deployed.remains.some(resource => kinds.some(kind => resource.type === resourceType(kind))) ? <p>No retained primary resource was reported. Review the full teardown plan in Deploy before relying on protection.</p> : null}{deployed.blockers?.map(problem => <p key={problem} className="reason">{problem}</p>)}{deployed.warnings?.map(warning => <p key={warning} className="small">{warning}</p>)}<p className="small">This is a read-only preview. No teardown was authorized or started.</p></details> : null}
    {inventory ? <><p>Inventory scope: account <code>{inventory.account}</code> · {inventory.region}. RDS instances/storage, snapshots, KMS and Secrets Manager can continue incurring charges. Exact costs are unverified.</p>{!unique.length ? <p>No saved {title(kind).toLowerCase()} identity was found. Older teardown evidence may be unavailable in this checkout; an exact resource with verified ownership tags can still be inspected below.</p> : <ul className="stateful-candidates">{unique.map(candidate => <li key={`${candidate.originalDeployment}/${candidate.physicalId}`}><button className="linkish" onClick={() => { setId(candidate.physicalId!); setOriginalDeployment(candidate.originalDeployment); }}><code>{candidate.physicalId}</code></button><span>{candidate.originalDeployment} · state uncertain until live reference validation · {candidate.phase} · {candidate.observedAt}</span></li>)}</ul>}</> : null}
    <details><summary>Reference a retained resource</summary><p>Only an available resource with proven original ownership and compatible dependencies can pass review. Managed resources, conflicting claims and unsafe in-place transitions are refused.</p>{kinds.length > 1 ? <label>Resource<select aria-label="Reference resource kind" value={kind} onChange={event => { setKind(event.target.value as StatefulKind); setId(""); setOriginalDeployment(""); setClientId(""); }}>{kinds.map(kind => <option key={kind} value={kind}>{title(kind)}</option>)}</select></label> : null}
      <label>Original deployment<input aria-label="Original resource deployment" value={originalDeployment} disabled={busy || disabled} onChange={event => setOriginalDeployment(event.target.value)} /></label><label>Physical resource ID<input aria-label="Retained resource ID" value={id} disabled={busy || disabled} onChange={event => setId(event.target.value)} /></label>{kind === "cognito" ? <label>Existing app client ID<input aria-label="Retained Cognito app client ID" value={clientId} disabled={busy || disabled} onChange={event => setClientId(event.target.value)} /></label> : null}
      <button className="primary" disabled={busy || disabled || !profile || !target || !region || !id || !originalDeployment || kind === "cognito" && !clientId} onClick={() => void onReview({ selection, kind, id, originalDeployment, ...(kind === "cognito" ? { clientId } : {}) })}>Inspect and review reference source</button><p className="small">After saving, review and deploy supporting infrastructure in Deploy. Verify actual database records or Cognito sign-in separately. CloudFormation import, snapshot restoration and permanent resource deletion are separate operations.</p>
    </details>
  </section>;
}
