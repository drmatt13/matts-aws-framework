import { useState } from "react";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { FieldRow } from "./FieldRow";

/** Global defaults appear beside the resource family they configure. */
export function SharedDefaults({ families, title = "Shared defaults", description = "Applies across all islands and to future entries. Individual overrides take precedence. Select an entry to configure its deployment.", note }: {
  readonly families: readonly string[]; readonly title?: string; readonly description?: string; readonly note?: string;
}) {
  const { model, snapshot } = useStudio();
  const groups = families.flatMap(name => (model.defaults ?? []).filter(group => group.group === name));
  const [chosen, setChosen] = useState(groups[0]?.ref);
  const group = groups.find(group => group.ref === chosen) ?? groups[0];
  if (!group) return null;
  const source = snapshot.source.entities[group.ref]?.value;
  return <section>
    <h3>{title}</h3>
    <p className="small muted">{description}</p>
    {groups.length > 1 ? <label className="island-default-group">Service type<select aria-label="Default service type" value={group.ref} onChange={(event) => setChosen(event.target.value)}>{groups.map((item) => <option key={item.ref} value={item.ref}>{item.title}</option>)}</select></label> : null}
    {note ? <p className="small muted">{note}</p> : null}
    <div className="fields" key={group.ref}>{[...(model.fields[group.ref] ?? [])].sort((a, b) => Number(b.field.endsWith(".deploy")) - Number(a.field.endsWith(".deploy"))).map((fact) => <div key={fact.field}>
      <FieldRow target={group} fact={fact} allowInherit={!!fact.inherited} editability={snapshot.source.editability[group.ref]?.[fact.field]} />
      {fact.usage ? <p className="small muted default-usage">{fact.usage.inherited} inherit · {fact.usage.overridden} overridden</p> : null}
    </div>)}</div>
    {source ? <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>Open shared defaults in VS Code</a> : null}
  </section>;
}
