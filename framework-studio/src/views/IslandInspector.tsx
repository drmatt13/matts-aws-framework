import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
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
import { Tags } from "./Tags";
import { DeploymentSection, DeploymentOwnership } from "./Deployment";

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
  const unmet = (file: (typeof files)[number]) => file.entries.filter((entry) => entry.default === undefined && entry.status !== "configured" && entry.requirements?.some((item) => item.required)).length;
  const generate = async () => {
    setBusy(true); setError("");
    try { for (const file of missing) await api.createDeploymentInput(file.mode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not generate the inputs files."); }
    finally { await client.invalidateQueries({ queryKey: ["snapshot"] }); setBusy(false); }
  };
  return <section><h3>Files</h3>
    <ul className={"p-0 list-none m-0 [&_li]:grid [&_li]:gap-0.75 [&_li]:p-[10px_0] [&_li]:m-0 [&_li]:border-b [&_li]:border-rule"} data-slot="island-members">{files.map((file) => <li key={file.mode}>
      <button className={buttonClasses({ variant: "link" })} onClick={() => select(`envfile:${file.mode}`)}>{file.path}</button>
      <span className={cx("text-caption", unmet(file) ? "text-refuse wrap-anywhere" : "text-graphite")}>{!file.exists ? "Not generated" : unmet(file) ? `${unmet(file)} required ${unmet(file) === 1 ? "value" : "values"} missing` : `${file.entries.length} variables`}</span>
    </li>)}</ul>
    {missing.length ? <>
      <p className={"text-caption"}>{missing.map((file) => name(file.path)).join(" and ")} {missing.length === 1 ? "does" : "do"} not exist, so commands for {missing.length === 1 ? "that environment" : "those environments"} run on the declared defaults. Generate copies {missing.length === 1 ? "it" : "each"} from {missing.map((file) => name(file.template)).join(" and ")}; an existing file is never overwritten.</p>
      <button className={buttonClasses({ variant: "neutral" })} disabled={busy || draft.dirty} onClick={() => void generate()}>{busy ? "Generating…" : `Generate ${missing.map((file) => name(file.path)).join(" and ")}`}</button>
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

/** Island membership comes from the same layout as the canvas, never a second graph. */
export function IslandInspector({ id }: { readonly id: string }) {
  const { model, snapshot, select, index, mode, draft, draftState, live } = useStudio();
  const scene = useMemo(() => buildScene(model, {
    resourceAvailability: catalogAvailability(snapshot.models),
    conditions: Object.fromEntries(Object.entries(snapshot.source.catalog).map(([key, value]) => [key, value.condition])),
  }), [model, snapshot.models, snapshot.source.catalog]);
  const island = scene.islands.find((island) => island.id === id);
  const members = scene.nodes.filter((node) => node.island === id);
  const resources = catalogAvailability(snapshot.models);
  const groups = GROUPS[id] ?? [];
  const network = id.startsWith("island:vpc:");
  const availability = network
    ? { dev: false, prod: !!snapshot.models.prod.networks?.find(item => id === `island:vpc:${item.id}`)?.builtInProd }
    : { dev: members.some(node => node.lanes ? node.lanes.local || node.lanes.dev : resources[node.id]?.dev), prod: members.some(node => node.lanes ? node.lanes.prod : resources[node.id]?.prod) };
  if (!island) return <p className={"px-6 py-10 text-graphite"}>This island has no entries in this environment.</p>;
  const entries = <InspectorDisclosure title="Island entries" count={members.length}><ul className={"p-0 list-none m-0 [&_li]:grid [&_li]:gap-0.75 [&_li]:p-[10px_0] [&_li]:m-0 [&_li]:border-b [&_li]:border-rule"} data-slot="island-members">{members.map((node) => {
    const route = index.routes.get(node.id);
    return <li key={node.id}><button className={buttonClasses({ variant: "link" })} onClick={() => select(node.id)}>{node.label}</button><span className={"text-caption text-graphite"}>{node.kindLabel}</span><ResourceStatus resource={index.resources.get(node.id)} />{route ? <RouteStatus route={route} /> : null}</li>;
  })}</ul></InspectorDisclosure>;
  return <>
    <header><span className={"text-graphite text-meta font-medium tracking-[.03em]"}>Island settings</span><h2>{island.title}</h2><p className={"text-caption text-graphite"}>{members.length} {members.length === 1 ? "entry" : "entries"}</p></header>
    <Tags entity={id} />
    <Description entity={id} />
    {id !== "island:inputs" && id !== "island:environment" && id !== CLIENT_ENVIRONMENT_ISLAND ? <DeploymentSection availability={availability} locations={network ? { prod: "In AWS" } : undefined}><DeploymentOwnership reason={network ? "Production creates this VPC when its database, native resources or enabled workloads require it. Configure those owners; local Compose networking remains shared." : "This island groups resources. Configure deployment on its entries."} owners={members.filter(node => model.targets.some(target => target.ref === node.id) || model.resources.some(resource => resource.id === node.id)).map(node => ({ id: node.id, title: node.label }))} /></DeploymentSection> : null}
    <NetworkControls id={id} />
    {id === "island:environment" ? <EnvironmentFiles /> : null}
    {id === CLIENT_ENVIRONMENT_ISLAND ? <ClientEnvironmentMappings /> : null}
    {id === "island:inputs" ? <InspectorSection title="Add an input" description="Declare an input parameter or secret, then review the source changes. Environment values are configured separately.">
      <button className={buttonClasses({ variant: "quiet" })} disabled={!!draftState.busy || live.evaluating || Object.values(snapshot.models).some(model => model.stale || model.status === "error")} onClick={() => draft.requestNavigation(() => draft.beginCreation("input"))}>Create input parameter or secret</button>
    </InspectorSection> : null}
    {id === "island:stacks" ? entries : null}
    {id === "island:stacks" ? <InspectorSection title="CDK infrastructure"><InfrastructurePanel key={mode} onNavigate={select} /></InspectorSection> : null}
    {groups.length ? <SharedDefaults families={groups} note={id === "island:agentcore" ? "These defaults configure Lambda tools used by agents. AgentCore runtimes have individual settings." : undefined} /> : id.startsWith("island:vpc:") || id === "island:environment" || id === "island:inputs" || id === "island:stacks" || id === CLIENT_ENVIRONMENT_ISLAND ? null : <section><h3>Settings</h3><p className={"text-caption"}>The framework has no shared defaults for this island. Select an entry below to configure it.</p></section>}
    {id !== "island:stacks" ? entries : null}
  </>;
}
