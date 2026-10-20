import { useState } from "react";
import { Plus, Trash2, ArrowUpRight } from "lucide-react";
import { CLIENT_ENVIRONMENT_ID, clientReferenceId, type ClientEnvironmentBinding, type ClientReferenceOption } from "../../shared/client-environment";
import type { ModelResource } from "../../shared/model";
import { useStudio } from "../studio";
import { Description } from "./Description";
import { EntityIcon } from "./EntityIcon";

function ReferenceSelect({ name, binding, options, disabled, onChange }: {
  name: string; binding: ClientEnvironmentBinding; options: readonly ClientReferenceOption[]; disabled: boolean; onChange: (binding: ClientEnvironmentBinding) => void;
}) {
  const value = clientReferenceId(binding);
  return <select aria-label={`Mapping for ${name}`} value={value} disabled={disabled} onChange={(event) => {
    const next = options.find((option) => option.id === event.target.value)?.binding
      ?? (event.target.value === "endpoint" ? { kind: "endpoint" as const, protocol: "http" as const, port: "LOCAL_API_DEV_SERVER_HOST_PORT" } : { kind: "empty" as const });
    onChange({ ...next, ...(binding.enabled === false ? { enabled: false } : {}), ...(next.kind === "output" && binding.kind === "output" && binding.optional ? { optional: true } : {}) });
  }}>
    <option value="empty">Empty</option><option value="endpoint">URL from CDK port…</option>
    {!["empty", "endpoint"].includes(value) && !options.some((option) => option.id === value) ? <option value={value}>{binding.kind === "input" ? binding.name : binding.kind === "output" ? `${binding.stack}.${binding.outputs[0]}` : value} (unavailable)</option> : null}
    {(["CDK inputs", "Stack outputs", "Stack regions"] as const).map((group) => <optgroup label={group} key={group}>{options.filter((option) => option.group === group).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup>)}
  </select>;
}

function InputSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly ClientReferenceOption[]; onChange: (name: string) => void }) {
  const inputs = options.filter((option) => option.binding.kind === "input");
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {!inputs.some((option) => option.label === value) ? <option value={value}>{value || "Select CDK input"}</option> : null}
    {inputs.map((option) => <option key={option.id} value={option.label}>{option.label}</option>)}
  </select>;
}

/** One row per field; edits participate in the inspector's shared review/apply transaction. */
export function ClientEnvironmentMappings() {
  const { model, mode, select, draft, draftState, live } = useStudio();
  const file = model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("VITE_");
  const [error, setError] = useState("");
  if (!file) return null;
  const mappings = draft.clientMappings();
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || !!file.problem;
  const update = (name: string, binding: ClientEnvironmentBinding) => draft.setClientMappings({ ...mappings, [name]: { ...mappings[name]!, [mode]: binding } });
  const remove = (name: string) => draft.setClientMappings(Object.fromEntries(Object.entries(mappings).filter(([key]) => key !== name)));
  const add = () => {
    if (!/^VITE_[A-Z0-9_]+$/.test(newName)) { setError("Use VITE_ followed by uppercase letters, digits or underscores."); return; }
    if (Object.hasOwn(mappings, newName)) { setError("This field already exists."); return; }
    draft.setClientMappings({ ...mappings, [newName]: { dev: { kind: "empty" }, prod: { kind: "empty" } } });
    setAdding(false); setNewName("VITE_"); setError("");
  };
  return <section className="client-mapping-editor">
    <div className="client-mapping-toolbar"><h3>Fields <span className="muted">{Object.keys(mappings).length}</span></h3><button className="quiet small" disabled={disabled} onClick={() => { setAdding(!adding); setError(""); }}><Plus size={14} aria-hidden />Add field</button></div>
    {adding ? <form className="client-mapping-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <input autoFocus aria-label="New client field name" autoComplete="off" spellCheck={false} value={newName} onChange={(event) => { setNewName(event.target.value); setError(""); }} />
      <button className="primary small" type="submit" disabled={disabled}>Add</button><button className="quiet small" type="button" onClick={() => setAdding(false)}>Cancel</button>
      {error ? <p role="alert" className="reason small">{error}</p> : null}
    </form> : null}
    {file.problem ? <p role="alert" className="reason">{file.problem}</p> : null}
    <ul className="client-environment-mappings">{Object.entries(mappings).map(([name, modes]) => {
      const binding = modes[mode];
      const enabled = binding.enabled !== false;
      const entry = file.entries.find((entry) => entry.name === name);
      const changed = JSON.stringify(binding) !== JSON.stringify(file.mappings[name]?.[mode]);
      return <li key={name} className={enabled ? "" : "mapping-disabled"}>
        <div className="client-mapping-name"><input type="checkbox" aria-label={`Enable ${name}`} checked={enabled} disabled={disabled} onChange={(event) => { const { enabled: _old, ...reference } = binding; update(name, event.target.checked ? reference : { ...reference, enabled: false }); }} /><strong><code>{name}</code></strong>
          {!changed && enabled && entry?.sources[0]?.entity ? <button className="icon-button" aria-label={`Open source for ${name}`} title="Open source" disabled={draft.dirty} onClick={() => select(entry.sources[0]!.entity)}><ArrowUpRight size={13} aria-hidden /></button> : null}
          <button className="icon-button" title="Remove field from both environments" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => remove(name)}><Trash2 size={13} aria-hidden /></button>
        </div>
        <ReferenceSelect name={name} binding={binding} options={file.options} disabled={disabled || !enabled} onChange={(next) => update(name, next)} />
        {enabled && binding.kind === "endpoint" ? <details className="client-mapping-options"><summary>{binding.protocol}://{binding.host ?? "localhost"}:${`{${binding.port}}`}</summary><fieldset disabled={disabled}>
          <div className="client-mapping-url"><select aria-label={`Protocol for ${name}`} value={binding.protocol} onChange={(event) => update(name, { ...binding, protocol: event.target.value as typeof binding.protocol })}>{["http", "https", "ws", "wss"].map((protocol) => <option key={protocol}>{protocol}</option>)}</select><input aria-label={`Hostname for ${name}`} value={binding.host ?? "localhost"} onChange={(event) => update(name, { ...binding, host: event.target.value })} /></div>
          <label className="small">Port<InputSelect label={`Port input for ${name}`} value={binding.port} options={file.options} onChange={(port) => update(name, { ...binding, port })} /></label>
          <label className="client-mapping-check small"><input type="checkbox" aria-label={`Use URL override for ${name}`} checked={binding.override !== undefined} onChange={(event) => { const { override: _old, ...reference } = binding; update(name, event.target.checked ? { ...reference, override: name } : reference); }} />Use URL override</label>
          {binding.override !== undefined ? <InputSelect label={`Override input for ${name}`} value={binding.override} options={file.options} onChange={(override) => update(name, { ...binding, override })} /> : null}
        </fieldset></details> : null}
        {enabled && binding.kind === "output" ? <label className="client-mapping-check small"><input type="checkbox" aria-label={`Allow empty ${name}`} disabled={disabled} checked={!!binding.optional} onChange={(event) => { const { optional: _old, ...reference } = binding; update(name, event.target.checked ? { ...reference, optional: true } : reference); }} />Allow empty when stack is off</label> : null}
        {!changed && enabled && entry?.status === "unavailable" ? <span className="small reason">Source unavailable</span> : null}
      </li>;
    })}</ul>
    {!Object.keys(mappings).length ? <p className="small muted">Add a field to choose its source.</p> : null}
    {draftState.entries.find((entry) => entry.kind === "clientEnvironment")?.error ? <p role="alert" className="small reason">{draftState.entries.find((entry) => entry.kind === "clientEnvironment")!.error}</p> : null}
  </section>;
}

export function ClientEnvironmentFileView({ resource }: { readonly resource: ModelResource }) {
  return <>
    <header><span className="kind">Client environment · {resource.clientEnvironment!.mode === "dev" ? "Development" : "Production"}</span><h2><EntityIcon icon="envFile" />.env</h2><code className="ref">client-app/.env</code></header>
    <ClientEnvironmentMappings />
    <details className="client-mapping-description"><summary>Description</summary><Description entity={resource.id} /></details>
  </>;
}
