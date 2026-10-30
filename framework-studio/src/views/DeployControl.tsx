import { Select, TextInput } from "../ui/FormControls";
import { cx } from "../ui/classes";
import { inspectorStackedFieldClasses, inspectorLabelClasses, inspectorControlClasses, inspectorFullWidthHelpClasses } from "../inspector-ui";
import { useId } from "react";
import type { DeployValue } from "../../shared/api";
import type { ModelTarget } from "../../shared/model";
import { deploymentSettingLabel } from "../deployment";
import { useStudio } from "../studio";

export function DeployControl({ target }: { readonly target: ModelTarget }) {
  const { model, snapshot, draft, draftState, live } = useStudio();
  const id = useId();
  const editability = snapshot.source.editability[target.ref]?.deploy;
  const locked = !editability || !["literal", "absent", "condition"].includes(editability.kind);
  const entry = draftState.entries.find(entry => entry.kind === "operation" && entry.operation.kind === "deploy" && entry.operation.target === target.ref);
  const operation = entry?.kind === "operation" && entry.operation.kind === "deploy" ? entry.operation : undefined;
  const saved = target.lanes.when;
  const value: DeployValue = operation?.value ?? (target.lanes.origin === "derived" ? "inherit" : saved ? { when: { resource: saved.resource, equals: saved.equals } } : target.lanes.origin === "default" ? "inherit" : target.lanes.deploy);
  const inputs = snapshot.models.dev.resources.filter(resource => resource.kind === "input" && (resource.fromEnv || resource.authoredValue !== undefined) && !resource.absent && snapshot.models.prod.resources.some(other => other.id === resource.id && other.kind === "input" && (other.fromEnv || other.authoredValue !== undefined) && !other.absent));
  const condition = typeof value === "string" ? undefined : value.when;
  const input = inputs.find(input => input.id === condition?.resource);
  const disabled = locked || model.stale || draft.conflict || !!draftState.busy || live.evaluating;
  const errorId = entry?.error ? `${id}-error` : undefined;
  const statusId = locked || model.stale || draft.conflict ? `${id}-status` : undefined;
  const describedBy = [errorId, statusId].filter(Boolean).join(" ") || undefined;
  const outcome = (result: "holds" | "fails" | "unset" | undefined) => result === "holds" ? "Matches" : result === "unset" ? "Unset · disabled" : "Does not match";
  const stage = (next: DeployValue) => draft.stageOperation({ kind: "deploy", target: target.ref, value: next });
  return <div className="grid min-w-0 gap-3 [&>p]:m-0 [&_[data-slot=field-label]]:pt-0" data-slot="deploy-control">
    <div className={cx(inspectorStackedFieldClasses, operation ? "[&_[data-slot=field-label]]:after:content-['_•'] [&_[data-slot=field-label]]:after:text-dev" : "")} data-slot="field"><label className={inspectorLabelClasses} htmlFor={id} data-slot="field-label">Deploy</label><span className={inspectorControlClasses} data-slot="control"><Select id={id} aria-label="Deploy" aria-describedby={describedBy} disabled={disabled} value={condition ? "conditional" : String(value)} onChange={event => {
      const next = event.target.value;
      if (next === "conditional") { const first = inputs[0]; if (first) stage({ when: { resource: first.id, equals: first.values?.[0] ?? "" } }); }
      else stage(next as DeployValue);
    }}>
      {["both", "local-only", "cloud-only", "none"].map(setting => <option key={setting} value={setting}>{deploymentSettingLabel(setting, model.deployChoices?.[target.role]?.[setting])}</option>)}
      <option value="inherit">{target.role === "tool" ? "Inherit · consuming agents" : "Inherit · Dev + Prod"}</option>
      <option value="conditional" disabled={!inputs.length}>Only when an input matches…</option>
    </Select></span></div>
    {condition ? <fieldset className={"grid min-w-0 gap-3 m-0 p-3 border border-rule rounded-md [&_legend]:p-[0_var(--space-1)] [&_legend]:text-graphite [&_legend]:text-caption"} data-slot="deploy-condition"><legend>Condition</legend>
      <div className={inspectorStackedFieldClasses} data-slot="field"><label className={inspectorLabelClasses} htmlFor={`${id}-input`} data-slot="field-label">Input parameter</label><span className={inspectorControlClasses} data-slot="control"><Select id={`${id}-input`} title={input ? `${input.path.join(".")} · ${input.fromEnv ?? "Value in source"}` : condition.resource} aria-describedby={[input ? `${id}-input-help` : undefined, describedBy].filter(Boolean).join(" ") || undefined} disabled={disabled} value={condition.resource} onChange={event => { const next = inputs.find(item => item.id === event.target.value)!; stage({ when: { resource: next.id, equals: next.values?.[0] ?? "" } }); }}>{inputs.map(input => <option key={input.id} value={input.id}>{input.path.join(".")}</option>)}</Select></span>
        {input ? <span className={inspectorFullWidthHelpClasses} id={`${id}-input-help`} data-slot="note">{input.fromEnv ? <>Environment variable <code>{input.fromEnv}</code></> : "Value defined in source."}</span> : null}
      </div>
      <div className={inspectorStackedFieldClasses} data-slot="field"><label className={inspectorLabelClasses} htmlFor={`${id}-equals`} data-slot="field-label">Equals</label><span className={inspectorControlClasses} data-slot="control">{input?.values ? <Select id={`${id}-equals`} aria-invalid={!!entry?.error} aria-describedby={[`${id}-equals-help`, describedBy].filter(Boolean).join(" ")} disabled={disabled} value={condition.equals} onChange={event => stage({ when: { ...condition, equals: event.target.value } })}>{input.values.map(value => <option key={value} value={value}>{value}</option>)}</Select> : <TextInput id={`${id}-equals`} aria-invalid={!!entry?.error} aria-describedby={[`${id}-equals-help`, describedBy].filter(Boolean).join(" ")} disabled={disabled} value={condition.equals} onChange={event => stage({ when: { ...condition, equals: event.target.value } })} />}</span>
        <span className={inspectorFullWidthHelpClasses} id={`${id}-equals-help`} data-slot="note">Enable only when the input exactly matches this value.</span>
      </div>
      <div className={"grid min-w-0 gap-1 border-t border-rule pt-2 [&>span]:flex [&>span]:flex-wrap [&>span]:justify-between [&>span]:gap-[var(--space-1)_var(--space-3)] [&_strong]:font-medium text-caption text-graphite"} aria-live="polite" data-slot="deploy-condition-status">{operation ? <p>Review Changes checks this condition in each environment.</p> : <><span><strong>Development</strong> {outcome(saved?.dev)}</span><span><strong>Production</strong> {outcome(saved?.prod)}</span></>}</div>
    </fieldset> : null}
    {entry?.error ? <p className={"text-refuse wrap-anywhere text-caption"} id={errorId} role="alert">{entry.error}</p> : null}
    {statusId ? <p className={"text-caption text-graphite"} id={statusId}>{model.stale ? "Editing is paused until the configuration loads again." : draft.conflict ? "Source changed. Review the source conflict before editing." : "This Deploy expression is source-owned. Edit it in your editor."}</p> : null}
  </div>;
}
