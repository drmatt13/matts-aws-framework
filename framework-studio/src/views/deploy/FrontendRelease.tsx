import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { TextInput, Select, Textarea } from "../../ui/FormControls";

import { statePanelClasses, factsClasses } from "./DeployUI";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "../../api";
import type { FrontendReleaseResult, FrontendReleaseReview, FrontendReleaseSettings, FrontendSettingsReview } from "../../../shared/frontend-release";
import type { DeploymentIdentityRequest, DeploymentIdentityReview } from "../../../shared/deployment-identities";

export function FrontendRelease({ deployment, profile, region }: { deployment: string; profile?: string; region?: string }) {
  const settingsQuery = useQuery({ queryKey: ["frontend-release", "settings"], queryFn: () => call<{ settings: FrontendReleaseSettings; hash: string }>("/frontend-release/settings") });
  const historyQuery = useQuery({ queryKey: ["frontend-release", "history"], queryFn: () => call<{ review: FrontendReleaseReview; result: FrontendReleaseResult }[]>("/frontend-release/history") });
  const [settings, setSettings] = useState<FrontendReleaseSettings>();
  const [settingsReview, setSettingsReview] = useState<FrontendSettingsReview>();
  const [review, setReview] = useState<FrontendReleaseReview>();
  const [result, setResult] = useState<FrontendReleaseResult>();
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { if (settingsQuery.data) setSettings(settingsQuery.data.settings); }, [settingsQuery.data]);
  useEffect(() => { setReview(undefined); setResult(undefined); setApproval(""); setMessage(""); setError(""); }, [deployment, profile, region]);
  const work = async (label: string, action: () => Promise<void>) => { setBusy(label); setMessage(""); setError(""); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(""); void historyQuery.refetch(); } };
  const destination = { deployment, profile, region };
  const history = Array.isArray(historyQuery.data) ? historyQuery.data : [];
  const settingsChanged = !!settings && !!settingsQuery.data && JSON.stringify(settings) !== JSON.stringify(settingsQuery.data.settings);
  const update = (patch: Partial<FrontendReleaseSettings>) => { if (settings) { setSettings({ ...settings, ...patch }); setSettingsReview(undefined); } };
  const approvalText = review ? `Publish ${review.destination.deployment} to ${review.destination.bucket}` : "";
  return <details className={cx(statePanelClasses(), "[&>summary]:-my-2 [&>summary]:cursor-pointer [&>summary]:py-2 [&>summary]:font-semibold open:[&>:not(summary)]:mt-3 open:[&>:not(summary)]:mb-0 [&_summary]:cursor-pointer [&_summary]:py-2 [&_summary]:font-semibold [&_details]:min-w-0 [&_details[open]>:not(summary)]:mt-3 [&_details[open]>:not(summary)]:mb-0 [&_section>*+*]:mt-3 [&_section>*+*]:mb-0 [&_pre]:max-h-75 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:bg-paper [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_code]:wrap-anywhere [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1 [&_label]:text-label [&_label:has(input[type=checkbox])]:col-span-full [&_label:has(input[type=checkbox])]:flex [&_label:has(input[type=checkbox])]:items-start [&_label:has(input[type=checkbox])]:gap-2 [&_label>input[type=checkbox]]:mt-0.5 [&_input:not([type=checkbox])]:w-full [&_select]:w-full [&_textarea]:w-full [&_textarea]:min-h-17.5")}><summary>Client environment &amp; frontend release</summary>
    <p>Generate public client settings from this deployment without starting Docker. A release then builds locally, reviews exact files and destination, publishes to S3, and requests CloudFront invalidation.</p>
    <p className={"text-caption text-graphite"}>Selected: <strong>{deployment}</strong> · {profile ?? "Choose an AWS profile"} · {region ?? "Resolve the deployment region first"}. Infrastructure deployment is a separate operation.</p>
    {settingsQuery.error ? <p role="alert">{settingsQuery.error.message}</p> : null}
    {historyQuery.error ? <p role="alert">{historyQuery.error.message}</p> : null}
    {settingsChanged ? <p role="status">Frontend settings have unapplied changes. Review and apply their source before generating client env or building.</p> : null}
    <div className={"flex flex-wrap gap-2"}>
      <button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={!!busy || settingsChanged || !profile || !region} onClick={() => void work("Generating client env…", async () => { const data = await call<{ file: string }>("/frontend-release/environment", destination); setMessage(`Generated ${data.file} from deployed public outputs. No containers were started.`); })}>Generate / refresh client env</button>
      <button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={!!busy || settingsChanged || !profile || !region} onClick={() => void work("Generating env and building…", async () => { setReview(undefined); setResult(undefined); setApproval(""); const data = await call<FrontendReleaseReview>("/frontend-release/build", destination); setReview(data); setMessage("Build complete. Review publication below; no assets have been uploaded."); })}>Build &amp; review release</button>
    </div>
    {settings ? <details><summary>Frontend project and publication settings</summary>
      <p className={"text-caption text-graphite"}>Saved in framework-config/frontend-release.json. Choose an existing package.json script for Vite, Next static export, Astro, or another static frontend. Only its static output is published.</p>
      <div className={"my-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-3"}>
        <label>Project directory<TextInput value={settings.projectDirectory} disabled={!!busy} onChange={event => update({ projectDirectory: event.target.value })} /></label>
        <label>Build script<TextInput value={settings.buildScript} disabled={!!busy} onChange={event => update({ buildScript: event.target.value })} /></label>
        <label>Output directory (inside project)<TextInput value={settings.outputDirectory} disabled={!!busy} onChange={event => update({ outputDirectory: event.target.value })} /></label>
        <label>Build arguments (one per line)<Textarea value={settings.buildArgs.join("\n")} disabled={!!busy} onChange={event => update({ buildArgs: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label>Include globs (one per line)<Textarea value={settings.include.join("\n")} disabled={!!busy} onChange={event => update({ include: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label>Exclude globs (one per line)<Textarea value={settings.exclude.join("\n")} disabled={!!busy} onChange={event => update({ exclude: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label>Bucket prefix (blank or ending in /)<TextInput value={settings.prefix} disabled={!!busy} onChange={event => update({ prefix: event.target.value })} /></label>
        <label>CloudFront invalidation paths (one per line)<Textarea value={settings.invalidationPaths.join("\n")} disabled={!!busy} onChange={event => update({ invalidationPaths: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label><TextInput type="checkbox" checked={settings.deleteRemote} disabled={!!busy} onChange={event => update({ deleteRemote: event.target.checked })} /> Delete remote files absent from build (exact keys require review)</label>
      </div>
      <button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={!!busy || !settingsQuery.data} onClick={() => void work("Reviewing settings…", async () => setSettingsReview(await call<FrontendSettingsReview>("/frontend-release/settings/review", { settings, hash: settingsQuery.data!.hash })))}>Review settings source</button>
      {settingsReview ? <section aria-label="Frontend settings source review"><h4>{settingsReview.file}</h4><p>Before</p><pre>{settingsReview.before}</pre><p>After</p><pre>{settingsReview.after}</pre><button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={!!busy} onClick={() => void work("Saving settings…", async () => { await call("/frontend-release/settings/apply", { id: settingsReview.id }); setSettingsReview(undefined); setReview(undefined); await settingsQuery.refetch(); setMessage("Frontend settings source saved. Build and publication remain separate."); })}>Apply settings source</button></section> : null}
    </details> : null}
    {busy ? <p role="status">{busy}</p> : null}{message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {review ? <section aria-label="Frontend publication review"><h4>Review frontend publication</h4>
      <dl className={factsClasses}><dt>Destination</dt><dd>{review.destination.account} · {review.destination.region} · {review.destination.mode} · s3://{review.destination.bucket}/{review.settings.prefix}</dd><dt>Public env</dt><dd>{review.environmentFile}</dd><dt>CloudFront</dt><dd>{review.destination.distribution}: {review.settings.invalidationPaths.join(", ")}</dd><dt>Expires</dt><dd>{new Date(review.expiresAt).toLocaleTimeString()}</dd></dl>
      {review.warnings.map(warning => <p className={"text-caption"} key={warning}>{warning}</p>)}
      <details><summary>Artifact manifest ({review.files.length} files)</summary><ul>{review.files.map(file => <li key={file.path}><code>{file.path}</code> · {file.bytes} bytes · <code>{file.sha256}</code></li>)}</ul></details>
      {review.deleteKeys.length ? <details><summary>Delete {review.deleteKeys.length} remote objects</summary><pre>{review.deleteKeys.join("\n")}</pre></details> : null}
      <label>Type <code>{approvalText}</code><TextInput aria-label="Frontend publication approval" value={approval} disabled={!!busy || result?.phase === "complete"} onChange={event => setApproval(event.target.value)} autoComplete="off" /></label>
      <button className={buttonClasses({ variant: "quiet", size: "regular", tone: "danger" })} disabled={!!busy || approval !== approvalText || result?.phase === "complete"} onClick={() => void work("Publishing reviewed assets and invalidating CloudFront…", async () => { try { setResult(await call<FrontendReleaseResult>("/frontend-release/publish", { id: review.id, approval })); } finally { setResult(await call<FrontendReleaseResult>(`/frontend-release/results/${review.id}`)); } })}>{result?.phase === "failed" ? "Retry reviewed release" : "Publish assets & request invalidation"}</button>
      {result ? <p role="status">{result.phase}: {result.message} Confirmed uploads: {result.uploaded.length}; deletions: {result.deleted.length}.</p> : null}
    </section> : null}
    {history.some(entry => entry.review.destination.deployment === deployment) ? <details><summary>Recent frontend release outcomes</summary><p className={"text-caption text-graphite"}>Saved results survive Studio restarts. An uploading/deleting/invalidating phase from an earlier process has an uncertain outcome; inspect AWS before creating a new review. Old session reviews cannot be resumed automatically.</p>{history.filter(entry => entry.review.destination.deployment === deployment).map(entry => <p className={"text-caption"} key={entry.review.id}>{entry.review.createdAt} · {entry.result.phase} · {entry.result.message} Confirmed uploads: {entry.result.uploaded.length}; deletions: {entry.result.deleted.length}.</p>)}</details> : null}
  </details>;
}

export function DeploymentIdentities({ account, region, onCreated }: { account?: string; region?: string; onCreated: (name: string) => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["deployment-identities"], queryFn: () => call<{ hash: string; authority: string; targets: { name: string; mode: string }[] }>("/frontend-release/identities") });
  const [input, setInput] = useState<DeploymentIdentityRequest>({ mode: "dev", name: "", account: account ?? "", region: region ?? "us-east-1" });
  const [review, setReview] = useState<DeploymentIdentityReview>(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { setInput(current => ({ ...current, account: current.account || account || "", region: region ?? current.region })); }, [account, region]);
  const change = (patch: Partial<DeploymentIdentityRequest>) => { setInput({ ...input, ...patch }); setReview(undefined); };
  const work = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <details className={cx(statePanelClasses(), "[&>summary]:-my-2 [&>summary]:cursor-pointer [&>summary]:py-2 [&>summary]:font-semibold open:[&>:not(summary)]:mt-3 open:[&>:not(summary)]:mb-0 [&_summary]:cursor-pointer [&_summary]:py-2 [&_summary]:font-semibold [&_details]:min-w-0 [&_details[open]>:not(summary)]:mt-3 [&_details[open]>:not(summary)]:mb-0 [&_section>*+*]:mt-3 [&_section>*+*]:mb-0 [&_pre]:max-h-75 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:bg-paper [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_code]:wrap-anywhere [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1 [&_label]:text-label [&_label:has(input[type=checkbox])]:col-span-full [&_label:has(input[type=checkbox])]:flex [&_label:has(input[type=checkbox])]:items-start [&_label:has(input[type=checkbox])]:gap-2 [&_label>input[type=checkbox]]:mt-0.5 [&_input:not([type=checkbox])]:w-full [&_select]:w-full [&_textarea]:w-full [&_textarea]:min-h-17.5")}><summary>Development &amp; production deployment names</summary>
    <p>{query.data?.authority}</p><p className={"text-caption"}>Existing targets: {query.data?.targets?.map(target => `${target.name} (${target.mode})`).join(", ") || "none"}.</p>
    <p>Create a separate deployment identity below. Applying source does not rename, replace, deploy or adopt existing AWS resources. Prod-mode staging is another named production target.</p>
    <div className={"my-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-3"}>
      <label>Environment<Select value={input.mode} disabled={busy} onChange={event => change({ mode: event.target.value as "dev" | "prod" })}><option value="dev">Development</option><option value="prod">Production / staging</option></Select></label>
      <label>New deployment name<TextInput value={input.name} disabled={busy} placeholder="my-app-dev" onChange={event => change({ name: event.target.value })} /></label>
      <label>Account<TextInput value={input.account} disabled={busy} onChange={event => change({ account: event.target.value })} /></label>
      <label>Region<TextInput value={input.region} disabled={busy} onChange={event => change({ region: event.target.value })} /></label>
    </div>
    <button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={busy || !query.data} onClick={() => void work(async () => setReview(await call<DeploymentIdentityReview>("/frontend-release/identities/review", { identity: input, hash: query.data!.hash })))}>Review new deployment source</button>
    {query.error ? <p role="alert">{query.error.message}</p> : null}{error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    {review ? <section aria-label="Deployment identity source review">{review.warnings.map(warning => <p key={warning}>{warning}</p>)}{review.changes.map(file => <details key={file.file} open><summary>{file.file}</summary><p>Before</p><pre>{file.before}</pre><p>After</p><pre>{file.after}</pre></details>)}
      <button className={buttonClasses({ variant: "quiet", size: "regular" })} disabled={busy} onClick={() => void work(async () => { const result = await call<{ name: string; message: string }>("/frontend-release/identities/apply", { id: review.id }); setMessage(result.message); setReview(undefined); await query.refetch(); await queryClient.invalidateQueries({ queryKey: ["deploy", "overview"] }); onCreated(result.name); })}>Apply new deployment source</button>
    </section> : null}
  </details>;
}
