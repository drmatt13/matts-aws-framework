import { InspectorSummary } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { useId, useState } from "react";
import { Plus, Trash2, ArrowUpRight, ChevronRight, Pencil } from "lucide-react";
import { CLIENT_ENVIRONMENT_FILES, CLIENT_ENVIRONMENT_ID, clientBindingFor, isSplitMapping, type ClientEnvironmentBinding, type ClientEnvironmentMapping, type ClientReferenceOption } from "../../shared/client-environment";
import { previewClientBinding } from "../../shared/client-environment-preview";
import type { ModelResource } from "../../shared/model";
import { useStudio } from "../studio";
import { Description } from "./Description";
import { EntityIcon } from "./EntityIcon";
import { EnvironmentPills } from "./DeploymentBadge";
import { InspectorSwitch } from "./InspectorUI";

const sourceKinds = { input: "Input parameter", output: "Stack output", region: "Stack region", endpoint: "URL from input parameter", empty: "Empty value" } as const;

function InputSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: readonly ClientReferenceOption[]; disabled?: boolean; onChange: (name: string) => void }) {
  const inputs = options.filter((option) => option.binding.kind === "input");
  return <Select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>Select input parameter…</option>
    {value && !inputs.some((option) => option.binding.kind === "input" && option.binding.name === value) ? <option value={value}>{value} (undeclared)</option> : null}
    {inputs.map((option) => <option key={option.id} value={option.binding.kind === "input" ? option.binding.name : ""}>{option.label}</option>)}
  </Select>;
}

function SourceControls({ name, binding, options, disabled, onChange }: {
  name: string; binding: ClientEnvironmentBinding; options: readonly ClientReferenceOption[]; disabled: boolean; onChange: (binding: ClientEnvironmentBinding) => void;
}) {
  const prefix = useId();
  const stacks = [...new Set(options.flatMap((option) => option.binding.kind === (binding.kind === "output" ? "output" : "region") && "stack" in option.binding ? [option.binding.stack] : []))];
  const outputs = binding.kind === "output" ? options.flatMap((option) => option.binding.kind === "output" && option.binding.stack === binding.stack ? [...option.binding.outputs] : []) : [];
  return <fieldset className={"[&_p]:m-0 grid gap-3 [border:0] p-0 m-0 min-w-0 [&_label]:grid [&_label]:gap-1 [&_label]:text-caption [&_label]:min-w-0 [&_label>code]:wrap-anywhere"} disabled={disabled} data-slot="client-mapping-controls">
    <label>Value from<Select aria-label={`Source type for ${name}`} value={binding.kind} onChange={(event) => {
      const kind = event.target.value as ClientEnvironmentBinding["kind"];
      if (kind === binding.kind) return;
      const next: ClientEnvironmentBinding = kind === "input" ? { kind, name: options.some((option) => option.id === `input:${name}`) ? name : "" }
        : kind === "output" ? { kind, stack: "", outputs: [] } : kind === "region" ? { kind, stack: "" }
        : kind === "endpoint" ? { kind, protocol: "http", port: "" } : { kind: "empty" };
      onChange({ ...next, ...(binding.when ? { when: binding.when } : {}) });
    }}>{Object.entries(sourceKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</Select></label>
    {binding.kind === "input" ? <label>Input parameter<InputSelect label={`Mapping for ${name}`} value={binding.name} options={options} onChange={(input) => onChange({ ...binding, name: input })} /></label> : null}
    {binding.kind === "region" || binding.kind === "output" ? <label>Stack<Select aria-label={`Stack for ${name}`} value={binding.stack} onChange={(event) => onChange(binding.kind === "region" ? { ...binding, stack: event.target.value } : { ...binding, stack: event.target.value, outputs: [] })}>
      <option value="" disabled>Select stack…</option>
      {binding.stack && !stacks.includes(binding.stack) ? <option value={binding.stack}>{binding.stack} (unavailable)</option> : null}
      {stacks.map((stack) => <option key={stack}>{stack}</option>)}
    </Select></label> : null}
    {binding.kind === "output" ? <>
      <label>Public output<Select aria-label={`Mapping for ${name}`} value={binding.outputs[0] ?? ""} disabled={!binding.stack} onChange={(event) => onChange({ ...binding, outputs: [event.target.value] })}>
        <option value="" disabled>Select output…</option>
        {binding.outputs[0] && !outputs.includes(binding.outputs[0]) ? <option value={binding.outputs[0]}>{binding.outputs[0]} (unavailable)</option> : null}
        {outputs.map((output) => <option key={output}>{output}</option>)}
      </Select></label>
      {binding.outputs.length > 1 ? <p className={"text-caption text-graphite"}>Fallback outputs: <code>{binding.outputs.slice(1).join(", ")}</code>. Selecting another output replaces this list.</p> : null}
      <div className={"flex min-w-0 items-center justify-between gap-3 text-label font-medium [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere"} data-slot="setting-switch"><label htmlFor={`${prefix}-optional`}>Allow empty when stack is off</label><InspectorSwitch id={`${prefix}-optional`} label={`Allow empty ${name}`} checked={!!binding.optional} onChange={checked => { const { optional: _old, ...reference } = binding; onChange(checked ? { ...reference, optional: true } : reference); }} /></div>
    </> : null}
    {binding.kind === "endpoint" ? <>
      <div className={"grid grid-cols-[100px_minmax(0,1fr)] gap-2 inspector-420:grid-cols-[minmax(0,1fr)]"} data-slot="client-mapping-url"><label>Protocol<Select aria-label={`Protocol for ${name}`} value={binding.protocol} onChange={(event) => onChange({ ...binding, protocol: event.target.value as typeof binding.protocol })}>{["http", "https", "ws", "wss"].map((protocol) => <option key={protocol}>{protocol}</option>)}</Select></label><label>Hostname<TextInput aria-label={`Hostname for ${name}`} value={binding.host ?? "localhost"} onChange={(event) => onChange({ ...binding, host: event.target.value })} /></label></div>
      <label>Port input parameter<InputSelect label={`Port input for ${name}`} value={binding.port} options={options} onChange={(port) => onChange({ ...binding, port })} /></label>
      <div className={"flex min-w-0 items-center justify-between gap-3 text-label font-medium [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere"} data-slot="setting-switch"><label htmlFor={`${prefix}-override`}>Use a URL override when set</label><InspectorSwitch id={`${prefix}-override`} label={`Use URL override for ${name}`} checked={binding.override !== undefined} onChange={checked => { const { override: _old, ...reference } = binding; onChange(checked ? { ...reference, override: name } : reference); }} /></div>
      <InputSelect label={`Override input for ${name}`} value={binding.override ?? name} options={options} disabled={binding.override === undefined} onChange={(override) => onChange({ ...binding, override })} />
      <p className={"text-caption text-graphite"}>The override takes priority. When empty, the URL uses the hostname and port above.</p>
    </> : null}
    <div className={"flex min-w-0 items-center justify-between gap-3 text-label font-medium [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere"} data-slot="setting-switch"><label htmlFor={`${prefix}-when`}>Use an input condition</label><InspectorSwitch id={`${prefix}-when`} label={`Use input condition for ${name}`} checked={!!binding.when} onChange={checked => {
      const { when: _old, ...reference } = binding;
      onChange(checked ? { ...reference, when: { input: "", equals: "true" } } : reference);
    }} /></div>
    {binding.when ? <>
      <label>Condition input parameter<InputSelect label={`Condition input for ${name}`} value={binding.when.input} options={options} onChange={input => onChange({ ...binding, when: { ...binding.when!, input } })} /></label>
      <label>Equals<TextInput aria-label={`Condition value for ${name}`} value={binding.when.equals} onChange={event => onChange({ ...binding, when: { ...binding.when!, equals: event.target.value } })} /></label>
      <p className={"text-caption text-graphite"}>Written blank in an environment where the input does not match.</p>
    </> : null}
  </fieldset>;
}

const MODE_LABELS = { dev: "Development", prod: "Production" } as const;

/**
 * Compact source overview; each editor participates in the shared review/apply transaction.
 *
 * Where a field is generated is not a setting. Each environment previews the field's own recipe,
 * and the Dev / Prod pills report the result: an input outside that environment, or an optional
 * one with no value and no default, leaves the field blank there.
 */
export function ClientEnvironmentMappings() {
  const { model, snapshot, select, draft, draftState, live } = useStudio();
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
  const update = (name: string, mapping: ClientEnvironmentMapping) => draft.setClientMappings({ ...mappings, [name]: mapping });
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
    draft.setClientMappings({ ...mappings, [name]: { kind: "empty" } });
    setExpanded(name); setFilter(""); setAdding(false); setNewName("VITE_"); setError("");
  };
  const rows = Object.entries(mappings).map(([name, mapping]) => {
    const previews = { dev: previewClientBinding(name, clientBindingFor(mapping, "dev"), snapshot.models.dev), prod: previewClientBinding(name, clientBindingFor(mapping, "prod"), snapshot.models.prod) };
    return { name, mapping, previews, split: isSplitMapping(mapping) };
  });
  const searchText = ({ name, mapping, previews }: (typeof rows)[number]) => [name, ...(["dev", "prod"] as const).flatMap((mode) => [sourceKinds[clientBindingFor(mapping, mode).kind], previews[mode].expression, ...previews[mode].sources.map((source) => source.label)])].join(" ");
  const matches = rows.filter((row) => searchText(row).toLowerCase().includes(filter.trim().toLowerCase()));
  const editError = draftState.entries.find((entry) => entry.kind === "clientEnvironment")?.error;
  return <section className={"[&_select]:w-full [&_input:not([type=checkbox])]:w-full"} data-slot="client-mapping-editor">
    <div className={"grid gap-2 mb-(--panel-padding) [&_p]:m-0"} data-slot="client-mapping-context">
      <p className={"text-caption text-graphite"}>Dev / Prod shows where each field gets a value. It follows the field's sources: an input that is not declared in an environment, or has no value and no default there, leaves the field blank.</p>
      <details className={"text-graphite text-caption [&_summary]:cursor-pointer [&_p]:mt-2 [&_p]:wrap-anywhere"} data-slot="client-mapping-help"><InspectorSummary>How mappings and files work</InspectorSummary>
        <p>Input parameters read each environment's values and defaults from <button className={buttonClasses({ variant: "link" })} disabled={draft.dirty} onClick={() => select("envfile:dev")}>cdk-app/.env.dev</button> and <button className={buttonClasses({ variant: "link" })} disabled={draft.dirty} onClick={() => select("envfile:prod")}>cdk-app/.env.prod</button>. Stack outputs and regions refer to that environment's deployment.</p>
        <p>One source serves both environments unless a field's sources differ. Review and apply saves references in <code>framework-config/client-environment.ts</code>. This editor does not generate client files or load deployed values.</p>
        <p>An environment export writes <code>client-app/.env.development.local</code> or <code>client-app/.env.production.local</code>, which Vite reads over <code>client-app/.env</code>. A blank field is written blank, so nothing from <code>client-app/.env</code> shows through. Renaming a field changes its exported name in both; update any application code that reads its old name.</p>
        <p>Client settings are public in the browser. Secret inputs are excluded.</p>
      </details>
    </div>
    <div className={"flex items-center justify-between gap-2 [&_h3]:m-0 [&_button]:inline-flex [&_button]:items-center [&_button]:gap-1"} data-slot="client-mapping-toolbar"><h3>Fields <span className={"text-graphite"}>{filter ? `${matches.length} / ` : ""}{rows.length}</span></h3><button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} disabled={disabled} onClick={() => { setAdding(!adding); setError(""); }}><Plus size={14} aria-hidden />Add field</button></div>
    {adding ? <form className={"m-[10px_0] grid grid-cols-[minmax(0,1fr)_auto_auto] [gap:6px] [&_p]:col-span-full [&_p]:m-0 inspector-420:grid-cols-2 inspector-420:[&>input]:col-span-full"} onSubmit={(event) => { event.preventDefault(); add(); }} data-slot="client-mapping-add">
      <TextInput autoFocus aria-label="New client field name" autoComplete="off" spellCheck={false} value={newName} onChange={(event) => { setNewName(event.target.value); setError(""); }} />
      <button className={cx(buttonClasses({ variant: "primary" }), "text-caption")} type="submit" disabled={disabled} data-variant="primary">Add</button><button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} type="button" onClick={() => setAdding(false)}>Cancel</button>
      <p className={"text-caption text-graphite"}>Starts blank in both environments. Choose its source next.</p>
      {error ? <p role="alert" className={"text-refuse wrap-anywhere text-caption"}>{error}</p> : null}
    </form> : null}
    <TextInput type="search" className={"mt-2"} aria-label="Search client mappings" placeholder="Find a field or source…" value={filter} onChange={(event) => setFilter(event.target.value)} data-slot="client-mapping-search" />
    {file.problem ? <p role="alert" className={"text-refuse wrap-anywhere"}>{file.problem}</p> : null}
    <ul className={"list-none p-0 m-[10px_0_0] [&>li]:grid [&>li]:border-t [&>li]:border-rule [&>li]:gap-2.5 [&>li]:p-[14px_0]"} data-slot="client-environment-mappings">{matches.map(({ name, mapping, previews, split }) => {
      const saved = file.mappings[name];
      const changed = JSON.stringify(mappings[name]) !== JSON.stringify(saved);
      const open = expanded === name;
      const attention = (["dev", "prod"] as const).filter((mode) => previews[mode].status === "unavailable");
      const notes = previews.dev.note === previews.prod.note ? [previews.dev.note] : (["dev", "prod"] as const).map((mode) => `${MODE_LABELS[mode]}: ${previews[mode].note}`);
      const source = previews[model.mode].sources[0] ?? previews[model.mode === "dev" ? "prod" : "dev"].sources[0];
      return <li key={name}>
        <div className={"flex items-center [gap:7px] min-w-0 [&_strong]:flex-1 [&_strong]:min-w-0 [&_strong]:wrap-anywhere [&_strong]:text-caption [&_strong]:[line-height:1.5] inspector-420:flex-wrap inspector-420:[&_strong]:basis-full"} data-slot="client-mapping-name"><strong><code>{name}</code></strong>
          <EnvironmentPills label={`${name} environments`} availability={{ dev: previews.dev.status === "mapped", prod: previews.prod.status === "mapped" }}
            descriptions={{ dev: "generated in development", prod: "generated in production" }} unavailableDescription="blank" />
          <button className={iconButtonClasses()} title="Rename field in both environments" aria-label={`Rename ${name}`} disabled={disabled} onClick={() => setRename({ name, value: name, error: "" })}><Pencil size={14} aria-hidden /></button>
          <button className={iconButtonClasses()} title="Remove field from both environments" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => remove(name)}><Trash2 size={14} aria-hidden /></button>
        </div>
        {rename?.name === name ? <form className={"grid gap-2 [&_p]:m-0"} onSubmit={(event) => { event.preventDefault(); renameField(); }} data-slot="client-mapping-rename">
          <TextInput autoFocus aria-label={`New name for ${name}`} autoComplete="off" spellCheck={false} value={rename.value} onChange={(event) => setRename({ ...rename, value: event.target.value, error: "" })} />
          <div className={"flex flex-wrap justify-between gap-2"} data-slot="client-mapping-actions"><span className={"text-caption text-graphite"}>Renames in both environments.</span><button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} type="button" onClick={() => setRename(undefined)}>Cancel rename</button><button className={cx(buttonClasses({ variant: "primary" }), "text-caption")} type="submit" disabled={disabled} data-variant="primary">Save name</button></div>
          {rename.error ? <p role="alert" className={"text-caption text-refuse wrap-anywhere"}>{rename.error}</p> : null}
        </form> : null}
        <button className={"grid w-full cursor-pointer gap-1 rounded-sm border-0 bg-transparent p-0 text-left text-ink [&[aria-expanded=true]_svg]:[transform:rotate(90deg)] [&>code]:text-caption [&>code]:[line-height:1.6] [&>code]:wrap-anywhere [&:hover>code]:text-dev"} aria-label={`Edit mapping for ${name}`} aria-expanded={open} aria-controls={`mapping-${name}`} onClick={() => setExpanded(open ? null : name)} data-slot="client-mapping-summary">
          <span className={"flex items-center gap-2 text-caption text-graphite [&>span:first-child]:flex-1 [&_svg]:flex-none [&_svg]:[transition:transform_.15s]"} data-slot="client-mapping-summary-heading"><span>{split ? "Different sources" : sourceKinds[clientBindingFor(mapping, "dev").kind]}</span><span className={attention.length ? "text-refuse wrap-anywhere" : "text-graphite"}>{changed ? "Edited" : ""}{changed && attention.length ? " · " : ""}{attention.length ? `Needs attention in ${attention.map((mode) => MODE_LABELS[mode]).join(" and ")}` : ""}</span><ChevronRight size={14} aria-hidden /></span>
          {split ? (["dev", "prod"] as const).map((mode) => <code key={mode}>{mode === "dev" ? "Dev" : "Prod"} · {previews[mode].expression}</code>) : <code>{previews.dev.expression}</code>}
        </button>
        {open ? <div id={`mapping-${name}`} className={"grid gap-3 p-3 border border-rule rounded-md bg-paper"} data-slot="client-mapping-detail">
          {split ? (["dev", "prod"] as const).map((mode) => <div key={mode} className={"grid gap-2 [&>h4]:m-0 [&>h4]:text-caption [&>h4]:font-medium [&>h4]:text-graphite"} data-slot="client-mapping-mode"><h4>{MODE_LABELS[mode]}</h4>
            <SourceControls name={`${name} in ${MODE_LABELS[mode]}`} binding={clientBindingFor(mapping, mode)} options={file.options} disabled={disabled} onChange={(next) => update(name, { ...clientBindingSplit(mapping), [mode]: next })} />
          </div>) : <SourceControls name={name} binding={clientBindingFor(mapping, "dev")} options={file.options} disabled={disabled} onChange={(next) => update(name, next)} />}
          <div className={"flex min-w-0 items-center justify-between gap-3 text-label font-medium [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere"} data-slot="setting-switch"><label htmlFor={`split-${name}`}>Different source in each environment</label><InspectorSwitch id={`split-${name}`} label={`Different source in each environment for ${name}`} checked={split} disabled={disabled} onChange={(checked) => update(name, checked ? clientBindingSplit(mapping) : clientBindingFor(mapping, model.mode))} /></div>
          {notes.map((note) => <p key={note} className={cx("m-0 text-caption", attention.length ? "text-refuse wrap-anywhere" : "text-graphite")} role="status" data-slot="client-mapping-note">{note}</p>)}
          <div className={"flex flex-wrap justify-between gap-2"} data-slot="client-mapping-actions">
            {source?.entity ? <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} aria-label={`Open source for ${name}`} title={draft.dirty ? "Apply or discard changes before opening the source" : source.label} disabled={draft.dirty} onClick={() => select(source.entity!)}><ArrowUpRight size={14} aria-hidden />Open source</button> : null}
            <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} aria-label={`Reset mapping for ${name}`} disabled={disabled || !changed || !saved} onClick={() => { if (saved) draft.setClientMappings({ ...mappings, [name]: saved }); }}>Reset mapping</button>
          </div>
        </div> : null}
      </li>;
    })}</ul>
    {!matches.length ? <p className={"text-caption text-graphite"}>{rows.length ? "No matching fields or sources." : "Add a field to choose its source."}</p> : null}
    {editError ? <p role="alert" className={"text-caption text-refuse wrap-anywhere"}>{editError}</p> : null}
  </section>;
}

/** The same recipe written once per environment, ready to diverge. */
const clientBindingSplit = (mapping: ClientEnvironmentMapping) => ({ dev: clientBindingFor(mapping, "dev"), prod: clientBindingFor(mapping, "prod") });

export function ClientEnvironmentFileView({ resource }: { readonly resource: ModelResource }) {
  return <>
    <header><span className={"text-graphite text-meta font-medium tracking-[.03em]"}>Generated client settings</span><h2><EntityIcon icon="envFile" />Client environment</h2><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{CLIENT_ENVIRONMENT_FILES.dev}</code><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{CLIENT_ENVIRONMENT_FILES.prod}</code></header>
    <ClientEnvironmentMappings />
    <Description entity={resource.id} />
  </>;
}
