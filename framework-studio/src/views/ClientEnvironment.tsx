import { useId, useState } from "react";
import { Plus, Trash2, ArrowUpRight, ChevronRight, Pencil } from "lucide-react";
import { CLIENT_ENVIRONMENT_ID, type ClientEnvironmentBinding, type ClientReferenceOption } from "../../shared/client-environment";
import { previewClientBinding } from "../../shared/client-environment-preview";
import type { ModelResource } from "../../shared/model";
import { useStudio } from "../studio";
import { Description } from "./Description";
import { EntityIcon } from "./EntityIcon";
import { DeploymentSection, DeploymentOwnerControl } from "./Deployment";
import { EnvironmentPills } from "./DeploymentBadge";
import { InspectorSwitch } from "./InspectorUI";

const sourceKinds = { input: "Input parameter", output: "Stack output", region: "Stack region", endpoint: "URL from input parameter", empty: "Empty value" } as const;

function InputSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: readonly ClientReferenceOption[]; disabled?: boolean; onChange: (name: string) => void }) {
  const inputs = options.filter((option) => option.binding.kind === "input");
  return <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>Select input parameter…</option>
    {value && !inputs.some((option) => option.binding.kind === "input" && option.binding.name === value) ? <option value={value}>{value} (undeclared)</option> : null}
    {inputs.map((option) => <option key={option.id} value={option.binding.kind === "input" ? option.binding.name : ""}>{option.label}</option>)}
  </select>;
}

function SourceControls({ name, binding, options, disabled, onChange }: {
  name: string; binding: ClientEnvironmentBinding; options: readonly ClientReferenceOption[]; disabled: boolean; onChange: (binding: ClientEnvironmentBinding) => void;
}) {
  const prefix = useId();
  const stacks = [...new Set(options.flatMap((option) => option.binding.kind === (binding.kind === "output" ? "output" : "region") && "stack" in option.binding ? [option.binding.stack] : []))];
  const outputs = binding.kind === "output" ? options.flatMap((option) => option.binding.kind === "output" && option.binding.stack === binding.stack ? [...option.binding.outputs] : []) : [];
  return <fieldset className="client-mapping-controls" disabled={disabled}>
    <label>Value from<select aria-label={`Source type for ${name}`} value={binding.kind} onChange={(event) => {
      const kind = event.target.value as ClientEnvironmentBinding["kind"];
      if (kind === binding.kind) return;
      const next: ClientEnvironmentBinding = kind === "input" ? { kind, name: options.some((option) => option.id === `input:${name}`) ? name : "" }
        : kind === "output" ? { kind, stack: "", outputs: [] } : kind === "region" ? { kind, stack: "" }
        : kind === "endpoint" ? { kind, protocol: "http", port: "" } : { kind: "empty" };
      onChange({ ...next, ...(binding.when ? { when: binding.when } : {}) });
    }}>{Object.entries(sourceKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
    {binding.kind === "input" ? <label>Input parameter<InputSelect label={`Mapping for ${name}`} value={binding.name} options={options} onChange={(input) => onChange({ ...binding, name: input })} /></label> : null}
    {binding.kind === "region" || binding.kind === "output" ? <label>Stack<select aria-label={`Stack for ${name}`} value={binding.stack} onChange={(event) => onChange(binding.kind === "region" ? { ...binding, stack: event.target.value } : { ...binding, stack: event.target.value, outputs: [] })}>
      <option value="" disabled>Select stack…</option>
      {binding.stack && !stacks.includes(binding.stack) ? <option value={binding.stack}>{binding.stack} (unavailable)</option> : null}
      {stacks.map((stack) => <option key={stack}>{stack}</option>)}
    </select></label> : null}
    {binding.kind === "output" ? <>
      <label>Public output<select aria-label={`Mapping for ${name}`} value={binding.outputs[0] ?? ""} disabled={!binding.stack} onChange={(event) => onChange({ ...binding, outputs: [event.target.value] })}>
        <option value="" disabled>Select output…</option>
        {binding.outputs[0] && !outputs.includes(binding.outputs[0]) ? <option value={binding.outputs[0]}>{binding.outputs[0]} (unavailable)</option> : null}
        {outputs.map((output) => <option key={output}>{output}</option>)}
      </select></label>
      {binding.outputs.length > 1 ? <p className="small muted">Fallback outputs: <code>{binding.outputs.slice(1).join(", ")}</code>. Selecting another output replaces this list.</p> : null}
      <div className="setting-switch"><label htmlFor={`${prefix}-optional`}>Allow empty when stack is off</label><InspectorSwitch id={`${prefix}-optional`} label={`Allow empty ${name}`} checked={!!binding.optional} onChange={checked => { const { optional: _old, ...reference } = binding; onChange(checked ? { ...reference, optional: true } : reference); }} /></div>
    </> : null}
    {binding.kind === "endpoint" ? <>
      <div className="client-mapping-url"><label>Protocol<select aria-label={`Protocol for ${name}`} value={binding.protocol} onChange={(event) => onChange({ ...binding, protocol: event.target.value as typeof binding.protocol })}>{["http", "https", "ws", "wss"].map((protocol) => <option key={protocol}>{protocol}</option>)}</select></label><label>Hostname<input aria-label={`Hostname for ${name}`} value={binding.host ?? "localhost"} onChange={(event) => onChange({ ...binding, host: event.target.value })} /></label></div>
      <label>Port input parameter<InputSelect label={`Port input for ${name}`} value={binding.port} options={options} onChange={(port) => onChange({ ...binding, port })} /></label>
      <div className="setting-switch"><label htmlFor={`${prefix}-override`}>Use a URL override when set</label><InspectorSwitch id={`${prefix}-override`} label={`Use URL override for ${name}`} checked={binding.override !== undefined} onChange={checked => { const { override: _old, ...reference } = binding; onChange(checked ? { ...reference, override: name } : reference); }} /></div>
      <InputSelect label={`Override input for ${name}`} value={binding.override ?? name} options={options} disabled={binding.override === undefined} onChange={(override) => onChange({ ...binding, override })} />
      <p className="small muted">The override takes priority. When empty, the URL uses the hostname and port above.</p>
    </> : null}
    <div className="setting-switch"><label htmlFor={`${prefix}-when`}>Use an input condition</label><InspectorSwitch id={`${prefix}-when`} label={`Use input condition for ${name}`} checked={!!binding.when} onChange={checked => {
      const { when: _old, ...reference } = binding;
      onChange(checked ? { ...reference, when: { input: "", equals: "true" } } : reference);
    }} /></div>
    {binding.when ? <>
      <label>Condition input parameter<InputSelect label={`Condition input for ${name}`} value={binding.when.input} options={options} onChange={input => onChange({ ...binding, when: { ...binding.when!, input } })} /></label>
      <label>Equals<input aria-label={`Condition value for ${name}`} value={binding.when.equals} onChange={event => onChange({ ...binding, when: { ...binding.when!, equals: event.target.value } })} /></label>
      <p className="small muted">Write an empty value when the input does not match in the selected environment.</p>
    </> : null}
  </fieldset>;
}

/** Compact source overview; each editor participates in the shared review/apply transaction. */
export function ClientEnvironmentMappings() {
  const { model, mode, setMode, select, draft, draftState, live } = useStudio();
  const file = model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("VITE_");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rename, setRename] = useState<{ name: string; value: string; error: string }>();
  const [error, setError] = useState("");
  if (!file) return null;
  const mappings = draft.clientMappings();
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || !!file.problem;
  const update = (name: string, binding: ClientEnvironmentBinding) => draft.setClientMappings({ ...mappings, [name]: { ...mappings[name]!, [mode]: binding } });
  const remove = (name: string) => draft.setClientMappings(Object.fromEntries(Object.entries(mappings).filter(([key]) => key !== name)));
  const renameField = () => {
    if (!rename) return;
    const name = rename.value.trim();
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) { setRename({ ...rename, error: "Use VITE_ followed by uppercase letters, digits or underscores." }); return; }
    if (name !== rename.name && Object.hasOwn(mappings, name)) { setRename({ ...rename, error: "This field already exists." }); return; }
    draft.setClientMappings(Object.fromEntries(Object.entries(mappings).map(([key, value]) => [key === rename.name ? name : key, value])));
    if (expanded === rename.name) setExpanded(name);
    setFilter("");
    setRename(undefined);
  };
  const add = () => {
    const name = newName.trim();
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) { setError("Use VITE_ followed by uppercase letters, digits or underscores."); return; }
    if (Object.hasOwn(mappings, name)) { setError("This field already exists. Search for it below."); return; }
    draft.setClientMappings({ ...mappings, [name]: { dev: { kind: "empty" }, prod: { kind: "empty" } } });
    setExpanded(name); setFilter(""); setAdding(false); setNewName("VITE_"); setError("");
  };
  const rows = Object.entries(mappings).map(([name, modes]) => {
    const binding = modes[mode];
    const preview = previewClientBinding(name, binding, model);
    const reference = binding.enabled === false ? previewClientBinding(name, { ...binding, enabled: true }, model) : preview;
    return { name, binding, preview, reference };
  });
  const matches = rows.filter(({ name, binding, reference }) => `${name} ${sourceKinds[binding.kind]} ${reference.expression} ${reference.sources.map((source) => source.label).join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const editError = draftState.entries.find((entry) => entry.kind === "clientEnvironment")?.error;
  return <section className="client-mapping-editor">
    <div className="client-mapping-context">
      <span className="segmented" role="group" aria-label="Client mapping environment">{(["dev", "prod"] as const).map((candidate) => <button key={candidate} aria-pressed={mode === candidate} onClick={() => setMode(candidate)}>{candidate === "dev" ? "Development" : "Production"}</button>)}</span>
      <p className="small muted">Edit sources for {mode === "dev" ? "Development" : "Production"}. Each field's Dev / Prod pills choose which environments generate it. Empty values stay in the file; dimmed pills omit the field.</p>
      <details className="client-mapping-help"><summary>How mappings and files work</summary>
        <p>Input parameters resolve this environment's values and defaults from <button className="linkish" disabled={draft.dirty} onClick={() => select(`envfile:${mode}`)}>{file.inputs}</button>. Client mappings read those parameters. Stack outputs and regions refer to this environment's deployment.</p>
        <p>Review and apply saves references in <code>framework-config/client-environment.ts</code>. This editor does not generate client files or load deployed values.</p>
        <p>The next environment export uses these saved mappings and writes <code>client-app/.env.{mode === "dev" ? "development" : "production"}.local</code>, which Vite reads over <code>client-app/.env</code>. Renaming a field changes its exported name in both environments; update any application code that reads its old name.</p>
        <p>Client settings are public in the browser. Secret inputs are excluded.</p>
      </details>
    </div>
    <div className="client-mapping-toolbar"><h3>Fields <span className="muted">{filter ? `${matches.length} / ` : ""}{rows.length}</span></h3><button className="quiet small" disabled={disabled} onClick={() => { setAdding(!adding); setError(""); }}><Plus size={14} aria-hidden />Add field</button></div>
    {adding ? <form className="client-mapping-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <input autoFocus aria-label="New client field name" autoComplete="off" spellCheck={false} value={newName} onChange={(event) => { setNewName(event.target.value); setError(""); }} />
      <button className="primary small" type="submit" disabled={disabled}>Add</button><button className="quiet small" type="button" onClick={() => setAdding(false)}>Cancel</button>
      <p className="small muted">Added to both environments with an empty value. Configure each environment independently.</p>
      {error ? <p role="alert" className="reason small">{error}</p> : null}
    </form> : null}
    <input type="search" className="client-mapping-search" aria-label="Search client mappings" placeholder="Find a field or source…" value={filter} onChange={(event) => setFilter(event.target.value)} />
    {file.problem ? <p role="alert" className="reason">{file.problem}</p> : null}
    <ul className="client-environment-mappings">{matches.map(({ name, binding, preview, reference }) => {
      const enabled = binding.enabled !== false;
      const saved = file.mappings[name];
      const changed = JSON.stringify(mappings[name]) !== JSON.stringify(saved);
      const open = expanded === name;
      const status = preview.status === "mapped" ? (binding.kind === "output" || binding.kind === "region" ? "Reference" : "Available") : preview.status === "unavailable" ? "Needs attention" : preview.status === "disabled" ? "Omitted" : "Empty";
      return <li key={name} className={enabled ? "" : "mapping-disabled"}>
        <div className="client-mapping-name"><strong><code>{name}</code></strong>
          <EnvironmentPills label={`Generate ${name}`} availability={{ dev: mappings[name]!.dev.enabled !== false, prod: mappings[name]!.prod.enabled !== false }} disabled={disabled} onToggle={(candidate) => {
            const current = mappings[name]![candidate];
            const { enabled: _old, ...reference } = current;
            draft.setClientMappings({ ...mappings, [name]: { ...mappings[name]!, [candidate]: current.enabled === false ? reference : { ...reference, enabled: false } } });
          }} />
          <button className="icon-button" title="Rename field in both environments" aria-label={`Rename ${name}`} disabled={disabled} onClick={() => setRename({ name, value: name, error: "" })}><Pencil size={14} aria-hidden /></button>
          <button className="icon-button" title="Remove field from both environments" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => remove(name)}><Trash2 size={14} aria-hidden /></button>
        </div>
        {rename?.name === name ? <form className="client-mapping-rename" onSubmit={(event) => { event.preventDefault(); renameField(); }}>
          <input autoFocus aria-label={`New name for ${name}`} autoComplete="off" spellCheck={false} value={rename.value} onChange={(event) => setRename({ ...rename, value: event.target.value, error: "" })} />
          <div className="client-mapping-actions"><span className="small muted">Renames in both environments.</span><button className="quiet small" type="button" onClick={() => setRename(undefined)}>Cancel rename</button><button className="primary small" type="submit" disabled={disabled}>Save name</button></div>
          {rename.error ? <p role="alert" className="small reason">{rename.error}</p> : null}
        </form> : null}
        <button className="client-mapping-summary" aria-label={`Edit mapping for ${name}`} aria-expanded={open} aria-controls={`mapping-${name}`} onClick={() => setExpanded(open ? null : name)}>
          <span className="client-mapping-summary-heading"><span>{sourceKinds[binding.kind]}</span><span className={preview.status === "unavailable" ? "reason" : "muted"}>{changed ? "Edited · " : ""}{status}</span><ChevronRight size={14} aria-hidden /></span>
          <code>{reference.expression}</code>
        </button>
        {open ? <div id={`mapping-${name}`} className="client-mapping-detail">
          <SourceControls name={name} binding={binding} options={file.options} disabled={disabled || !enabled} onChange={(next) => update(name, { ...next, ...(binding.enabled === false ? { enabled: false } : {}) })} />
          <p className={`client-mapping-note small ${preview.status === "unavailable" ? "reason" : "muted"}`} role="status">{preview.note}</p>
          <div className="client-mapping-actions">
            {preview.sources[0]?.entity ? <button className="quiet small" aria-label={`Open source for ${name}`} title={draft.dirty ? "Apply or discard changes before opening the source" : preview.sources[0].label} disabled={draft.dirty || !enabled} onClick={() => select(preview.sources[0]!.entity)}><ArrowUpRight size={14} aria-hidden />Open source</button> : null}
            <button className="quiet small" aria-label={`Reset mapping for ${name}`} disabled={disabled || !changed || !saved} onClick={() => { if (saved) draft.setClientMappings({ ...mappings, [name]: saved }); }}>Reset mapping</button>
          </div>
        </div> : null}
      </li>;
    })}</ul>
    {!matches.length ? <p className="small muted">{rows.length ? "No matching fields or sources." : "Add a field to choose its source."}</p> : null}
    {editError ? <p role="alert" className="small reason">{editError}</p> : null}
  </section>;
}

export function ClientEnvironmentFileView({ resource }: { readonly resource: ModelResource }) {
  return <>
    <header><span className="kind">Client environment</span><h2><EntityIcon icon="envFile" />.env</h2><code className="ref">client-app/.env</code></header>
    <DeploymentSection availability={{ dev: true, prod: true }} catalog><DeploymentOwnerControl reason="These mappings supply the client build; the file has no independent deployment flag. Configure the resources supplying each mapping and publish the client separately." owners={[{ id: "island:stacks", title: "owning stacks" }]} /></DeploymentSection>
    <ClientEnvironmentMappings />
    <Description entity={resource.id} />
  </>;
}
