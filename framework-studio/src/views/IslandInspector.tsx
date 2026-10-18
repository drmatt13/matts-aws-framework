import { useMemo, useState } from "react";
import { catalogAvailability } from "../deployment";
import { editorLink } from "../lookup";
import { buildScene } from "../scene/build";
import { useStudio } from "../studio";
import { BooleanField, FieldRow } from "./FieldRow";
import { ResourceStatus } from "./ResourceStatus";

const LAMBDAS = ["lambda", "http", "webSocket", "events", "tools"];
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "island:apis": ["http", "webSocket", "container"],
  "island:lambda": LAMBDAS,
  "island:vpc": [...LAMBDAS, "container", "database"],
  "island:agentcore": ["tools"],
  "island:local": ["database"],
};

/** Island membership comes from the same layout as the canvas, never a second graph. */
export function IslandInspector({ id }: { readonly id: string }) {
  const { model, snapshot, select, index } = useStudio();
  const scene = useMemo(() => buildScene(model, {
    webSocketApi: snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(snapshot.models),
    conditions: Object.fromEntries(Object.entries(snapshot.source.catalog).map(([key, value]) => [key, value.condition])),
  }), [model, snapshot.webSocketApi, snapshot.models, snapshot.source.catalog]);
  const island = scene.islands.find((island) => island.id === id);
  const members = scene.nodes.filter((node) => node.island === id);
  const groups = (GROUPS[id] ?? []).flatMap((name) => (model.defaults ?? []).filter((group) => group.group === name));
  const [chosen, setChosen] = useState(groups[0]?.ref);
  const group = groups.find((group) => group.ref === chosen) ?? groups[0];
  if (!island) return <p className="empty">This island has no entries in this environment.</p>;
  const source = group && snapshot.source.entities[group.ref]?.value;
  return <>
    <header><span className="kind">Island settings</span><h2>{island.title}</h2><p className="small muted">{members.length} {members.length === 1 ? "entry" : "entries"}</p></header>
    {group ? <section>
      <h3>Shared defaults</h3>
      <p className="small">Defaults apply to this service type across all islands, including future nodes. Individual overrides take precedence.</p>
      <label className="island-default-group">Service type<select aria-label="Default service type" value={group.ref} onChange={(event) => setChosen(event.target.value)}>{groups.map((item) => <option key={item.ref} value={item.ref}>{item.title}</option>)}</select></label>
      {id === "island:agentcore" ? <p className="small muted">These defaults configure Lambda tools used by agents. AgentCore runtimes have individual settings.</p> : null}
      {id === "island:local" ? <p className="small muted">Connection pool defaults configure database callers. The local database container is configured in Compose.</p> : null}
      <div className="fields" key={group.ref}>{(model.fields[group.ref] ?? []).map((fact) => <div key={fact.field}>
        {fact.domain.kind === "enum" && fact.domain.values.includes(true) && fact.domain.values.includes(false)
          ? <BooleanField target={group} fact={fact} editability={snapshot.source.editability[group.ref]?.[fact.field]} />
          : <FieldRow target={group} fact={fact} allowInherit={!!fact.inherited} editability={snapshot.source.editability[group.ref]?.[fact.field]} />}
        {fact.usage ? <p className="small muted default-usage">{fact.usage.inherited} inherit · {fact.usage.overridden} overridden</p> : null}
      </div>)}</div>
      {source ? <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>Open shared defaults in VS Code</a> : null}
    </section> : <section><h3>Settings</h3><p className="small">The framework has no shared defaults for this island. Select an entry below to configure it.</p></section>}
    <section><h3>Island entries</h3><ul className="island-members">{members.map((node) => <li key={node.id}><button className="linkish" onClick={() => select(node.id)}>{node.label}</button><span className="small muted">{node.kindLabel}</span><ResourceStatus resource={index.resources.get(node.id)} /></li>)}</ul></section>
  </>;
}
