import { NetworkControls } from "./NetworkControls";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { catalogAvailability } from "../deployment";
import { buildScene } from "../scene/build";
import { useStudio } from "../studio";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";
import { InfrastructurePanel } from "./Infrastructure";
import { SharedDefaults } from "./SharedDefaults";
import { ResourceStatus } from "./ResourceStatus";
import { RouteStatus } from "./RouteStatus";
import { Description } from "./Description";
import { ClientEnvironmentMappings } from "./ClientEnvironment";
import { CLIENT_ENVIRONMENT_ISLAND } from "../../shared/client-environment";

const LAMBDAS = ["lambda", "http", "webSocket", "events", "tools"];
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "island:apis": ["http", "webSocket", "container"],
  "island:lambda": LAMBDAS,
  "island:agentcore": ["tools"],
};

/**
 * The CDK environment files island: which of `.env.dev` and `.env.prod` exist,
 * and one action to generate the missing ones from their tracked templates.
 * Generation is explicit and exclusive; it never overwrites a file or reads one.
 */
function EnvironmentFiles() {
  const { model, select, draft } = useStudio();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const files = model.resources.flatMap((resource) => resource.deploymentFile ? [resource.deploymentFile] : []);
  const missing = files.filter((file) => !file.exists);
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const generate = async () => {
    setBusy(true); setError("");
    try { for (const file of missing) await api.createDeploymentInput(file.mode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not generate the inputs files."); }
    finally { await client.invalidateQueries({ queryKey: ["snapshot"] }); setBusy(false); }
  };
  return <section><h3>Files</h3>
    <ul className="island-members">{files.map((file) => <li key={file.mode}>
      <button className="linkish" onClick={() => select(`envfile:${file.mode}`)}>{file.path}</button>
      <span className="small muted">{file.exists ? "exists" : "not generated"}</span>
    </li>)}</ul>
    {missing.length ? <>
      <p className="small">{missing.map((file) => name(file.path)).join(" and ")} {missing.length === 1 ? "does" : "do"} not exist, so commands for {missing.length === 1 ? "that environment" : "those environments"} run on the declared defaults. Generate copies {missing.length === 1 ? "it" : "each"} from {missing.map((file) => name(file.template)).join(" and ")}; an existing file is never overwritten.</p>
      <button className="button" disabled={busy || draft.dirty} onClick={() => void generate()}>{busy ? "Generating…" : `Generate ${missing.map((file) => name(file.path)).join(" and ")}`}</button>
    </> : <p className="small muted">Both files exist. Select one to edit its variables.</p>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

/** Island membership comes from the same layout as the canvas, never a second graph. */
export function IslandInspector({ id }: { readonly id: string }) {
  const { model, snapshot, select, index, mode } = useStudio();
  const scene = useMemo(() => buildScene(model, {
    webSocketApi: snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(snapshot.models),
    conditions: Object.fromEntries(Object.entries(snapshot.source.catalog).map(([key, value]) => [key, value.condition])),
  }), [model, snapshot.webSocketApi, snapshot.models, snapshot.source.catalog]);
  const island = scene.islands.find((island) => island.id === id);
  const members = scene.nodes.filter((node) => node.island === id);
  const groups = GROUPS[id] ?? [];
  if (!island) return <p className="empty">This island has no entries in this environment.</p>;
  const entries = <InspectorDisclosure title="Island entries" count={members.length}><ul className="island-members">{members.map((node) => {
    const route = index.routes.get(node.id);
    return <li key={node.id}><button className="linkish" onClick={() => select(node.id)}>{node.label}</button><span className="small muted">{node.kindLabel}</span><ResourceStatus resource={index.resources.get(node.id)} />{route ? <RouteStatus route={route} /> : null}</li>;
  })}</ul></InspectorDisclosure>;
  return <>
    <header><span className="kind">Island settings</span><h2>{island.title}</h2><p className="small muted">{members.length} {members.length === 1 ? "entry" : "entries"}</p></header>
    <Description entity={id} />
    <NetworkControls id={id} />
    {id === "island:environment" ? <EnvironmentFiles /> : null}
    {id === CLIENT_ENVIRONMENT_ISLAND ? <ClientEnvironmentMappings /> : null}
    {id === "island:stacks" ? entries : null}
    {id === "island:stacks" ? <InspectorSection title="CDK infrastructure"><InfrastructurePanel key={mode} onNavigate={select} /></InspectorSection> : null}
    {groups.length ? <SharedDefaults families={groups} note={id === "island:agentcore" ? "These defaults configure Lambda tools used by agents. AgentCore runtimes have individual settings." : undefined} /> : id.startsWith("island:vpc:") || id === "island:environment" || id === "island:stacks" || id === CLIENT_ENVIRONMENT_ISLAND ? null : <section><h3>Settings</h3><p className="small">The framework has no shared defaults for this island. Select an entry below to configure it.</p></section>}
    {id !== "island:stacks" ? entries : null}
  </>;
}
