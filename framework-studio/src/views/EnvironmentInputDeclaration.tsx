import { useId } from "react";
import { creationDefaults } from "../../shared/creation";
import { isFrameworkManagedResource } from "../../shared/framework-management";
import type { ModelResource } from "../../shared/model";
import { sourceEditBlocked } from "../editing-state";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";

/** Only declaration metadata enters the ordinary source review; environment values stay private. */
export function EnvironmentInputDeclaration({ name, resources, cancel }: {
  readonly name: string;
  readonly resources: ReadonlyMap<string, ModelResource>;
  readonly cancel: () => void;
}) {
  const { draft, draftState, model, index, live } = useStudio();
  const prefix = useId();
  const entry = draft.creation();
  if (entry?.environmentVariable !== name) return null;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const groups = [...resources.values()].filter(resource => resource.kind === "group" && resource.path.length === 1 && !isFrameworkManagedResource(resource, resources))
    .sort((a, b) => titleOf(index, a.id).localeCompare(titleOf(index, b.id)));
  return (
    <div className="grid min-w-0 gap-3" data-slot="environment-input-declaration" aria-label={`Declare ${name}`}>
      <label className="grid gap-1 text-label font-medium" htmlFor={`${prefix}-name`}>
        Name
        <TextInput id={`${prefix}-name`} autoFocus autoComplete="off" spellCheck={false} value={String(entry.form.id)} disabled={disabled}
          onChange={event => draft.setCreation(entry.resourceKind, { ...entry.form, id: event.target.value })} />
      </label>
      <label className="grid gap-1 text-label font-medium" htmlFor={`${prefix}-type`}>
        Type
        <Select id={`${prefix}-type`} value={entry.resourceKind} disabled={disabled} onChange={event => {
          const kind = event.target.value === "secret" ? "secret" : "input";
          draft.setCreation(kind, { ...creationDefaults(kind), id: entry.form.id, envName: name, group: entry.form.group });
        }}>
          <option value="input">Input parameter</option>
          <option value="secret">Secret</option>
        </Select>
      </label>
      <label className="grid gap-1 text-label font-medium" htmlFor={`${prefix}-group`}>
        Input group
        <Select id={`${prefix}-group`} value={String(entry.form.group)} disabled={disabled}
          onChange={event => draft.setCreation(entry.resourceKind, { ...entry.form, group: event.target.value })}>
          <option value="">Standalone</option>
          {groups.map(group => <option key={group.id} value={group.path[0]}>{titleOf(index, group.id)}</option>)}
        </Select>
      </label>
      {entry.error ? <p role="status" className="m-0 text-caption text-refuse wrap-anywhere">{entry.error}</p> : null}
      <p className="m-0 text-caption text-graphite">Links to {name}. Existing values stay in their environment files. Review Changes to create the declaration.</p>
      <button className={buttonClasses({ variant: "link" })} disabled={!!draftState.busy} onClick={cancel}>Cancel declaration</button>
    </div>
  );
}
