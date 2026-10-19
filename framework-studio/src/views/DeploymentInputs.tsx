import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelResource, SourceLocation } from "../../shared/model";
import { api } from "../api";
import { editorLink, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import type { DeploymentInputDetails } from "../../shared/deployment-inputs";
import type { EnvironmentEdit } from "../draft";
import { RequirementNotice } from "./InputRequirement";
import { Description } from "./Description";

function ValueControl({ name, value, sensitive, disabled, onChange }: { name: string; value: string; sensitive: boolean; disabled: boolean; onChange: (value: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  return <div className="env-value-control">{sensitive && !revealed
    ? <input aria-label={`Value for ${name}`} type="password" autoComplete="off" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
    : <textarea aria-label={`Value for ${name}`} rows={value.includes("\n") ? 4 : 1} autoComplete="off" spellCheck={false} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />}
    {sensitive ? <button className="linkish small" aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`} aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Reveal"}</button> : null}</div>;
}

export function InputSources({ resource }: { resource: ModelResource }) {
  const { select, snapshot } = useStudio();
  if (!resource.inputSources?.length) return null;
  return <section><h3>Environment file sources</h3><p className="small muted">Names and presence only. Open a file inspector to edit its local values.</p>
    {resource.inputSources.map(({ file, entry }) => <p className="small" key={file}>
      <button className="linkish" onClick={() => select(file.endsWith(".dev") ? "envfile:dev" : "envfile:prod")}>{file}</button> · {entry.status}{entry.defaulted ? " · declaration default applies" : ""}
      {entry.sensitive ? " · sensitive value hidden" : ""}
      {entry.source ? <> · <a href={editorLink(snapshot.repositoryRoot, entry.source)}>Open assignment</a></> : null}
    </p>)}
  </section>;
}

export function EnvironmentFileView({ resource }: { resource: ModelResource }) {
  const { snapshot, mode, select, index, draft, draftState, live } = useStudio();
  const file = resource.deploymentFile!;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<DeploymentInputDetails>();
  const [filter, setFilter] = useState("");
  const pending = draft.environment(file.mode);
  const edits = pending?.edits ?? [];
  const descriptionPending = draftState.entries.some((entry) => entry.kind === "description");
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || !details || descriptionPending;
  const requirements = file.entries.flatMap((entry) => entry.requirements ?? []).filter((item) => item.required);
  useEffect(() => {
    if (draft.dirty) return;
    const controller = new AbortController();
    setDetails(undefined); setError("");
    if (file.exists) void api.inputDetails(file.mode, controller.signal).then((value) => { if (!controller.signal.aborted) setDetails(value); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not read the inputs file."); });
    return () => controller.abort();
  }, [file.mode, file.exists, snapshot.revision, draft, draft.dirty]);
  const update = (next: readonly EnvironmentEdit[]) => { if (details) draft.setEnvironment(file.mode, pending?.hash ?? details.hash, next, details.entries.map((entry) => entry.name)); };
  const change = (key: string, fields: Partial<EnvironmentEdit>) => update(edits.map((edit) => edit.key === key ? { ...edit, ...fields } : edit));
  const add = (name = "") => { setFilter(""); update([...edits, { key: `new:${crypto.randomUUID()}`, name, value: "", create: true }]); };
  const location = (name: string): SourceLocation => ({ file: name, line: 1, column: 1, start: 0, end: 0 });
  const create = async () => {
    setBusy(true); setError("");
    try { await api.createDeploymentInput(file.mode); await client.invalidateQueries({ queryKey: ["snapshot"] }); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not generate the inputs file."); }
    finally { setBusy(false); }
  };
  return <>
    <header><span className="kind">CDK {file.mode === "dev" ? "development" : "production"} inputs</span><h2><EntityIcon icon="envFile" />{resource.path[0]}</h2><code className="ref">{file.path}</code></header>
    <Description entity={resource.id} />
    {descriptionPending ? <p className="small muted">Apply or discard the description before editing environment variables.</p> : null}
    <section><h3>Source</h3><p>{file.exists ? "Local inputs file exists." : "This inputs file has not been generated."} {file.mode === mode ? "Used for synthesis in the selected graph." : "Switch the graph to use this environment for synthesis."}</p>
      {file.exists ? <p><a href={editorLink(snapshot.repositoryRoot, location(file.path))}>Open file in editor</a></p> : <button className="button" disabled={busy || draft.dirty} onClick={() => void create()}>{busy ? "Generating…" : `Generate .env.${file.mode} from template`}</button>}
      <p className="small"><a href={editorLink(snapshot.repositoryRoot, location(file.template))}>Template: {file.template}</a></p>
      <p className="small muted">Edit local values below, then review and apply the complete draft. Values stay outside the graph; sensitive fields are masked. Production is never populated from development inputs.</p>
      {file.problem || error ? <p role="alert">{file.problem || error}</p> : null}
    </section>
    {requirements.length ? <section><h3>Required inputs ({requirements.length})</h3><p className="small muted">Required values must be non-blank or supplied by a parameter default. Secret values belong only in the environment file.</p>
      {requirements.map((requirement) => <div key={requirement.resource}>
        <RequirementNotice requirement={requirement} />
        {requirement.status === "missing" && file.exists ? <button className="linkish small" disabled={disabled || edits.some((edit) => edit.create && edit.name === requirement.name)} onClick={() => { if (details?.entries.some((entry) => entry.name === requirement.name)) setFilter(requirement.name); else add(requirement.name); }}>Set {requirement.name}</button> : null}
        <button className="linkish small" onClick={() => select(requirement.resource)}>Open {requirement.name} settings</button>
      </div>)}
    </section> : null}
    {file.exists ? <section className="environment-editor"><h3>Environment variables{details ? ` (${details.entries.length + edits.filter((edit) => edit.create).length})` : ""}</h3>
      <button className="quiet" disabled={disabled} onClick={() => add()}>Add environment variable</button>
      <label className="resource-control"><span className="sr-only">Filter environment variables</span><input type="search" aria-label="Filter environment variables" placeholder="Find a variable…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      {!details && !error ? <p role="status" className="small muted">Reading this local environment file…</p> : null}
      {pending?.error ? <p role="alert" className="reason">{pending.error}</p> : null}
      <ul className="input-file-entries">
        {edits.filter((edit) => edit.create).map((edit, at) => <li key={edit.key}>
          <label className="resource-control"><span>New variable name</span><input autoFocus={at === edits.filter((item) => item.create).length - 1} aria-label={`New variable name ${at + 1}`} disabled={disabled} autoComplete="off" spellCheck={false} value={edit.name} placeholder="VARIABLE_NAME" onChange={(event) => change(edit.key, { name: event.target.value })} /></label>
          <ValueControl name={edit.name || `new variable ${at + 1}`} value={edit.value} sensitive={true} disabled={disabled} onChange={(value) => change(edit.key, { value })} />
          {requirements.some((item) => item.name === edit.name) ? <p className="small reason">Required{!edit.value.trim() ? " · A blank value will not satisfy this requirement." : " · This value is staged until you review and apply."}</p> : null}
          <button className="linkish small" disabled={!!draftState.busy} onClick={() => update(edits.filter((item) => item.key !== edit.key))}>Remove new variable</button>
        </li>)}
        {details?.entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())).map((entry) => {
          const edit = edits.find((item) => !item.create && item.name === entry.name);
          const metadata = file.entries.find((item) => item.name === entry.name);
          return <li key={entry.name}>
            <code>{entry.name}</code><span className="small muted">{edit ? "Modified · " : ""}{metadata?.status ?? "configured"}{metadata?.defaulted ? " · declaration default applies" : ""}{entry.sensitive ? " · sensitive" : ""}</span>
            {metadata?.requirements?.some((item) => item.required) ? <p className="small reason">Required{!(edit?.value ?? entry.value).trim() && !metadata.defaulted ? " · A blank value will not satisfy this requirement." : ""}</p> : null}
            <ValueControl name={entry.name} value={edit?.value ?? entry.value} sensitive={entry.sensitive} disabled={disabled || entry.name === "PROD_DEPLOYMENT"} onChange={(value) => update([...edits.filter((item) => item.key !== entry.name), { key: entry.name, name: entry.name, value, original: entry.value }])} />
            {entry.name === "PROD_DEPLOYMENT" ? <span className="small muted">Determined by this file's environment.</span> : null}
            <span>{metadata?.targets.map((id) => <button key={id} className="linkish small" onClick={() => select(id)}>{titleOf(index, id)}</button>)}</span>
          </li>;
        })}
      </ul>
      {details && !details.entries.some((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())) && filter ? <p className="small muted">No variables match this search.</p> : null}
      {details && file.entries.some((entry) => entry.status === "missing") ? <details><summary>Not set in this file</summary><ul className="input-file-entries">{file.entries.filter((entry) => entry.status === "missing").map((entry) => <li key={entry.name}><code>{entry.name}</code><span className="small muted">Referenced by the example or resource catalog.</span><button className="linkish small" disabled={disabled || edits.some((edit) => edit.name === entry.name)} onClick={() => add(entry.name)}>Add {entry.name}</button></li>)}</ul></details> : null}
    </section> : null}
  </>;
}
