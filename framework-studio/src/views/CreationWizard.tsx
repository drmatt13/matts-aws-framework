import { useEffect, useId, useRef } from "react";
import { CREATORS, CreationValidationError, readCreationRequest, type CreationField } from "../../shared/creation";
import type { CreationEntry } from "../draft";
import { useStudio } from "../studio";

/** Forms are part of InspectorDraft: review/back, source conflicts, navigation,
 * browser exit, discard and apply all share the existing session lifecycle. */
export function CreationWizard({ entry, back }: { readonly entry: CreationEntry; readonly back: () => void }) {
  const { draft, draftState, model } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const creator = CREATORS[entry.resourceKind];
  useEffect(() => {
    const element = dialog.current!;
    if (!draftState.reviewOpen && !draftState.pendingNavigation) element.showModal();
    return () => element.close();
  }, [draftState.reviewOpen, draftState.pendingNavigation]);
  let problem: CreationValidationError | undefined;
  try { readCreationRequest({ kind: entry.resourceKind, ...entry.form }); }
  catch (error) { if (error instanceof CreationValidationError) problem = error; }
  const fields = creator.fields.filter((field) => {
    const lambda = entry.resourceKind === "function" || entry.resourceKind === "route";
    if (!lambda) return true;
    if (entry.form.category === "event" && ["path", "method", "auth", "deploy"].includes(field.key)) return false;
    if (entry.form.category === "webSocket" && ["method", "auth"].includes(field.key)) return false;
    if (entry.resourceKind === "route" && entry.form.existingTarget && !["id", "description", "category", "path", "method", "existingTarget"].includes(field.key)) return false;
    return true;
  });
  const render = (field: CreationField) => {
    const id = `${prefix}-${field.key}`;
    const serverError = draftState.error?.startsWith(`${field.key}: `) ? draftState.error.slice(field.key.length + 2) : undefined;
    const error = problem?.field === field.key ? problem.message : serverError;
    const value = entry.form[field.key];
    const update = (next: string | number | boolean) => {
      const form = { ...entry.form, [field.key]: next };
      const envName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
      const route = (name: string, category: unknown) => entry.resourceKind === "service" ? `/${name}/*` : category === "webSocket" ? name : `/${name}`;
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
    const options = field.key === "bindingResource" ? ["", ...model.resources.filter((resource) => resource.kind === "input" || resource.kind === "secret").map((resource) => resource.id)]
      : field.key === "consumer" ? ["", ...model.targets.map((target) => target.ref)]
      : field.key === "existingTarget" ? ["", ...model.targets.filter((target) => target.kind === "lambda" && target.role === entry.form.category).map((target) => target.ref)] : field.options;
    const appendOptions = field.key === "steps" ? model.targets.filter((target) => target.kind === "task" || target.role === "event").map((target) => target.ref)
      : field.key === "tools" ? model.targets.filter((target) => target.role === "tool" && (entry.form.auth || !target.auth)).map((target) => target.id) : undefined;
    return <div className={`creation-field ${field.type === "boolean" ? "creation-switch" : ""}`} key={field.key}>
      <label htmlFor={id}>{field.label}</label>
      {field.type === "boolean" ? <input id={id} type="checkbox" checked={value === true} onChange={(event) => update(event.target.checked)} />
        : options ? <select id={id} value={String(value)} onChange={(event) => update(event.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : `${id}-help`}>
          {options.map((option) => <option key={option} value={option}>{option || "None"}</option>)}
        </select>
          : <input id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => update(field.type === "number" ? Number(event.target.value) : event.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : `${id}-help`} autoComplete="off" spellCheck={false} />}
      {appendOptions ? <select aria-label={`Add ${field.key === "steps" ? "workflow step" : "agent tool"}`} value="" onChange={(event) => {
        if (event.target.value) update([String(value), event.target.value].filter(Boolean).join(", "));
      }}><option value="">Select an existing {field.key === "steps" ? "target" : "tool"}…</option>{appendOptions.filter((option) => !String(value).split(",").map((part) => part.trim()).includes(option)).map((option) => <option key={option} value={option}>{option}</option>)}</select> : null}
      {field.help ? <p id={`${id}-help`} className="small muted">{field.help}</p> : null}
      {error ? <p id={`${id}-error`} className="reason small" role="status">{error}</p> : null}
    </div>;
  };
  return <dialog ref={dialog} className="preview creation-wizard" aria-labelledby={`${prefix}-title`} onCancel={(event) => { event.preventDefault(); back(); }}>
    <header><p className="small muted">Add to application · Configure → Review → Apply</p><h2 id={`${prefix}-title`}>{entry.resourceKind === "vpc" ? "Configure shared VPC" : `Create ${creator.label.toLowerCase()}`}</h2></header>
    <div className="body">
      <p>{creator.help}</p>
      <div className="creation-fields">{fields.filter((field) => !field.advanced).map(render)}</div>
      {fields.some((field) => field.advanced) ? <details><summary>Advanced settings</summary><div className="creation-fields">{fields.filter((field) => field.advanced).map(render)}</div></details> : null}
      {draft.conflict ? <p className="reason" role="alert">Source changed while you were configuring this resource. Your form is preserved; discard it to load the latest configuration.</p> : null}
      {draftState.error ? <p className="reason" role="alert">{draftState.error}</p> : null}
      <p className="small muted">Review shows every proposed file before anything is written. Apply saves source; deployment is a separate action.</p>
    </div>
    <footer><button className="quiet" onClick={back}>Back to resource types</button><button className="quiet" onClick={() => draft.discard()}>Cancel creation</button><button className="primary" disabled={draft.invalid || draft.conflict || !!draftState.busy} onClick={() => void draft.review()}>Review generated changes</button></footer>
  </dialog>;
}
