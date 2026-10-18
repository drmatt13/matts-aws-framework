import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelResource } from "../../shared/model";
import type { ResourceDetails, ResourceIntent } from "../../shared/resources";
import { api } from "../api";
import { useStudio } from "../studio";
import { RequirementNotice } from "./InputRequirement";

export function ResourceEditor({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, mode, model, live, select, toast, draft, draftState } = useStudio();
  const query = useQueryClient();
  const [details, setDetails] = useState<ResourceDetails>();
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setRevealed(false);
    setError(undefined);
    setBusy(false);
    if (!resource.absent && !model.stale) {
      void api.resourceDetails(resource.id, mode, controller.signal).then((details) => { if (!controller.signal.aborted) setDetails(details); }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load this input.");
      });
    }
    return () => controller.abort();
  }, [resource, snapshot.revision, mode, model.stale]);

  const form = draft.resourceForm(resource);
  const { secret, fallback, hasDefault, group, requirements } = form;
  const update = (change: Partial<typeof form>) => draft.setResource(resource, { ...form, ...change });
  const setSecret = (secret: boolean) => update({ secret });
  const setFallback = (fallback: string) => update({ fallback });
  const setHasDefault = (hasDefault: boolean) => update({ hasDefault });
  const setGroup = (group: string) => update({ group });
  const setRequirements = (change: (current: ResourceIntent["requirements"]) => ResourceIntent["requirements"]) => update({ requirements: change(requirements) });
  const entry = draftState.entries.find((entry) => entry.kind === "resource" && entry.intent.resource === resource.id);
  const descriptionPending = draftState.entries.some((entry) => entry.kind === "description");
  const disabled = busy || !!draftState.busy || live.evaluating || live.running !== null || model.stale || resource.absent || descriptionPending;
  const write = async (direction: "undo" | "redo") => {
    setBusy(true); setError(undefined);
    try {
      const result = await api.resourceHistory(direction);
      toast(result.message, result.status === "applied" ? "plain" : "refuse");
      if (result.resource !== resource.id) select(result.resource);
      await query.invalidateQueries({ queryKey: ["snapshot"] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not restore this edit."); }
    finally { setBusy(false); }
  };
  return <>
    <section className="resource-editor">
      <h3>Local value</h3>
      <RequirementNotice requirement={resource.inputRequirement} />
      {resource.inputRequirement?.required ? <button className="linkish small" onClick={() => select(`envfile:${mode}`)}>Edit .env.{mode}</button> : null}
      <div className="resource-value">
        <code>{resource.fromEnv}</code>
        {resource.absent ? <p className="muted">Not declared in this graph.</p> : details ? <>
          <p className="small muted">Source: {details.file ?? "cdk-app/.env"}</p>
          <pre className="env-value">{details.configured ? resource.kind === "secret" && !revealed ? "••••••••••••" : details.value === "" ? "(empty)" : details.value : `Not set in ${details.file ?? "cdk-app/.env"}`}</pre>
          {resource.kind === "secret" && details.configured ? <button className="quiet" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>{revealed ? "Hide value" : "Reveal value"}</button> : null}
          {!details.configured && resource.default !== undefined ? <p className="small muted">Using default: <code>{resource.default}</code></p> : null}
        </> : <p className="small muted" role="status">{model.stale ? "Unavailable until the configuration loads." : "Reading cdk-app/.env…"}</p>}
      </div>
    </section>
    <section className="resource-editor">
      <h3>Configuration</h3>
      {descriptionPending ? <p className="small muted">Apply or discard the description before editing input settings.</p> : null}
      <fieldset disabled={disabled}>
        <label className="resource-check"><input type="checkbox" checked={form.required ?? !!resource.required} onChange={(event) => update({ required: event.target.checked })} />Required input</label>
        <p className="small muted">Every enabled consumer must receive a value. A non-blank environment value{secret ? " is required for a secret" : " or parameter default satisfies it"}. This flag also marks unfilled catalog inputs on the map.</p>
        <label className="resource-check"><input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />Secret</label>
        <p className="small muted">{secret ? "Uploaded to Secrets Manager at deployment. The value belongs in cdk-app/.env." : "Read as a regular string from cdk-app/.env."}</p>
        <label className="resource-check"><input type="checkbox" checked={!secret && hasDefault} disabled={secret} onChange={(event) => setHasDefault(event.target.checked)} />Default value</label>
        {!secret && hasDefault ? <label className="resource-control"><span className="sr-only">Default value</span>{resource.values ? <select aria-label="Default value" value={fallback} onChange={(event) => setFallback(event.target.value)}><option value="" disabled>Choose a default</option>{resource.values.map((value) => <option key={value}>{value}</option>)}</select> : <input aria-label="Default value" value={fallback} onChange={(event) => setFallback(event.target.value)} />}</label> : null}
        {secret ? <p className="small muted">Secrets have no source-code default.</p> : null}
        <label className="resource-control"><span>Group</span><input aria-label="Resource group" list="resource-groups" value={group} placeholder="Ungrouped" onChange={(event) => setGroup(event.target.value)} /><datalist id="resource-groups">{model.resources.filter((item) => item.kind === "group").map((item) => <option key={item.id} value={item.path[0]} />)}</datalist></label>
        <p className="small muted">Leave empty for no group. Moving an input updates references and preserves its environment variable name.</p>
        <h4>Required to deploy</h4>
        {details?.consumers.length ? details.consumers.map((consumer) => {
          const rules = consumer.rules.filter((rule) => rule.require.includes(resource.id));
          const summary = rules.length ? rules.map((rule) => rule.when ? `When ${rule.when.resource.slice(9)} = ${JSON.stringify(rule.when.equals)}` : "Required").join("; ") : "Optional";
          return <label key={consumer.target} className="resource-control"><span>{consumer.title}</span><select aria-label={`Deployment requirement for ${consumer.title}`} value={requirements[consumer.target] ?? "preserve"} onChange={(event) => setRequirements((current) => {
            const next = { ...current };
            if (event.target.value === "preserve") delete next[consumer.target];
            else next[consumer.target] = event.target.value as "required" | "optional";
            return next;
          })} disabled={form.required ?? !!resource.required}><option value="preserve">Keep current: {summary}</option><option value="required">Required</option><option value="optional">Optional</option></select></label>;
        }) : <p className="small muted">No workload consumes this input. Application stacks may have their own requirements.</p>}
        <p className="small muted">{(form.required ?? resource.required) ? "The catalog-wide flag requires this input for all consumers. Turn it off to manage individual or conditional workload rules." : "Requirements apply to enabled workloads in each graph. Conditional rules stay as declared unless you change them here."}</p>
      </fieldset>
      {error || entry?.error ? <p className="reason" role="alert">{error ?? entry?.error}</p> : null}
      <div className="resource-actions">
        {details?.history.undo ? <button className="quiet" disabled={disabled || draft.dirty} onClick={() => void write("undo")}>Undo resource edit</button> : null}
        {details?.history.redo ? <button className="quiet" disabled={disabled || draft.dirty} onClick={() => void write("redo")}>Redo resource edit</button> : null}
      </div>
    </section>
  </>;
}
