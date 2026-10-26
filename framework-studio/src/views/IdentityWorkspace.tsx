import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DomainsObservation, IdentitySelection, IdentitySource } from "../../shared/identity";
import { domainSettingsProblems } from "../../shared/domain-settings";
import { deployApi } from "../deploy/api";
import { identityApi, inspectionErrorMessage } from "../identity-api";
import { useStudio } from "../studio";
import { DraftFooter } from "./DraftControls";
import { InspectorSwitch } from "./InspectorUI";
import { DomainOperations } from "./DomainOperations";
import "./identity-workspace.css";

export { identityApi } from "../identity-api";

function DomainControls({ source }: { readonly source: IdentitySource }) {
  const { draft, draftState, live } = useStudio();
  const pending = draft.environment("prod");
  const values = { ...source.inputs, ...Object.fromEntries((pending?.edits ?? []).map(edit => [edit.name, edit.value])) };
  const disabled = !source.exists || !!draftState.busy || draft.conflict || live.evaluating || draftState.entries.some(entry => entry.kind !== "environment" || entry.mode !== "prod");
  const stage = (name: string, value: string) => draft.setEnvironment("prod", pending?.hash ?? source.hash, [...(pending?.edits ?? []).filter(edit => edit.name !== name), { key: name, name, value, ...(Object.hasOwn(source.inputs, name) ? { original: source.inputs[name] } : { create: true as const }) }], Object.keys(source.inputs));
  const problems = domainSettingsProblems("prod", values);
  return <section className="identity-card"><h2>Production domain intent</h2><p>These settings edit the same protected <code>cdk-app/.env.prod</code> inputs used by Deploy. Source approval does not request a certificate, write DNS or deploy.</p>
    {[["Cognito authentication", "USE_COGNITO_CUSTOM_DOMAIN", "COGNITO_DOMAIN_NAME", "COGNITO_DOMAIN_CERTIFICATE_ARN"], ["Frontend", "USE_FRONTEND_CUSTOM_DOMAIN", "FRONTEND_URL", "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN"]].map(([title, toggle, domain, cert]) => <fieldset key={toggle}><legend>{title}</legend>
      <label className="identity-switch">Use custom domain <InspectorSwitch label={`Use ${title} custom domain`} checked={values[toggle!] !== "false"} onChange={checked => stage(toggle!, String(checked))} disabled={disabled} /></label>
      <label>{domain}<input aria-label={domain} value={values[domain!] ?? ""} disabled={disabled} spellCheck={false} onChange={event => stage(domain!, event.target.value)} placeholder={domain === "FRONTEND_URL" ? "https://app.example.com" : "auth.example.com"} /></label>
      <label>{cert}<input aria-label={cert} value={values[cert!] ?? ""} disabled={disabled} spellCheck={false} onChange={event => stage(cert!, event.target.value)} placeholder="arn:aws:acm:us-east-1:123456789012:certificate/…" /></label>
    </fieldset>)}
    {problems.length ? <div role="alert">{problems.map(problem => <p key={problem}>{problem}</p>)}</div> : null}
    <p className="muted">Both certificates must be in us-east-1 in the deployment account and cover the configured hostname. Cognito additionally needs an A record for the immediate parent hostname. Issued certificate metadata, DNS answers and actual application health are separate evidence.</p>
    <p><a href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html" target="_blank" rel="noreferrer">Cognito domain prerequisites</a> · <a href="https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html" target="_blank" rel="noreferrer">CloudFront certificate requirements</a></p>
  </section>;
}

function DomainEvidence({ result }: { result?: DomainsObservation }) {
  if (!result) return null;
  return <>{result.certificates.map(cert => <section className="identity-card" key={cert.purpose}><h2>{cert.purpose} certificate · {cert.status ?? "unavailable"}</h2><p><code>{cert.arn}</code></p><p>Names: {cert.names.join(", ") || "unobserved"} · expiry: {cert.expires ?? "unobserved"} · region: us-east-1 required</p>{cert.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}{cert.validation.map(record => <p key={record.domain}>{record.domain}: {record.status} · {record.type} {record.name} → {record.value}</p>)}</section>)}
    <section className="identity-card"><h2>DNS observations and external records</h2>{result.dns.map(record => <p key={record.hostname}>{record.hostname}: {record.addresses.join(", ") || record.problem}</p>)}{result.records.map(record => <div key={record.hostname}><h3>{record.hostname}</h3><p>{record.instruction}</p></div>)}{!result.records.length ? <p>No enabled production custom domains were configured.</p> : null}</section>
    <section className="identity-card"><h2>Frontend health</h2>{result.health.map(check => <p key={check.check}>{check.check}: <strong>{check.status}</strong>. {check.detail}</p>)}<p>DNS resolution and ACM metadata alone do not establish a healthy website.</p></section></>;
}

/** Domains retain their production-only input authority. Authentication lives
 * in AuthenticationWorkspace; only the transport is shared with this view. */
export function Domains() {
  const { snapshot, draft, draftState, select } = useStudio();
  const source = useQuery({ queryKey: ["identity-source", "prod", snapshot.revision], queryFn: ({ signal }) => identityApi.source("prod", signal) });
  const overview = useQuery({ queryKey: ["deploy", "overview"], queryFn: () => deployApi.overview() });
  const [selection, setSelection] = useState<IdentitySelection>({ profile: "dev", deployment: "", region: "us-east-1" });
  const [result, setResult] = useState<DomainsObservation>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [observedHash, setObservedHash] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => { request.current?.abort(); setResult(undefined); setError(""); setBusy(false); return () => request.current?.abort(); }, [selection.profile, selection.region, selection.deployment]);
  useEffect(() => { if (overview.data && !overview.data.targets.some(target => target.name === selection.deployment && target.mode === "prod")) { const target = overview.data.targets.find(target => target.mode === "prod"); setSelection(current => ({ ...current, deployment: target?.name ?? "", region: target?.region ?? current.region })); } }, [overview.data, selection.deployment]);
  const inspect = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    try { const next = await identityApi.inspect<DomainsObservation>("domains", selection, undefined, undefined, controller.signal); if (!controller.signal.aborted) { setResult(next); setObservedHash(source.data?.hash ?? ""); } }
    catch (error) { if (!controller.signal.aborted) setError(inspectionErrorMessage(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="identity-workspace"><header className="workspace-toolbar identity-workspace-header"><div className="workspace-page-width"><div className="workspace-heading"><h1 className="workspace-page-title">DNS / Domains</h1><span className="workspace-scope">Production domain settings</span></div><p>Source intent, deployed metadata and actual application health have independent evidence.</p></div></header>
    <div className="workspace-page-width identity-content">
    {source.error ? <div className="workspace-alert" role="alert"><span>{source.error.message}</span><button className="quiet" disabled={source.isFetching} onClick={() => void source.refetch()}>Retry source</button></div> : null}
    {source.isFetching && !source.data && !source.error ? <p className="muted" role="status">Loading source declaration…</p> : null}
    {source.data && !source.data.exists ? <section className="identity-card"><p>{source.data.file} does not exist. Generate it from its own template before staging settings.</p><button className="quiet" onClick={() => select("envfile:prod")}>Open environment file</button></section> : null}
    <section className="identity-card"><h2>Read-only deployment inspection</h2>
      {overview.error ? <div className="workspace-alert" role="alert"><span>{overview.error.message}</span><button className="quiet" disabled={overview.isFetching} onClick={() => void overview.refetch()}>Retry deployments</button></div> : null}
      {overview.isFetching && !overview.data && !overview.error ? <p className="muted" role="status">Loading deployment context…</p> : null}
      <div className="identity-toolbar inspection-controls">
      <label>Profile<input aria-label="Identity AWS profile" value={selection.profile} onChange={event => setSelection({ ...selection, profile: event.target.value })} list="identity-profiles" /><datalist id="identity-profiles">{overview.data?.profiles.map(profile => <option key={profile.name}>{profile.name}</option>)}</datalist></label>
      <label>Deployment<select aria-label="Identity deployment" value={selection.deployment} onChange={event => { const target = overview.data?.targets.find(target => target.name === event.target.value); setSelection({ ...selection, deployment: event.target.value, region: target?.region ?? selection.region }); }}><option value="">Select a deployment</option>{overview.data?.targets.filter(target => target.mode === "prod").map(target => <option key={target.name} value={target.name}>{target.name} · {target.mode}</option>)}</select></label>
      <label>Region<input aria-label="Identity AWS region" value={selection.region} onChange={event => setSelection({ ...selection, region: event.target.value })} /></label>
      <button className="primary" disabled={busy || !selection.deployment} onClick={() => void inspect()}>{busy ? "Inspecting…" : "Inspect deployed settings"}</button>
    </div><p className="muted">Reads verified owned CloudFormation resources using the selected credentials. No users, policies, DNS, certificates or stacks are modified.</p>
      {error ? <p role="alert">{error}</p> : null}{result ? <p role="status">Observed {result.context.observedAt} · account {result.context.account} · {result.context.region} · {result.context.deployment}. Production source intent is shown separately below.</p> : <p>Deployed state: unverified. Choose Inspect to read AWS.</p>}
      {result && observedHash !== source.data?.hash ? <p role="alert">Source inputs changed since this observation. Inspect again before comparing source intent with deployed settings.</p> : null}
      {result?.warnings.map(warning => <p className="muted" key={warning}>{warning}</p>)}
    </section>
    {source.data ? <DomainControls source={source.data} /> : null}<DomainEvidence result={result} /><DomainOperations selection={selection} />
    {draftState.error ? <p className="workspace-alert" role="alert">{draftState.error}</p> : null}{draft.dirty ? <DraftFooter /> : null}
    </div>
  </div>;
}
