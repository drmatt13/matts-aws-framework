import { useEffect, useId, useState } from "react";
import type { Mode, ModelResource } from "../../shared/model";
import type { ResourceDetails, ResourceIntent } from "../../shared/resources";
import { api } from "../api";
import { useStudio } from "../studio";
import type { ResourceModeForm } from "../draft";
import { FormGroup, InspectorSwitch } from "./InspectorUI";
import { LocalValue } from "./LocalValue";

const MODES = ["dev", "prod"] as const;
const MODE_NAMES = { dev: "development", prod: "production" } as const;

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
  const { secret, modes, group, requirements } = form;
  const update = (change: Partial<typeof form>) => draft.setResource(resource, { ...form, ...change });
  const setSecret = (secret: boolean) => update({ secret });
  const setMode = (mode: Mode, change: Partial<ResourceModeForm>) => update({ modes: { ...modes, [mode]: { ...modes[mode], ...change } } });
  const setGroup = (group: string) => update({ group });
  const requiredEverywhere = MODES.every((mode) => !modes[mode].present || modes[mode].required);
  const setRequirements = (change: (current: ResourceIntent["requirements"]) => ResourceIntent["requirements"]) => update({ requirements: change(requirements) });
  const entry = draftState.entries.find((entry) => entry.kind === "resource" && entry.intent.resource === resource.id);
  const descriptionPending = draftState.entries.some((entry) => entry.kind === "description");
  const environmentPending = draftState.entries.some((entry) => entry.kind === "environment");
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || live.running !== null || model.stale || descriptionPending || environmentPending;
  return <>
    <LocalValue resource={resource} details={details} error={detailsError} busy={!!draftState.busy} onRetry={() => setReload((value) => value + 1)} />
    {/* Its first group's legend heads the section; a generic "Configuration" heading above it said nothing more. */}
    <section className="resource-editor" aria-label="Input settings">
      {descriptionPending ? <p className="small muted">Apply or discard the description before editing input settings.</p> : null}
      {environmentPending ? <p className="small muted">Apply or discard local value changes before editing input settings.</p> : null}
      <fieldset disabled={disabled}><FormGroup title="Input behavior">
        <table className="input-modes" aria-describedby={`${help}-modes`}>
          <thead><tr><td /><th scope="col">Dev</th><th scope="col">Prod</th></tr></thead>
          <tbody>
            <tr><th scope="row">Present</th>{MODES.map((mode) => <td key={mode}><input type="checkbox" aria-label={`Present in ${MODE_NAMES[mode]}`} checked={modes[mode].present} onChange={(event) => setMode(mode, { present: event.target.checked })} /></td>)}</tr>
            <tr><th scope="row">Required</th>{MODES.map((mode) => <td key={mode}><input type="checkbox" aria-label={`Required in ${MODE_NAMES[mode]}`} disabled={!modes[mode].present} checked={modes[mode].present && modes[mode].required} onChange={(event) => setMode(mode, { required: event.target.checked })} /></td>)}</tr>
            {!secret ? <tr><th scope="row">Default</th>{MODES.map((mode) => <td key={mode}>{resource.values
              ? <select aria-label={`Default in ${MODE_NAMES[mode]}`} disabled={!modes[mode].present} value={modes[mode].present ? modes[mode].default : ""} onChange={(event) => setMode(mode, { default: event.target.value })}><option value="">None</option>{resource.values.map((value) => <option key={value}>{value}</option>)}</select>
              : <input aria-label={`Default in ${MODE_NAMES[mode]}`} disabled={!modes[mode].present} value={modes[mode].present ? modes[mode].default : ""} placeholder="None" onChange={(event) => setMode(mode, { default: event.target.value })} />}</td>)}</tr> : null}
          </tbody>
        </table>
        <p id={`${help}-modes`} className="small muted">An environment without the input never reads it. A required input needs a value in that environment's file, or a default. {secret ? "Secrets have no defaults." : "A default stands in when the file leaves the value blank."}</p>
        <div className="setting-switch"><label htmlFor={`${help}-secret-switch`}>Secret</label><InspectorSwitch id={`${help}-secret-switch`} label="Secret" describedBy={`${help}-secret`} checked={secret} onChange={setSecret} /></div>
        <p id={`${help}-secret`} className="small muted">Store the value from cdk-app/.env.{mode} in Secrets Manager at deployment. Turn off to use a regular string.</p>
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
          })} disabled={requiredEverywhere}><option value="preserve">Keep current: {summary}</option><option value="required">Required</option><option value="optional">Optional</option></select></label>;
        }) : <p className="small muted">No workload consumes this input. Application stacks may have their own requirements.</p>}
        <p className="small muted">{requiredEverywhere ? "Required in every environment it is in, so every consumer needs it. Clear Required to set individual workload rules." : "Required applies to every consumer in that environment. Conditional rules stay as declared unless changed here."}</p>
      </FormGroup></fieldset>
      {entry?.error ? <p className="reason" role="alert">{entry.error}</p> : null}

    </section>
  </>;
}
