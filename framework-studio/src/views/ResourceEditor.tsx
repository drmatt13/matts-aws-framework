import { useEffect, useId, useState } from "react";
import type { ModelResource } from "../../shared/model";
import type { ResourceDetails, ResourceIntent } from "../../shared/resources";
import { api } from "../api";
import { useStudio } from "../studio";
import { FormGroup, InspectorSwitch } from "./InspectorUI";
import { LocalValue } from "./LocalValue";

export function ResourceEditor({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, mode, model, live, draft, draftState } = useStudio();
  const help = useId();
  const [details, setDetails] = useState<ResourceDetails>();
  const [detailsError, setDetailsError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setDetailsError(undefined);
    if (!resource.absent && !model.stale) {
      void api.resourceDetails(resource.id, mode, controller.signal).then((details) => { if (!controller.signal.aborted) setDetails(details); }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setDetailsError(reason instanceof Error ? reason.message : "Could not load this input.");
      });
    }
    return () => controller.abort();
  }, [resource, snapshot.revision, mode, model.stale, reload]);

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
  const environmentPending = draftState.entries.some((entry) => entry.kind === "environment");
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || live.running !== null || model.stale || resource.absent || descriptionPending || environmentPending;
  return <>
    <LocalValue resource={resource} details={details} error={detailsError} busy={!!draftState.busy} onRetry={() => setReload((value) => value + 1)} />
    {/* Its first group's legend heads the section; a generic "Configuration" heading above it said nothing more. */}
    <section className="resource-editor" aria-label="Input settings">
      {descriptionPending ? <p className="small muted">Apply or discard the description before editing input settings.</p> : null}
      {environmentPending ? <p className="small muted">Apply or discard local value changes before editing input settings.</p> : null}
      <fieldset disabled={disabled}><FormGroup title="Input behavior">
        <div className="setting-switch"><label htmlFor={`${help}-required-switch`}>Required input</label><InspectorSwitch id={`${help}-required-switch`} label="Required input" describedBy={`${help}-required`} checked={form.required ?? !!resource.required} onChange={required => update({ required })} /></div>
        <p id={`${help}-required`} className="small muted">Require a non-blank value for every enabled consumer.</p>
        <div className="setting-switch"><label htmlFor={`${help}-secret-switch`}>Secret</label><InspectorSwitch id={`${help}-secret-switch`} label="Secret" describedBy={`${help}-secret`} checked={secret} onChange={setSecret} /></div>
        <p id={`${help}-secret`} className="small muted">Store the value from cdk-app/.env.{mode} in Secrets Manager at deployment. Turn off to use a regular string.</p>
        <div className="setting-switch"><label htmlFor={`${help}-default-switch`}>Default value</label><InspectorSwitch id={`${help}-default-switch`} label="Default value" describedBy={`${help}-default`} checked={!secret && hasDefault} disabled={secret} onChange={setHasDefault} /></div>
        <label className="resource-control"><span className="sr-only">Default value</span>{resource.values ? <select aria-label="Default value" aria-describedby={`${help}-default`} disabled={secret || !hasDefault} value={fallback} onChange={(event) => setFallback(event.target.value)}><option value="" disabled>Choose a default</option>{resource.values.map((value) => <option key={value}>{value}</option>)}</select> : <input aria-label="Default value" aria-describedby={`${help}-default`} disabled={secret || !hasDefault} value={fallback} placeholder="No default" onChange={(event) => setFallback(event.target.value)} />}</label>
        <p id={`${help}-default`} className="small muted">Used when no local value is supplied. Secrets cannot have defaults.</p>
        <label className="resource-control"><span>Group</span><input aria-label="Resource group" aria-describedby={`${help}-group`} list={`${help}-groups`} value={group} placeholder="Ungrouped" onChange={(event) => setGroup(event.target.value)} /><datalist id={`${help}-groups`}>{model.resources.filter((item) => item.kind === "group").map((item) => <option key={item.id} value={item.path[0]} />)}</datalist></label>
        <p id={`${help}-group`} className="small muted">Leave empty for no group. Moving an input updates references and preserves its environment variable name.</p>
        </FormGroup><FormGroup title="Workload requirements">
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
        <p className="small muted">Required input applies to every enabled consumer. Turn it off to edit individual workload rules. Conditional rules stay as declared unless changed here.</p>
      </FormGroup></fieldset>
      {entry?.error ? <p className="reason" role="alert">{entry.error}</p> : null}

    </section>
  </>;
}
