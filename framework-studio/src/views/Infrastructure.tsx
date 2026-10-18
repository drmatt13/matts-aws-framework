import { createContext, useContext, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfrastructureInventory, InfrastructureResource } from "../../shared/infrastructure";
import { api, ApiError } from "../api";
import { editorLink, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { ResourceStatus } from "./ResourceStatus";

export const InfrastructureNavigation = createContext<(owner?: string) => void>(() => {});

function useInventory() {
  const { mode } = useStudio();
  return useQuery({ queryKey: ["infrastructure", mode], queryFn: () => api.infrastructure(mode), refetchInterval: 5000 });
}
const classification = { framework: "Framework resource", supporting: "Generated supporting resource", imported: "Imported reference", unowned: "Unknown framework owner" };
function infrastructureError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "The running Studio server is out of date and does not have the infrastructure endpoint. Restart npm run studio, then reload this page. No AWS deployment is needed.";
  return error instanceof Error ? error.message : "Synthesis failed.";
}

function ResourceDetails({ resource, inventory, navigate }: { resource: InfrastructureResource; inventory: InfrastructureInventory; navigate: (id: string) => void }) {
  const { index, snapshot } = useStudio();
  const edges = inventory.dependencies.filter((edge) => edge.from === resource.id || edge.to === resource.id);
  return <div className="infrastructure-detail">
    <dl><dt>Evidence</dt><dd>Synthesized assembly</dd><dt>Identity</dt><dd><code>{resource.id}</code></dd>
      <dt>Type</dt><dd><code>{resource.type}</code></dd><dt>Classification</dt><dd>{classification[resource.classification]}</dd>
      {resource.logicalId ? <><dt>Logical ID</dt><dd><code>{resource.logicalId}</code></dd></> : null}
      {resource.constructPath ? <><dt>Construct path</dt><dd><code>{resource.constructPath}</code></dd></> : null}
      {resource.condition ? <><dt>CloudFormation condition</dt><dd><code>{resource.condition}</code> · evaluated at deployment</dd></> : null}
      <dt>Deployment status</dt><dd>Not queried</dd></dl>
    {resource.owners.map((id) => <p key={id}>Logical entity: <button className="linkish" onClick={() => navigate(id)}>{titleOf(index, id)}</button></p>)}
    {resource.source ? <p className="small">Owner declaration: <a href={editorLink(snapshot.repositoryRoot, { ...resource.source, column: resource.source.column ?? 1, start: 0, end: 0 })}>{resource.source.file}:{resource.source.line}</a></p> : null}
    {edges.length ? <details><summary>CloudFormation dependencies ({edges.length})</summary><ul>{edges.map((edge) => {
      const other = inventory.resources.find((item) => item.id === (edge.from === resource.id ? edge.to : edge.from));
      return <li key={`${edge.from}:${edge.to}:${edge.kind}`}>{edge.from === resource.id ? "Depends on" : "Referenced by"} <code>{other?.logicalId ?? other?.id}</code> <span className="muted">({edge.kind})</span></li>;
    })}</ul></details> : null}
  </div>;
}

export function StackInfrastructure({ id }: { id: string }) {
  const open = useContext(InfrastructureNavigation);
  return <section><button className="button secondary" onClick={() => open(id)}>Inspect stack infrastructure</button></section>;
}

/** Same inventory and mode as node inspectors; this panel never creates map nodes or edits source. */
export function InfrastructurePanel({ initialOwner, onNavigate }: { initialOwner?: string; onNavigate: (id: string) => void }) {
  const { mode, index, draft } = useStudio();
  const query = useInventory();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [stack, setStack] = useState("");
  const [type, setType] = useState("");
  const [owner, setOwner] = useState(initialOwner ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const state = query.data;
  const inventory = useMemo(() => {
    if (!state?.inventory) return undefined;
    const stacks = state.inventory.stacks.filter((item) => !/(?:^|-)(?:AsynchronousLambdaFunctionsStack|WebSocketLambdaFunctionsStack|WebSocketApiStack)$/i.test(item.name));
    const stackIds = new Set(stacks.map((item) => item.id));
    const resources = state.inventory.resources.filter((item) => stackIds.has(item.stack));
    const resourceIds = new Set(resources.map((item) => item.id));
    return { ...state.inventory, stacks, resources, dependencies: state.inventory.dependencies.filter((item) => resourceIds.has(item.from) && resourceIds.has(item.to)) };
  }, [state?.inventory]);
  const managedStack = (item: InfrastructureInventory["stacks"][number]) => item.owners.map((id) => index.resources.get(id)).find((resource) => resource?.frameworkManaged);
  const inputFile = index.resources.get(`envfile:${mode}`)?.deploymentFile?.synthesisSource ?? "cdk-app/.env";
  const ownerIds = useMemo(() => [...new Set([...(inventory?.resources.flatMap((resource) => resource.owners) ?? []), ...(inventory?.stacks.flatMap((stack) => stack.owners) ?? []), ...(initialOwner ? [initialOwner] : [])])].sort(), [inventory, initialOwner]);
  const visible = inventory?.resources.filter((resource) => {
    const ownedStack = inventory.stacks.find((stack) => stack.id === resource.stack)?.owners.some((id) => id === owner);
    const matchesOwner = !owner || (owner === "__unknown" ? resource.owners.length === 0 : ownedStack || resource.owners.some((id) => id === owner || id.startsWith(`${owner}.`)));
    const words = `${resource.logicalId ?? ""} ${resource.type} ${resource.constructPath ?? ""} ${resource.owners.map((id) => `${id} ${titleOf(index, id)}`).join(" ")}`.toLowerCase();
    return matchesOwner && (!stack || resource.stack === stack) && (!type || resource.type === type) && search.trim().toLowerCase().split(/\s+/).every((term) => words.includes(term));
  }) ?? [];
  const synthesize = async () => {
    setPending(true); setError("");
    try { client.setQueryData(["infrastructure", mode], await api.synthesize(mode)); }
    catch (error) { setError(infrastructureError(error)); }
    finally { setPending(false); }
  };
  return <div className="infrastructure-panel">
    <p>Infrastructure for <strong>{mode === "dev" ? "Development" : "Production"}</strong>. Lists resources synthesized by the full CDK app, including application CDK outside framework-config. Nothing needs to be deployed.</p>
    <div className="infrastructure-run"><button className="button" disabled={query.isPending || !!query.error || pending || state?.status === "running" || draft.dirty} onClick={() => void synthesize()}>{pending || state?.status === "running" ? "Synthesizing…" : `Synthesize ${mode === "dev" ? "development" : "production"}`}</button></div>
    <p className="small muted">Uses an isolated copy of {inputFile}. Creates templates and may bundle assets locally; it does not deploy or change the inputs file.</p>
    {draft.dirty ? <p role="status">Apply or discard the current draft before synthesizing saved source.</p> : null}
    {query.isPending ? <p>Loading inventory…</p> : null}
    {query.error ? <p role="alert">{infrastructureError(query.error)}</p> : null}
    {error || state?.error ? <pre className="infrastructure-error" role="alert">{error || state?.error}</pre> : null}
    {state?.stale ? <p className="infrastructure-stale" role="status">Stale inventory. Source or inputs changed, or the latest synthesis failed. Showing the last successful assembly.</p> : null}
    {state?.generatedAt ? <p className="small">Generated {new Date(state.generatedAt).toLocaleString()} · {state.inputs?.file} · {state.inputs?.profile}<br />{state.inputs?.modeSelection}</p> : null}
    {!inventory && !query.isPending && !query.error ? <p className="empty">{pending || state?.status === "running" ? "Synthesis is running. Resources will appear when the assembly is complete." : "No successful synthesis for this environment yet. Run synthesis explicitly to discover its infrastructure."}</p> : null}
    {inventory ? <>
      <label>Search infrastructure<input type="search" aria-label="Search infrastructure" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Resource type, logical ID, path or owner" /></label>
      <div className="infrastructure-filters">
        <label>Stack<select aria-label="Infrastructure stack" value={stack} onChange={(event) => setStack(event.target.value)}><option value="">All stacks</option>{inventory.stacks.map((stack) => <option key={stack.id} value={stack.id}>{stack.name}{managedStack(stack) ? " · Framework managed" : ""}</option>)}</select></label>
        <label>Logical owner<select aria-label="Infrastructure owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All owners</option><option value="__unknown">Unknown owner</option>{ownerIds.map((id) => <option key={id} value={id}>{titleOf(index, id)}</option>)}</select></label>
        <label>Resource type<select aria-label="Infrastructure resource type" value={type} onChange={(event) => setType(event.target.value)}><option value="">All types</option>{[...new Set(inventory.resources.map((resource) => resource.type))].sort().map((type) => <option key={type}>{type}</option>)}</select></label>
      </div>
      <p role="status">{visible.length} of {inventory.resources.length} resources · {inventory.stacks.length} stacks</p>
      {owner && initialOwner === owner ? <p className="small">Filtered to {titleOf(index, owner)}. <button className="linkish" onClick={() => { setOwner(""); setStack(""); setType(""); setSearch(""); }}>Show all infrastructure</button></p> : null}
      {inventory.stacks.filter((item) => (!stack || item.id === stack) && visible.some((resource) => resource.stack === item.id)).map((stack) => <section key={stack.id} className="infrastructure-stack"><h3>{stack.name}</h3><p className="small muted">{stack.environment}</p>
        <ResourceStatus resource={managedStack(stack)} />
        {visible.filter((resource) => resource.stack === stack.id).map((resource) => <details key={resource.id} className="infrastructure-resource"><summary><strong>{resource.logicalId ?? resource.constructPath}</strong><span className="small muted">{resource.type} · {classification[resource.classification]}</span></summary><ResourceDetails resource={resource} inventory={inventory} navigate={onNavigate} /></details>)}
      </section>)}
      {!visible.length ? <p>No matching resources. This declaration may run locally, be absent from this environment, or have no reliable ownership metadata.</p> : null}
      <details><summary>Inventory evidence and limitations</summary>{inventory.notes.map((note) => <p key={note} className="small muted">{note}</p>)}<p className="small muted">Only explicit synthesis metadata establishes ownership. Owner declarations were captured at synthesis{state?.sourceRevision ? ` from Studio revision ${state.sourceRevision}` : ""}.</p></details>
    </> : null}
  </div>;
}
