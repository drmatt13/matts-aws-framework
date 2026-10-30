import { RetryNotice } from "./RetryNotice";
import { identitySourceQuery } from "../identity-queries";
import { deploymentOverviewQuery } from "../deploy/queries";
import { useQuery } from "@tanstack/react-query";
import { useEffect,useRef,useState } from "react";
import { domainSettingsProblems } from "../../shared/domain-settings";
import type { DomainsObservation,IdentitySelection,IdentitySource } from "../../shared/identity";
import { deployApi } from "../deploy/api";
import { identityApi,inspectionErrorMessage } from "../identity-api";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { Select,TextInput } from "../ui/FormControls";
import { noticeClasses,workspaceToolbarClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import { DocumentCard,documentFieldsetClasses,documentLabelClasses,inspectionControlClasses,pageWidthClasses } from "./DocumentUI";
import { DomainOperations } from "./DomainOperations";
import { DraftFooter } from "./DraftControls";
import { InspectorSwitch } from "./InspectorUI";


function DomainControls({ source }: { readonly source: IdentitySource }) {
  const { draft, draftState, live } = useStudio();
  const pending = draft.environment("prod");
  const values = { ...source.inputs, ...Object.fromEntries((pending?.edits ?? []).map(edit => [edit.name, edit.value])) };
  const disabled = !source.exists || !!draftState.busy || draft.conflict || live.evaluating || draftState.entries.some(entry => entry.kind !== "environment" || entry.mode !== "prod");
  const stage = (name: string, value: string) => draft.setEnvironment("prod", pending?.hash ?? source.hash, [...(pending?.edits ?? []).filter(edit => edit.name !== name), { key: name, name, value, ...(Object.hasOwn(source.inputs, name) ? { original: source.inputs[name] } : { create: true as const }) }], Object.keys(source.inputs));
  const problems = domainSettingsProblems("prod", values);
  return <DocumentCard ><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>Production domain intent</h2><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>These settings edit the same protected <code>cdk-app/.env.prod</code> inputs used by Deploy. Source approval does not request a certificate, write DNS or deploy.</p>
    {[["Cognito authentication", "USE_COGNITO_CUSTOM_DOMAIN", "COGNITO_DOMAIN_NAME", "COGNITO_DOMAIN_CERTIFICATE_ARN"], ["Frontend", "USE_FRONTEND_CUSTOM_DOMAIN", "FRONTEND_URL", "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN"]].map(([title, toggle, domain, cert]) => <fieldset className={documentFieldsetClasses} key={toggle}><legend className={"px-1 text-label"}>{title}</legend>
      <label className={cx(documentLabelClasses, "!flex-row items-center justify-between gap-4")}>Use custom domain <InspectorSwitch label={`Use ${title} custom domain`} checked={values[toggle!] !== "false"} onChange={checked => stage(toggle!, String(checked))} disabled={disabled} /></label>
      <label className={documentLabelClasses}>{domain}<TextInput className={"w-full"} aria-label={domain} value={values[domain!] ?? ""} disabled={disabled} spellCheck={false} onChange={event => stage(domain!, event.target.value)} placeholder={domain === "FRONTEND_URL" ? "https://app.example.com" : "auth.example.com"} /></label>
      <label className={documentLabelClasses}>{cert}<TextInput className={"w-full"} aria-label={cert} value={values[cert!] ?? ""} disabled={disabled} spellCheck={false} onChange={event => stage(cert!, event.target.value)} placeholder="arn:aws:acm:us-east-1:123456789012:certificate/…" /></label>
    </fieldset>)}
    {problems.length ? <div className={noticeClasses()} role="alert">{problems.map(problem => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"} key={problem}>{problem}</p>)}</div> : null}
    <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"}>Both certificates must be in us-east-1 in the deployment account and cover the configured hostname. Cognito additionally needs an A record for the immediate parent hostname. Issued certificate metadata, DNS answers and actual application health are separate evidence.</p>
    <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}><a href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html" target="_blank" rel="noreferrer">Cognito domain prerequisites</a> · <a href="https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html" target="_blank" rel="noreferrer">CloudFront certificate requirements</a></p>
  </DocumentCard>;
}

function DomainEvidence({ result }: { result?: DomainsObservation }) {
  if (!result) return null;
  return <>{result.certificates.map(cert => <DocumentCard  key={cert.purpose}><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>{cert.purpose} certificate · {cert.status ?? "unavailable"}</h2><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}><code>{cert.arn}</code></p><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Names: {cert.names.join(", ") || "unobserved"} · expiry: {cert.expires ?? "unobserved"} · region: us-east-1 required</p>{cert.problems.map(problem => <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert" key={problem}>{problem}</p>)}{cert.validation.map(record => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"} key={record.domain}>{record.domain}: {record.status} · {record.type} {record.name} → {record.value}</p>)}</DocumentCard>)}
    <DocumentCard ><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>DNS observations and external records</h2>{result.dns.map(record => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"} key={record.hostname}>{record.hostname}: {record.addresses.join(", ") || record.problem}</p>)}{result.records.map(record => <div key={record.hostname}><h3 className={"mt-3 mb-2 text-label"}>{record.hostname}</h3><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>{record.instruction}</p></div>)}{!result.records.length ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>No enabled production custom domains were configured.</p> : null}</DocumentCard>
    <DocumentCard ><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>Frontend health</h2>{result.health.map(check => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"} key={check.check}>{check.check}: <strong>{check.status}</strong>. {check.detail}</p>)}<p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>DNS resolution and ACM metadata alone do not establish a healthy website.</p></DocumentCard></>;
}

/** Domains retain their production-only input authority. Authentication lives
 * in AuthenticationWorkspace; only the transport is shared with this view. */
export function DomainsWorkspace() {
  const { snapshot, draft, draftState, select } = useStudio();
  const source = useQuery(identitySourceQuery("prod", snapshot.revision));
  const overview = useQuery(deploymentOverviewQuery());
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
  return <div className={"h-full w-full min-w-0 overflow-auto"}><header className={cx(workspaceToolbarClasses, "px-0! [&_p]:m-0 [&_p]:text-label [&_p]:text-graphite")}><div className={cx(pageWidthClasses, "grid gap-2")}><div className={"flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"}><h1 className={"m-0 font-sans text-step1 font-semibold leading-[1.3]"}>DNS / Domains</h1><span className={"inline-flex items-center gap-2 text-label"}>Production domain settings</span></div><p>Source intent, deployed metadata and actual application health have independent evidence.</p></div></header>
    <div className={cx(pageWidthClasses, "pt-4 pb-6 [&>:not(dialog)+:not(dialog)]:mt-3")}>
    {source.error ? <RetryNotice message={source.error.message} retryLabel="Retry source" retrying={source.isFetching} onRetry={() => void source.refetch()} /> : null}
    {source.isFetching && !source.data && !source.error ? <p className={"text-graphite"} role="status">Loading source declaration…</p> : null}
    {source.data && !source.data.exists ? <DocumentCard ><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>{source.data.file} does not exist. Generate it from its own template before staging settings.</p><button className={buttonClasses({ variant: "quiet" })} onClick={() => select("envfile:prod")}>Open environment file</button></DocumentCard> : null}
    <DocumentCard ><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>Read-only deployment inspection</h2>
      {overview.error ? <RetryNotice message={overview.error.message} retryLabel="Retry deployments" retrying={overview.isFetching} onRetry={() => void overview.refetch()} /> : null}
      {overview.isFetching && !overview.data && !overview.error ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"} role="status">Loading deployment context…</p> : null}
      <div className={inspectionControlClasses}>
      <label className={documentLabelClasses}>Profile<TextInput className={"w-full"} aria-label="Identity AWS profile" value={selection.profile} onChange={event => setSelection({ ...selection, profile: event.target.value })} list="identity-profiles" /><datalist id="identity-profiles">{overview.data?.profiles.map(profile => <option key={profile.name}>{profile.name}</option>)}</datalist></label>
      <label className={documentLabelClasses}>Deployment<Select className={"w-full"} aria-label="Identity deployment" value={selection.deployment} onChange={event => { const target = overview.data?.targets.find(target => target.name === event.target.value); setSelection({ ...selection, deployment: event.target.value, region: target?.region ?? selection.region }); }}><option value="">Select a deployment</option>{overview.data?.targets.filter(target => target.mode === "prod").map(target => <option key={target.name} value={target.name}>{target.name} · {target.mode}</option>)}</Select></label>
      <label className={documentLabelClasses}>Region<TextInput className={"w-full"} aria-label="Identity AWS region" value={selection.region} onChange={event => setSelection({ ...selection, region: event.target.value })} /></label>
      <button className={buttonClasses({ variant: "primary" })} disabled={busy || !selection.deployment} onClick={() => void inspect()}>{busy ? "Inspecting…" : "Inspect deployed settings"}</button>
    </div><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"}>Reads verified owned CloudFormation resources using the selected credentials. No users, policies, DNS, certificates or stacks are modified.</p>
      {error ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">{error}</p> : null}{result ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"} role="status">Observed {result.context.observedAt} · account {result.context.account} · {result.context.region} · {result.context.deployment}. Production source intent is shown separately below.</p> : <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Deployed state: unverified. Choose Inspect to read AWS.</p>}
      {result && observedHash !== source.data?.hash ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">Source inputs changed since this observation. Inspect again before comparing source intent with deployed settings.</p> : null}
      {result?.warnings.map(warning => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"} key={warning}>{warning}</p>)}
    </DocumentCard>
    {source.data ? <DomainControls source={source.data} /> : null}<DomainEvidence result={result} /><DomainOperations selection={selection} />
    {draftState.error ? <p className={cx(noticeClasses(), "flex flex-wrap items-center gap-x-3 gap-y-2 [&>span]:min-w-0 [&>span]:flex-[1_1_280px] [&>button]:max-w-full [&>button]:flex-none [&>p]:m-0 [&>p]:basis-full")} role="alert">{draftState.error}</p> : null}{draft.dirty ? <DraftFooter className={"sticky bottom-0 rounded-md border border-rule bg-sheet"} /> : null}
    </div>
  </div>;
}
