import { useEffect, useRef, useState } from "react";
import type { ModelResource, ModelTarget } from "../../shared/model";
import type { TriggerBinding } from "../../shared/triggers";
import { triggerTiming, triggerUnavailable } from "../../shared/trigger-availability";
import { useStudio } from "../studio";
import { titleOf } from "../lookup";
import { Written } from "./Written";

interface Form {
  readonly event: string;
  readonly resource: string;
  readonly adapter: string;
  readonly id: string;
  readonly accepts: boolean;
  readonly fields: Readonly<Record<string, string>>;
}

export function Triggers({ resource, target }: { readonly resource?: ModelResource; readonly target?: ModelTarget }) {
  const { snapshot, model, index, draft, draftState, select } = useStudio();
  const [form, setForm] = useState<Form>();
  const [error, setError] = useState<string>();
  const [advice, setAdvice] = useState<string>();
  const [stack, setStack] = useState("");
  const original = useRef(new Map<string, readonly TriggerBinding[]>());
  const previous = useRef<{ event: string; key: string } | undefined>(undefined);
  useEffect(() => { if (!draft.dirty) { setForm(undefined); setError(undefined); setAdvice(undefined); previous.current = undefined; original.current.clear(); } }, [draftState.entries]);
  const events = model.targets.filter((item) => item.role === "event");
  const capabilities = snapshot.source.triggerCapabilities ?? [];
  const capability = resource && capabilities.find((item) => item.resource === resource.id);
  if (resource && !capability) return null;
  const all = events.flatMap((event) => draft.triggers(event.id));
  const owns = (binding: TriggerBinding) => resource ? binding.resource === resource.id : binding.event === target?.id;
  const managed = all.filter(owns);
  const native = model.edges.filter((edge) => edge.relation === "trigger" && edge.provenance === "source" && (resource ? edge.from === resource.id : edge.to === target?.ref));
  const metadata = model.triggerAdapters?.find((item) => item.kind === form?.adapter);
  const selectedCapability = capabilities.find((item) => item.resource === form?.resource);
  const resourceReason = resource ? capability?.adapters.some((item) => !triggerUnavailable(snapshot, resource.id, item.kind)) ? undefined : capability?.adapters[0] ? triggerUnavailable(snapshot, resource.id, capability.adapters[0].kind) : "Unknown public type; no compatible trigger adapter." : undefined;
  const occupied = (operation: string) => metadata?.exclusive && [...snapshot.source.cdkLinks.edges.filter((edge) => edge.relation === "trigger" && edge.from === form?.resource).map((edge) => edge.label), ...all.filter((binding) => binding.resource === form?.resource && binding.key !== previous.current?.key).map((binding) => String(binding.options[metadata.exclusive!]))].includes(operation);
  const candidateReason = (resource: string) => {
    const capability = capabilities.find((item) => item.resource === resource);
    if (!capability?.adapters.length) return "Unknown type; no trigger adapter";
    const reasons = capability.adapters.map((adapter) => triggerUnavailable(snapshot, resource, adapter.kind));
    return reasons.every(Boolean) ? reasons[0] : undefined;
  };
  const remember = (event: string) => { if (!original.current.has(event)) original.current.set(event, draft.triggers(event)); };
  const start = (binding?: TriggerBinding) => {
    original.current.clear(); previous.current = binding && { event: binding.event, key: binding.key };
    setError(undefined); setAdvice(undefined);
    setForm(binding ? { event: binding.event, resource: binding.resource, adapter: binding.adapter, id: binding.id, accepts: true, fields: Object.fromEntries(Object.entries(binding.options).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value, null, model.triggerAdapters?.find((item) => item.kind === binding.adapter)?.fields.find((field) => field.name === key)?.kind === "resource" ? undefined : 2) : String(value)])) } : { event: target?.id ?? "", resource: resource?.id ?? "", adapter: capability?.adapters[0]?.kind ?? "", id: "", accepts: false, fields: {} });
  };
  const update = (patch: Partial<Form>) => {
    if (!form) return;
    const next = { ...form, ...patch };
    const adapter = model.triggerAdapters?.find((item) => item.kind === next.adapter);
    if (!next.id && adapter) {
      const base = `${adapter.kind}-trigger`;
      let id = base, count = 2;
      while (all.some((binding) => binding.resource === next.resource && binding.id === id && binding.key !== previous.current?.key)) id = `${base}-${count++}`;
      next.id = id;
    }
    setForm(next);
    if (!next.event || !next.resource || !adapter) {
      if (previous.current) draft.setTriggers(previous.current.event, draft.triggers(previous.current.event), "Choose an event Lambda and compatible public resource.");
      return;
    }
    remember(next.event);
    if (previous.current) {
      remember(previous.current.event);
      draft.setTriggers(previous.current.event, draft.triggers(previous.current.event).filter((binding) => binding.key !== previous.current!.key));
    }
    let problem = triggerUnavailable(snapshot, next.resource, next.adapter);
    const options: Record<string, unknown> = {};
    for (const field of adapter.fields) {
      const raw = next.fields[field.name];
      if (!raw?.trim()) { if (field.required) problem ??= `Choose ${field.label.toLowerCase()}.`; continue; }
      try { options[field.name] = field.kind === "json" || field.kind === "resource" ? JSON.parse(raw) : field.kind === "number" ? Number(raw) : field.kind === "boolean" ? raw === "true" : raw; }
      catch { problem ??= `${field.label} must be valid JSON.`; }
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(next.id)) problem ??= "Use a stable kebab-case attachment id.";
    if (!next.accepts) problem ??= "Acknowledge the handler contract.";
    problem ??= triggerUnavailable(snapshot, next.resource, next.adapter, options);
    const timing = triggerTiming(snapshot, { event: next.event, resource: next.resource, adapter: next.adapter, options });
    problem ??= timing.problem;
    setAdvice(timing.recommendation);
    const eventTarget = events.find((event) => event.id === next.event);
    if (eventTarget?.compute.kind === "lambda" && eventTarget.compute.localReplay && !adapter.replay && !adapter.replayOperations?.includes(String(options[adapter.exclusive ?? ""]))) problem ??= "Local replay cannot provide this source's required response.";
    if (adapter.exclusive && snapshot.source.cdkLinks.edges.some((edge) => edge.relation === "trigger" && edge.from === next.resource && edge.label === options[adapter.exclusive!])) problem ??= "This hook is occupied by native wiring.";
    const binding: TriggerBinding = { event: next.event, resource: next.resource, adapter: next.adapter, id: next.id, key: `${next.resource.replace(/^resource:/, "")}/${next.id}`, accepts: next.accepts ? adapter.contract : "", options };
    draft.setTriggers(next.event, [...draft.triggers(next.event), binding], problem);
    previous.current = { event: next.event, key: binding.key };
    setError(problem);
  };
  const cancel = () => { for (const [event, bindings] of original.current) draft.setTriggers(event, bindings); setForm(undefined); setError(undefined); setAdvice(undefined); };
  const stacks = [...new Set(capabilities.map((item) => item.stack))];
  return <section className="trigger-editor"><details><summary>Triggers <span className="muted">{managed.length + native.length || ""}</span></summary>
    {native.map((edge) => <div className="trigger-row" key={edge.id}><button className="linkish" onClick={() => select(edge.id)}>{edge.label}</button><span className="small muted">Native · occupied</span><Written location={edge.source} label="Wired in" /></div>)}
    {managed.filter((binding) => !form || binding.key !== previous.current?.key).map((binding) => <div className="trigger-row" key={`${binding.event}:${binding.key}`}><span className="small">{resource ? titleOf(index, `lambda:${binding.event}`) : binding.resource.replace(/^resource:/, "")} · {String(binding.options.operation ?? binding.adapter)}</span><button className="linkish small" aria-label={`Edit trigger ${binding.id}`} onClick={() => start(binding)}>Edit</button><button className="linkish small" aria-label={`Remove trigger ${binding.id}`} onClick={() => draft.setTriggers(binding.event, draft.triggers(binding.event).filter((item) => item.key !== binding.key))}>Remove</button></div>)}
    {resourceReason ? <p className="small muted">{resourceReason}</p> : !form ? <button className="quiet small" onClick={() => start()}>Add trigger</button> : <div className="trigger-form">
      {resource ? <label>Event Lambda<select aria-label="Trigger event Lambda" value={form.event} onChange={(event) => update({ event: event.target.value })}><option value="">Choose event Lambda</option>{events.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label> : <>
        <label>Stack<select aria-label="Trigger stack" value={stack} onChange={(event) => { setStack(event.target.value); update({ resource: "", adapter: "", fields: {} }); }}><option value="">All stacks</option>{stacks.map((id) => <option key={id} value={id}>{titleOf(index, id)}</option>)}</select></label>
        <label>Public resource<select aria-label="Trigger public resource" value={form.resource} onChange={(event) => { const chosen = capabilities.find((item) => item.resource === event.target.value); update({ resource: event.target.value, adapter: chosen?.adapters[0]?.kind ?? "", fields: {} }); }}><option value="">Choose public field</option>{stacks.filter((id) => !stack || id === stack).map((id) => <optgroup key={id} label={titleOf(index, id)}>{capabilities.filter((item) => item.stack === id).map((item) => { const reason = candidateReason(item.resource); return <option key={item.resource} value={item.resource} disabled={!!reason}>{item.name}{reason ? ` — ${reason}` : ""}</option>; })}</optgroup>)}</select></label>
      </>}
      {(selectedCapability?.adapters.length ?? 0) > 1 ? <label>Invocation<select aria-label="Trigger invocation" value={form.adapter} onChange={(event) => update({ adapter: event.target.value, fields: {} })}>{selectedCapability!.adapters.map((item) => <option key={item.kind} value={item.kind} disabled={!!triggerUnavailable(snapshot, form.resource, item.kind)}>{model.triggerAdapters?.find((adapter) => adapter.kind === item.kind)?.label ?? item.kind}</option>)}</select></label> : null}
      {metadata ? <>
        <label>Attachment id<input aria-label="Trigger attachment id" value={form.id} onChange={(event) => update({ id: event.target.value })} /></label>
        {metadata.fields.map((field) => <label key={field.name}>{field.label}{field.kind === "enum" || field.kind === "boolean" ? <select aria-label={`Trigger ${field.label}`} value={form.fields[field.name] ?? ""} onChange={(event) => update({ fields: { ...form.fields, [field.name]: event.target.value } })}><option value="">{field.required ? "Choose" : "Default"}</option>{(field.values ?? ["true", "false"]).map((value) => <option key={value} value={value} disabled={!!occupied(value)}>{value}{occupied(value) ? " · occupied" : ""}</option>)}</select> : field.kind === "resource" ? <select aria-label={`Trigger ${field.label}`} value={form.fields[field.name] ?? ""} onChange={(event) => update({ fields: { ...form.fields, [field.name]: event.target.value } })}><option value="">None</option>{capabilities.filter((item) => item.canonicalTypes.includes(`${field.resourceType?.module}:${field.resourceType?.name}`)).map((item) => { const value = JSON.stringify({ $cdk: "@repo/framework/cdk-resource", path: model.resources.find((resource) => resource.id === item.resource)!.path, optional: false }); const unavailable = field.resourceType?.owned && !item.owned; return <option key={item.resource} value={value} disabled={!!unavailable}>{item.resource.replace(/^resource:/, "")}{unavailable ? " · imported" : ""}</option>; })}</select> : field.kind === "json" ? <textarea aria-label={`Trigger ${field.label}`} rows={4} value={form.fields[field.name] ?? ""} onChange={(event) => update({ fields: { ...form.fields, [field.name]: event.target.value } })} /> : <input aria-label={`Trigger ${field.label}`} type={field.kind === "number" ? "number" : "text"} min={field.min} max={field.max} value={form.fields[field.name] ?? ""} onChange={(event) => update({ fields: { ...form.fields, [field.name]: event.target.value } })} />}</label>)}
        <label className="small"><input type="checkbox" aria-label="Acknowledge trigger handler contract" checked={form.accepts} onChange={(event) => update({ accepts: event.target.checked })} />Handler supports {metadata.contract}: {metadata.delivery}.</label>
      </> : null}
      {error ? <p className="reason small" role="alert">{error}</p> : advice ? <p className="small muted">{advice}</p> : null}
      <div className="resource-actions"><button className="quiet small" disabled={!previous.current || !!error || !!draftState.busy} onClick={() => setForm(undefined)}>Done</button><button className="quiet small" onClick={cancel}>Cancel</button></div>
    </div>}
  </details></section>;
}
