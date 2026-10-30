import { displayName } from "../naming";
import { Select } from "../ui/FormControls";
import { cx } from "../ui/classes";
import { inspectorStackedFieldClasses, inspectorLabelClasses, inspectorControlClasses, inspectorFullWidthHelpClasses } from "../inspector-ui";
import { useId } from "react";
import type { ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";

/** Whether each input or secret this workload reads must have a value before it deploys.
 * The rules are the workload's own `cloud.requirements`, so they are edited here, not on the input. */
export function RequiredInputs({ target }: { readonly target: ModelTarget }) {
  const { model, draft, draftState, live } = useStudio();
  const id = useId();
  const rules = target.requirementRules ?? [];
  const reads = new Set([
    ...target.environment.flatMap(entry => entry.value.kind === "reference" ? [entry.value.resource] : []),
    ...target.secrets.map(entry => entry.resource),
    ...rules.flatMap(rule => rule.require),
  ]);
  const inputs = model.resources.filter(resource => (resource.kind === "input" || resource.kind === "secret") && !resource.absent && reads.has(resource.id));
  if (!inputs.length) return null;
  // A requirement is staged with its input's settings, which wait for these to apply.
  const pending = draftState.entries.some(entry => entry.kind === "environment");
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || live.running !== null || model.stale || pending;
  return <fieldset className={"grid min-w-0 gap-3 m-0 p-0 border-0 [&>legend]:p-0 [&>legend]:mb-3 [&>legend]:text-label [&>legend]:font-medium [&>p]:m-0"} disabled={disabled} aria-describedby={`${id}-help`} data-slot="required-inputs"><legend>Required inputs</legend>
    {inputs.map((resource, index) => {
      const own = rules.filter(rule => rule.require.includes(resource.id));
      const saved = own.some(rule => !rule.when) ? "required" : own.length ? "conditional" : "optional";
      const form = draft.resourceForm(resource);
      const always = (["dev", "prod"] as const).every(mode => !form.modes[mode].present || form.modes[mode].required);
      const staged = always ? undefined : form.requirements[target.ref];
      const field = `${id}-${index}`;
      const change = (value: string) => {
        const requirements = { ...form.requirements };
        if (value === saved) delete requirements[target.ref];
        else if (value === "required" || value === "optional") requirements[target.ref] = value;
        draft.setResource(resource, { ...form, requirements });
      };
      return <div key={resource.id} className={cx(inspectorStackedFieldClasses, staged ? "[&_[data-slot=field-label]]:after:content-['_•'] [&_[data-slot=field-label]]:after:text-dev" : "")} data-slot="field">
        <label className={inspectorLabelClasses} htmlFor={field} data-slot="field-label">{displayName(model, resource.id, resource.path.join("."))}</label>
        <span className={inspectorControlClasses} data-slot="control"><Select id={field} value={always ? "required" : staged ?? saved} disabled={always} onChange={event => change(event.target.value)}>
          {saved === "conditional" && !always ? <option value="conditional">{own.map(rule => `When ${rule.when!.resource.slice("resource:".length)} equals ${JSON.stringify(rule.when!.equals)}`).join("; ")}</option> : null}
          <option value="required">{always ? "Required by the input" : "Required"}</option>
          {always ? null : <option value="optional">Optional</option>}
        </Select></span>
      </div>;
    })}
    <p className={inspectorFullWidthHelpClasses} id={`${id}-help`}>{pending ? "Apply or discard the pending local values before changing requirements." : "A required input needs a value in that environment's file, or a default, before this workload deploys."}</p>
  </fieldset>;
}
