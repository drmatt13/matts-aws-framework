import { useEffect, useId, useRef, useState } from "react";
import { CREATORS, CreationValidationError, defaultImplementationDirectory, networkCreationProblem, readCreationRequest, type CreationField } from "../../shared/creation";
import type { CreationEntry } from "../draft";
import { useStudio } from "../studio";
import { InspectorSwitch } from "./InspectorUI";
import { InterfaceEndpointPicker } from "./InterfaceEndpointPicker";
import { TagRows } from "./Tags";
import { deploymentSettingLabel } from "../deployment";

/** Forms are part of InspectorDraft: review/back, source conflicts, navigation,
 * browser exit, discard and apply all share the existing session lifecycle. */
export function CreationWizard({ entry, back }: { readonly entry: CreationEntry; readonly back: () => void }) {
  const { draft, draftState, model, live } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const [tagError, setTagError] = useState<string>();
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (field: string) => setTouched(current => current.has(field) ? current : new Set([...current, field]));
  const creator = CREATORS[entry.resourceKind];
  const disabled = !!draftState.busy || draft.conflict || !!model.stale || live.evaluating;
  useEffect(() => {
    const element = dialog.current!;
    if (!draftState.reviewOpen && !draftState.pendingNavigation) element.showModal();
    return () => element.close();
  }, [draftState.reviewOpen, draftState.pendingNavigation]);
  let problem: CreationValidationError | undefined;
  try {
    const request = readCreationRequest({ kind: entry.resourceKind, ...entry.form });
    if (request.kind === "vpc") problem = networkCreationProblem(request, model.networks ?? []);
  }
  catch (error) { if (error instanceof CreationValidationError) problem = error; }
  const fields = creator.fields.filter((field) => {
    const lambda = entry.resourceKind === "function" || entry.resourceKind === "route";
    if (!lambda) return true;
    if (entry.form.category === "event" && ["path", "method", "auth", "deploy"].includes(field.key)) return false;
    if (entry.form.category === "webSocket" && ["method", "auth"].includes(field.key)) return false;
    if (entry.resourceKind === "route" && entry.form.existingTarget && !["description", "category", "path", "method", "existingTarget", "tags"].includes(field.key)) return false;
    return true;
  });
  const render = (field: CreationField) => {
    const id = `${prefix}-${field.key}`;
    const serverError = draftState.error?.startsWith(`${field.key}: `) ? draftState.error.slice(field.key.length + 2) : undefined;
    const error = serverError ?? (problem?.field === field.key && touched.has(field.key) ? problem.message : undefined);
    const describedBy = [field.help ? `${id}-help` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
    const value = entry.form[field.key];
    const update = (next: string | number | boolean) => {
      touch(field.key);
      const form = { ...entry.form, [field.key]: next };
      if (field.key === "existingTarget" && next) { const target = model.targets.find(target => target.ref === next); if (target) form.id = target.id; }
      const envName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
      const route = (name: string, category: unknown) => entry.resourceKind === "service" ? `/${name}/*` : category === "webSocket" ? name : `/${name}`;
      if (field.key === "vpc" && next && form.subnet === "none") form.subnet = "private";
      if (field.key === "vpc" && !next && ["function", "route"].includes(entry.resourceKind)) form.subnet = "none";
      if (field.key === "id" && typeof next === "string") {
        const old = String(entry.form.id);
        if ("envName" in form && (!form.envName || form.envName === envName(old))) form.envName = envName(next);
        if ("className" in form && (!form.className || form.className === `${old[0]?.toUpperCase() ?? ""}${old.slice(1)}Stack`)) form.className = `${next[0]?.toUpperCase() ?? ""}${next.slice(1)}Stack`;
        if (entry.resourceKind !== "agent" && "path" in form && (!form.path || form.path === route(old, form.category))) form.path = route(next, form.category);
      }
      if (field.key === "category" && (!form.path || form.path === route(String(form.id), entry.form.category))) form.path = route(String(form.id), next);
      if (field.key === "bindingResource" && !form.bindingVariable) {
        const resource = model.resources.find((resource) => resource.id === next);
        if (resource?.fromEnv) form.bindingVariable = resource.fromEnv + (resource.kind === "secret" && !["service", "task"].includes(entry.resourceKind) ? "_SECRET_ARN" : "");
      }
      if (field.key === "consumer" && !form.consumerVariable) {
        const target = model.targets.find((target) => target.ref === next);
        if (target) form.consumerVariable = String(form.envName) + (entry.resourceKind === "secret" && target.kind !== "service" && target.kind !== "task" ? "_SECRET_ARN" : "");
      }
      draft.setCreation(entry.resourceKind, form);
    };
    const options = field.key === "vpc" ? ["", ...(model.networks ?? []).map(network => network.id)] : field.key === "bindingResource" ? ["", ...model.resources.filter((resource) => resource.kind === "input" || resource.kind === "secret").map((resource) => resource.id)]
      : field.key === "consumer" ? ["", ...model.targets.map((target) => target.ref)]
      : field.key === "existingTarget" ? ["", ...model.targets.filter((target) => target.kind === "lambda" && target.role === entry.form.category).map((target) => target.ref)] : field.options;
    const appendOptions = field.key === "steps" ? model.targets.filter((target) => target.kind === "task" || target.role === "event").map((target) => target.ref)
      : field.key === "tools" ? model.targets.filter((target) => target.role === "tool" && (entry.form.auth || !target.auth)).map((target) => target.id) : undefined;
    const remainingOptions = appendOptions?.filter((option) => !String(value).split(",").map((part) => part.trim()).includes(option));
    const optionLabel = (option: string) => {
      if (field.key === "implementation") return option === "existing" ? "Use existing code" : "Create starter files";
      if (field.key === "starter") return option === "model" ? "Model and tools (provider charges)" : "Echo (no model call)";
      if (field.key === "template") return option === "bucket" ? "Private encrypted bucket (retain data)" : "SQS queue";
      if (field.key === "deploy") return deploymentSettingLabel(option, entry.form.category === "webSocket" ? model.webSocketApi : undefined);
      if (field.key === "scope") return ({ both: "Dev + Prod", dev: "Development", prod: "Production" } as Record<string, string>)[option] ?? option;
      if (field.key === "category") return ({ event: "Event Lambda", http: "HTTP Lambda", webSocket: "WebSocket Lambda" } as Record<string, string>)[option] ?? option;
      if (field.key === "vpc") { const network = model.networks?.find(network => network.id === option); return network?.name ? `${network.name} (${network.id})` : option || "None"; }
      return option || "None";
    };
    const endpoints = entry.resourceKind === "vpc" && field.key === "endpoints";
    const tagField = field.key === "tags";
    return <div className={`creation-field ${field.type === "boolean" ? "creation-switch" : ""} ${endpoints ? "endpoint-creation-field" : ""} ${tagField || field.key === "description" || field.type === "list" ? "creation-field-wide" : ""}`} key={field.key}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) touch(field.key); }}>
      {tagField ? <span id={`${id}-label`} className="creation-field-label">{field.label}</span> : <label htmlFor={id}>{field.label}</label>}
      <div className="creation-field-control" role={tagField ? "group" : undefined} aria-labelledby={tagField ? `${id}-label` : undefined} aria-describedby={tagField ? describedBy : undefined}>
      {tagField ? <TagRows value={JSON.parse(String(value ?? "{}")) as Record<string, string>} disabled={disabled} onChange={(tags, error) => { setTagError(error); draft.setCreation(entry.resourceKind, { ...entry.form, tags: JSON.stringify(tags) }, error); }} />
        : endpoints ? <InterfaceEndpointPicker id={id} services={model.interfaceEndpointServices} selected={String(value ?? "").split(",").map(name => name.trim()).filter(Boolean)}
        onChange={services => update(services.join(", "))} disabled={disabled} invalid={!!error} describedBy={describedBy} />
        : field.type === "boolean" ? <InspectorSwitch id={id} label={field.label} checked={value === true} onChange={update} disabled={disabled} invalid={!!error} describedBy={describedBy} />
        : options ? <select id={id} value={String(value)} onChange={(event) => update(event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={describedBy}>
          {options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
        </select>
          : <input id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => update(field.type === "number" ? Number(event.target.value) : event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={describedBy} autoComplete="off" spellCheck={false} />}
      {remainingOptions ? <select aria-label={`Add ${field.key === "steps" ? "workflow step" : "agent tool"}`} disabled={disabled || !remainingOptions.length} value="" onChange={(event) => {
        if (event.target.value) update([String(value), event.target.value].filter(Boolean).join(", "));
      }}><option value="">{remainingOptions.length ? `Select an existing ${field.key === "steps" ? "target" : "tool"}…` : `No more ${field.key === "steps" ? "targets" : "tools"} available`}</option>{remainingOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select> : null}
      {field.help ? <p id={`${id}-help`} className="small muted">{field.help}</p> : null}
      {error ? <p id={`${id}-error`} className="reason small" role="status">{error}</p> : null}
      </div>
    </div>;
  };
  const implementationDirectory = String(entry.form.directory || defaultImplementationDirectory(entry.resourceKind, String(entry.form.id || "<identifier>"), String(entry.form.category ?? "event")) || "");
  const starterFiles = entry.resourceKind === "agent" ? ["index.ts", "contract.ts", "package.json", "tsconfig.json"] : entry.resourceKind === "tool" ? ["index.ts", "contract.ts"] : entry.resourceKind === "service" ? ["index.mjs", "Dockerfile", "package.json"] : entry.resourceKind === "task" ? ["index.mjs", "Dockerfile"] : ["index.ts"];
  return <dialog ref={dialog} className="preview creation-wizard" aria-labelledby={`${prefix}-title`} onCancel={(event) => { event.preventDefault(); back(); }}>
    <header><p className="small muted">Add to application · Configure → Review → Apply</p><h2 id={`${prefix}-title`}>{entry.resourceKind === "vpc" ? "Create VPC" : `Create ${creator.label.toLowerCase()}`}</h2></header>
    <div className="body" aria-busy={!!draftState.busy}>
      <p>{creator.help}</p>
      {implementationDirectory && !entry.form.existingTarget ? <details className="implementation-preview"><summary>Implementation files</summary><p className="small muted">{entry.resourceKind === "agent" ? "Repository root" : "cdk-app"}: <code>{implementationDirectory}</code>. {entry.form.implementation === "existing" ? "Existing files are validated and preserved." : "New starter files join the reviewed source patch."} The declared construct identity is resolved during review; deployment is separate.</p>{entry.form.implementation !== "existing" ? <ul>{starterFiles.map(file => <li key={file}><code>{file}</code></li>)}</ul> : null}</details> : null}
      <fieldset className="creation-form-fields" disabled={disabled} aria-label={`${creator.label} settings`}>
      <div className="creation-fields">{fields.filter((field) => !field.advanced).map(render)}</div>
      {fields.some((field) => field.advanced) ? <details><summary>Advanced settings</summary><div className="creation-fields">{fields.filter((field) => field.advanced).map(render)}</div></details> : null}
      </fieldset>
      {live.evaluating ? <p className="small muted" role="status">Refreshing configuration… Your form is preserved.</p> : null}
      {draft.conflict ? <div className="reason" role="alert"><p>Source changed while you were configuring this resource. Your form is preserved. Review against the latest source to check the exact updated proposal.</p><button className="quiet" disabled={!!draftState.busy} onClick={() => draft.reviewAgainstLatest()}>Review against latest source</button></div> : null}
      {draftState.error ? <p className="reason" role="alert">{draftState.error}</p> : null}
      <p className="small muted">Review shows every proposed file before anything is written. Apply saves source; deployment is a separate action.</p>
    </div>
    <footer><button className="quiet" disabled={!!draftState.busy} onClick={back}>Back to resource types</button><button className="quiet" disabled={!!draftState.busy} onClick={() => draft.discard()}>Cancel creation</button><button className="primary" disabled={!!problem || !!tagError || draft.invalid || disabled} onClick={() => void draft.review()}>Review generated changes</button></footer>
  </dialog>;
}
