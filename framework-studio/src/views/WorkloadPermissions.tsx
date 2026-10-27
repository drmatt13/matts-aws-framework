import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DraftEdit } from "../../shared/api";
import type { ModelResource, ModelTarget } from "../../shared/model";
import { configuredAccessOptions, accessConnectionExists } from "../access-options";
import { targetAccess, type AccessEntry } from "../access";
import { iconUrl, targetIcon, ICONS } from "../icons";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { AuthorizationBadge, AuthorizationDetails } from "./Authorization";
import { ConfiguredResourcePicker } from "./ConfiguredResourcePicker";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";

type ConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;
type DisplayedAccess = AccessEntry & { readonly environmentLabel?: string };
const connectionKey = (edit: ConnectionEdit) => JSON.stringify([edit.target, edit.connection, edit.destination, edit.variable, edit.grant, edit.scope ?? ""]);

/** The same reviewed edit is available from a consumer or from its destination. */
function AccessEditor({ target, destination, onDone }: {
  readonly target: ModelTarget; readonly destination?: string; readonly onDone: () => void;
}) {
  const { snapshot, model, live, draft, draftState } = useStudio();
  const options = useMemo(() => configuredAccessOptions(target, snapshot, destination), [target, snapshot, destination]);
  const scopeHelp = useId();
  const suggestedVariable = (id: string) => {
    const resource = Object.values(snapshot.models).flatMap(model => model.resources).find(item => item.id === id);
    if (!resource || !["input", "secret"].includes(resource.kind)) return "";
    const name = resource.fromEnv ?? resource.path.at(-1)?.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() ?? "";
    return resource.kind === "secret" && target.kind !== "service" && target.kind !== "task" && !name.endsWith("_ARN") ? `${name}${name.endsWith("_SECRET") ? "_ARN" : "_SECRET_ARN"}` : name;
  };
  const [selected, setSelected] = useState(destination ?? "");
  const option = options.find(item => item.id === selected);
  const form = useRef<HTMLDivElement>(null);
  const [actionId, setActionId] = useState("");
  const action = option?.actions.find(item => item.id === actionId) ?? option?.actions.find(item => !item.reason) ?? option?.actions[0];
  const [scope, setScope] = useState("uploads/*");
  const [variable, setVariable] = useState(() => suggestedVariable(destination ?? ""));
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  useEffect(() => {
    if (option) form.current?.querySelector<HTMLElement>("select:not(:disabled), input:not(:disabled), button[data-stage]")?.focus();
  }, [option?.id]);
  const choose = (id: string) => { setSelected(id); setActionId(""); setScope("uploads/*"); setVariable(suggestedVariable(id)); };
  if (!option) return <ConfiguredResourcePicker label="Configured resources" options={options} onChoose={choose} onCancel={onDone} disabled={disabled} />;
  const edit = action ? { ...action.edit, ...(action.edit.connection === "grant" ? { scope: action.scope ? scope : "" } : {}), ...(action.variable ? { variable } : {}) } : undefined;
  const duplicate = !!edit && accessConnectionExists(edit, snapshot);
  const pending = edit && draftState.entries.some(entry => entry.kind === "operation" && entry.operation.kind === "connection" && connectionKey(entry.operation) === connectionKey(edit));
  const variableUsed = action?.variable && [...target.environment, ...target.secrets].some(entry => entry.name === variable);
  const problem = option.reason ?? action?.reason ?? (duplicate ? "This access is already configured." : pending ? "This change is already staged." : variableUsed ? "This environment variable is already in use." : action?.variable && variable && !/^[A-Z][A-Z0-9_]*$/.test(variable) ? "Use uppercase letters, digits and underscores, starting with a letter." : undefined);
  const valid = !!edit && !problem && (!action?.variable || /^[A-Z][A-Z0-9_]{0,127}$/.test(variable)) && (!action?.scope || scope.length <= 256 && !/[\r\n\0]/.test(scope));
  return <div ref={form} className="access-editor" role="group" aria-label={`Access to ${option.title}`} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(); }
  }}>
    <div className="access-destination"><img src={iconUrl(option.icon)} alt="" /><span><strong>{option.title}</strong><span className="small muted">{option.subtitle}</span></span>{!destination ? <button className="linkish small" disabled={disabled} onClick={() => choose("")}>Change</button> : null}</div>
    {option.actions.length > 1 ? <label className="resource-control"><span>Permission</span><select value={action?.id ?? ""} disabled={disabled} onChange={event => setActionId(event.target.value)}>{option.actions.map(item => <option key={item.id} value={item.id} disabled={!!item.reason}>{item.label}{item.existing ? " · configured" : ""}</option>)}</select></label> : <p>{action?.label}</p>}
    {action?.scope ? <label className="resource-control"><span>Bucket object scope</span><input aria-label="Bucket object scope" aria-describedby={scopeHelp} value={scope} disabled={disabled} maxLength={256} onChange={event => setScope(event.target.value)} placeholder="* (all objects)" spellCheck={false} /><span id={scopeHelp} className="small muted">Limit access to an object prefix, or use * for all objects.</span></label> : null}
    {action?.variable ? <label className="resource-control"><span>Environment variable</span><input value={variable} disabled={disabled} maxLength={128} onChange={event => setVariable(event.target.value)} placeholder="MY_RESOURCE" spellCheck={false} /></label> : null}
    {action ? <AccessUsage edit={action.edit} /> : null}
    {problem ? <p className="small reason" role="status">{problem}</p> : null}
    <div className="access-actions"><button data-stage className="button" disabled={disabled || !valid} onClick={() => { if (edit && valid) { draft.stageOperation(edit); onDone(); } }}>Stage access</button><button className="quiet" onClick={onDone}>Cancel</button></div>
  </div>;
}

function AccessUsage({ edit }: { readonly edit: ConnectionEdit }) {
  const { snapshot } = useStudio();
  const destination = Object.values(snapshot.models).flatMap(model => model.targets).find(target => target.ref === edit.destination);
  const helper = edit.connection === "startsWorkflow" ? "startWorkflow" : edit.connection === "runsTask" ? "runTask" : undefined;
  if (helper && destination) return <p className="small muted">Call <code>{helper}({JSON.stringify(destination.id)}, input)</code> from your handler using <code>@repo/framework/runtime/invocation</code>.</p>;
  if (edit.connection === "invokesAgent") return <p className="small muted">Call <code>invokeAgent</code> from <code>@repo/framework/runtime/agentcore</code>; authenticated agents also require the caller’s session.</p>;
  if (edit.connection === "userPool") return <p className="small muted">Supplies the pool and client identifiers. To require a signed-in user, wrap the handler with <code>authenticated</code>.</p>;
  if (edit.connection === "database") return <p className="small muted">Connects to the application’s PostgreSQL database with IAM login and its private network placement.</p>;
  if (edit.connection === "resource") {
    const resource = Object.values(snapshot.models).flatMap(model => model.resources).find(item => item.id === edit.destination);
    const consumer = Object.values(snapshot.models).flatMap(model => model.targets).find(item => item.ref === edit.target);
    if (resource?.kind === "secret") return <p className="small muted">{consumer?.kind === "service" || consumer?.kind === "task" ? "Loads the secret into the container’s environment at startup." : "Supplies the secret ARN and grants the workload permission to read it."}</p>;
  }
  if (edit.connection === "grant" && edit.grant === "grantConsumeMessages") return <p className="small muted">Allows your code to read queue messages. For automatic delivery to an event function, add the queue under Triggers.</p>;
  return null;
}

function AccessRow({ entry, disabled }: { readonly entry: DisplayedAccess; readonly disabled: boolean }) {
  const { draft, draftState, select, snapshot } = useStudio();
  const pending = entry.remove && draftState.entries.find(item => item.kind === "operation" && item.operation.kind === "connection" && connectionKey(item.operation) === connectionKey(entry.remove!));
  const source = entry.edge?.source;
  const context = entry.edge?.permissionContext;
  const scope = context?.kind === "native" && context.arguments.length === 1 && typeof context.arguments[0] === "string" ? context.arguments[0] : undefined;
  return <details className="authorization-summary access-summary">
    <summary><img src={iconUrl(entry.destination.icon)} alt="" /><span className="access-summary-text"><strong>{entry.destination.title}</strong><span className="small muted">{entry.operation}{scope ? ` · ${scope}` : ""}{entry.environmentLabel ? ` · ${entry.environmentLabel}` : ""}</span></span>{pending ? <span className="section-state modified">Removal staged</span> : <AuthorizationBadge authorization={entry.authorization} />}</summary>
    <AuthorizationDetails authorization={entry.authorization} />
    {entry.remove ? <AccessUsage edit={entry.remove} /> : null}
    <div className="access-actions">
      {entry.destination.id ? <button className="linkish small" onClick={() => select(entry.destination.id)}>Inspect resource</button> : null}
      {entry.connection ? <button className="linkish small" onClick={() => select(entry.connection)}>Inspect connection</button> : null}
      {pending ? <button className="linkish small" disabled={disabled} onClick={() => draft.discardOperation(pending.key)}>Undo removal</button> : entry.remove ? <button className="linkish small" disabled={disabled} onClick={() => draft.stageOperation(entry.remove!)}>Remove access</button> : source ? <a className="linkish small" href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a> : null}
    </div>
  </details>;
}

function PendingAccess({ target, destination }: { readonly target?: string; readonly destination?: string }) {
  const { draft, draftState, snapshot, model, live } = useStudio();
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  const entries = draftState.entries.filter(entry => entry.kind === "operation" && entry.operation.kind === "connection" && entry.operation.enabled && (!target || entry.operation.target === target) && (!destination || entry.operation.destination === destination));
  return <>{entries.map(entry => {
    if (entry.kind !== "operation" || entry.operation.kind !== "connection") return null;
    const edit = entry.operation;
    const consumer = Object.values(snapshot.models).flatMap(model => model.targets).find(item => item.ref === edit.target);
    const options = consumer ? configuredAccessOptions(consumer, snapshot) : [];
    const option = options.find(item => item.actions.some(action => action.edit.connection === edit.connection && action.edit.destination === edit.destination));
    const action = option?.actions.find(item => item.edit.connection === edit.connection && item.edit.grant === edit.grant);
    return <div className="pending-access" key={entry.key} role="status">
      {option ? <img src={iconUrl(option.icon)} alt="" /> : null}<span><strong>{destination ? consumer?.title : option?.title}</strong><span className="small muted">{action?.label ?? "Access"}{edit.scope ? ` · ${edit.scope}` : ""}{edit.variable ? ` · ${edit.variable}` : ""}</span><span className="small">Staged for review</span></span><button className="linkish small" disabled={disabled} onClick={() => draft.discardOperation(entry.key)}>Undo</button>
    </div>;
  })}</>;
}

export function WorkloadPermissions({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const [editing, setEditing] = useState(false);
  const [addingCaller, setAddingCaller] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const caller = useRef<HTMLButtonElement>(null);
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  const { owned, incoming } = useMemo(() => {
    const modes = [...Object.values(snapshot.models).filter(item => item !== model), model];
    const access = modes.flatMap(item => {
      const consumer = item.targets.find(candidate => candidate.ref === target.ref);
      return consumer ? [{ mode: item.mode, ...targetAccess(consumer, item, snapshot.source) }] : [];
    });
    const combine = (side: "owned" | "incoming"): DisplayedAccess[] => {
      const entries = new Map<string, { entry: AccessEntry; modes: string[] }>();
      for (const item of access) for (const entry of item[side]) {
        // Build state can differ by mode; different permissions must remain visible.
        const key = JSON.stringify([entry.id, entry.authorization.kind, entry.authorization.grants, entry.edge?.permissionContext]);
        entries.set(key, { entry, modes: [...entries.get(key)?.modes ?? [], item.mode] });
      }
      return [...entries].map(([key, value]) => ({ ...value.entry, id: key,
        ...(value.modes.length === 1 && [...entries.values()].some(other => other !== value && other.entry.id === value.entry.id)
          ? { environmentLabel: value.modes[0] === "dev" ? "Dev" : "Prod" } : {}),
      }));
    };
    return { owned: combine("owned"), incoming: combine("incoming") };
  }, [target.ref, snapshot, model]);
  const done = () => { setEditing(false); requestAnimationFrame(() => add.current?.focus()); };
  const callerDone = () => { setAddingCaller(false); requestAnimationFrame(() => caller.current?.focus()); };
  const source = snapshot.source.entities[target.ref]?.value;
  const callable = ["task", "workflow", "agent"].includes(target.kind);
  return <InspectorSection title="Permissions" actions={target.kind !== "workflow" && !editing ? <button ref={add} className="quiet" disabled={disabled} onClick={() => setEditing(true)}>Add access</button> : undefined}>
    {editing ? <AccessEditor target={target} onDone={done} /> : null}
    {owned.map(entry => <AccessRow key={entry.id} entry={entry} disabled={disabled} />)}
    <PendingAccess target={target.ref} />
    {!owned.length && !editing ? <p className="small muted">No outgoing access configured.</p> : null}
    {target.kind === "workflow" ? <p className="small muted">Access is defined by this workflow’s steps.{source ? <> <a href={editorLink(snapshot.repositoryRoot, source)}>Open workflow definition</a>.</> : null}</p> : null}
    {incoming.length || callable ? <details className="incoming-access" open={target.kind === "workflow" || undefined}><summary>Incoming access <span className="section-count">{incoming.length}</span></summary>
      {callable && !addingCaller ? <p><button ref={caller} className="quiet" disabled={disabled} onClick={() => setAddingCaller(true)}>Add caller</button></p> : null}
      {addingCaller ? <ConsumerAccessEditor destination={target.ref} onDone={callerDone} /> : null}
      {incoming.map(entry => <AccessRow key={entry.id} entry={entry} disabled={disabled} />)}
      {callable ? <PendingAccess destination={target.ref} /> : null}
    </details> : null}
  </InspectorSection>;
}

function ConsumerAccessEditor({ destination, onDone }: { readonly destination: string; readonly onDone: () => void }) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const [consumer, setConsumer] = useState<ModelTarget>();
  const candidates = useMemo(() => [...new Map(Object.values(snapshot.models).flatMap(item => item.targets).map(target => [target.ref, target])).values()].flatMap(target => {
    const option = configuredAccessOptions(target, snapshot, destination).find(item => item.id === destination);
    return option ? [{ target, option }] : [];
  }), [snapshot, destination]);
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  return consumer ? <><p className="small muted">Grant to <strong>{consumer.title}</strong></p><AccessEditor key={consumer.ref} target={consumer} destination={destination} onDone={onDone} /></> : <ConfiguredResourcePicker label="Workloads" options={candidates.map(({ target, option }) => ({ id: target.ref, title: target.title, subtitle: `${ICONS[targetIcon(target)][1]} · ${target.role}`, icon: targetIcon(target), reason: option.reason, searchTerms: target.ref }))} onChoose={id => setConsumer(candidates.find(item => item.target.ref === id)?.target)} onCancel={onDone} disabled={disabled} />;
}

/** A resource can grant access without making the developer hunt for its consumer. */
export function ResourceAccess({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, model, draft, draftState, live, select } = useStudio();
  const [choosing, setChoosing] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const { supported, consumers } = useMemo(() => {
    const targets = [...new Map(Object.values(snapshot.models).flatMap(item => item.targets).map(target => [target.ref, target])).values()];
    const supported = targets.some(target => configuredAccessOptions(target, snapshot, resource.id).some(option => option.id === resource.id));
    const consumers = targets.filter(target => Object.values(snapshot.models).some(item => {
      const candidate = item.targets.find(value => value.ref === target.ref);
      return candidate && (targetAccess(candidate, item, snapshot.source).owned.some(entry => entry.destination.id === resource.id)
        || candidate.environment.some(entry => entry.value.kind === "reference" && entry.value.resource === resource.id)
        || candidate.secrets.some(entry => entry.resource === resource.id));
    }));
    return { supported, consumers };
  }, [snapshot, resource.id]);
  if (!supported) return null;
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  const done = () => { setChoosing(false); requestAnimationFrame(() => add.current?.focus()); };
  const input = resource.kind === "input";
  return <InspectorSection title={input ? "Connected workloads" : "Workload access"} actions={!choosing ? <button ref={add} className="quiet" disabled={disabled} onClick={() => setChoosing(true)}>{input ? "Connect workload" : "Grant access"}</button> : undefined}>
    {choosing ? <ConsumerAccessEditor destination={resource.id} onDone={done} /> : null}
    {consumers.length ? <ul className="relations">{consumers.map(target => <li key={target.ref}><button className="linkish" onClick={() => select(target.ref)}>{target.title}</button></li>)}</ul> : !choosing ? <p className="small muted">{input ? "No workloads use this input yet." : "No workloads have access yet."}</p> : null}
    <PendingAccess destination={resource.id} />
  </InspectorSection>;
}
