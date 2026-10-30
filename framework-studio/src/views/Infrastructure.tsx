import { InspectorSummary } from "./InspectorUI";
import { TextInput, Select } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfrastructureInventory, InfrastructureResource } from "../../shared/infrastructure";
import { api } from "../api";
import { ApiError } from "../http";
import { editorLink, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { ResourceStatus } from "./ResourceStatus";
import { InspectorDisclosure } from "./InspectorUI";

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
  return <div className={"p-[12px_0] wrap-anywhere [&_dl]:grid [&_dl]:grid-cols-[110px_minmax(0,1fr)] [&_dl]:gap-1.75 [&_dl]:text-label [&_dd]:m-0 [&_p]:mt-2"} data-slot="infrastructure-detail">
    <dl><dt>Evidence</dt><dd>Synthesized assembly</dd><dt>Identity</dt><dd><code>{resource.id}</code></dd>
      <dt>Type</dt><dd><code>{resource.type}</code></dd><dt>Classification</dt><dd>{classification[resource.classification]}</dd>
      {resource.logicalId ? <><dt>Logical ID</dt><dd><code>{resource.logicalId}</code></dd></> : null}
      {resource.constructPath ? <><dt>Construct path</dt><dd><code>{resource.constructPath}</code></dd></> : null}
      {resource.condition ? <><dt>CloudFormation condition</dt><dd><code>{resource.condition}</code> · evaluated at deployment</dd></> : null}
      <dt>Deployment status</dt><dd>Not queried</dd></dl>
    {resource.owners.map((id) => <p key={id}>Logical entity: <button className={buttonClasses({ variant: "link" })} onClick={() => navigate(id)}>{titleOf(index, id)}</button></p>)}
    {resource.source ? <p className={"text-caption"}>Owner declaration: <a href={editorLink(snapshot.repositoryRoot, { ...resource.source, column: resource.source.column ?? 1, start: 0, end: 0 })}>{resource.source.file}:{resource.source.line}</a></p> : null}
    {edges.length ? <details><InspectorSummary>CloudFormation dependencies ({edges.length})</InspectorSummary><ul>{edges.map((edge) => {
      const other = inventory.resources.find((item) => item.id === (edge.from === resource.id ? edge.to : edge.from));
      return <li key={`${edge.from}:${edge.to}:${edge.kind}`}>{edge.from === resource.id ? "Depends on" : "Referenced by"} <code>{other?.logicalId ?? other?.id}</code> <span className={"text-graphite"}>({edge.kind})</span></li>;
    })}</ul></details> : null}
  </div>;
}

export function StackInfrastructure({ id }: { id: string }) {
  const { mode, select } = useStudio();
  const [open, setOpen] = useState(false);
  return <InspectorDisclosure title="CDK infrastructure" open={open} onToggle={setOpen}>
    {open ? <InfrastructurePanel key={`${mode}:${id}`} initialOwner={id} onNavigate={select} /> : null}
  </InspectorDisclosure>;
}

/** Same inventory and mode as node inspectors; this panel never creates map nodes or edits source. */
export function InfrastructurePanel({ initialOwner, onNavigate }: { initialOwner?: string; onNavigate: (id: string) => void }) {
  const { mode, index, draft, draftState, live, model } = useStudio();
  const query = useInventory();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [stack, setStack] = useState("");
  const [type, setType] = useState("");
  const [owner, setOwner] = useState(initialOwner ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = pending || query.data?.status === "running";
  const blocked = draft.dirty || !!draftState.busy || live.evaluating || !!live.running || model.stale;
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
  const inputFile = index.resources.get(`envfile:${mode}`)?.deploymentFile?.path ?? `cdk-app/.env.${mode}`;
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
  return <div className={"grid [gap:14px] [&_p]:m-0 [&_label]:grid [&_label]:gap-1.25 [&_label]:text-label [&_label]:min-w-0 [&_input]:w-full [&_input]:min-w-0 [&_select]:w-full [&_select]:min-w-0"} data-slot="infrastructure-panel">
    <p className={"text-caption text-graphite"}>Resources constructed by the saved CDK app for <strong>{mode === "dev" ? "Development" : "Production"}</strong>, including stacks outside framework-config.</p>
    {initialOwner ? <p className={"text-caption"}>{owner === initialOwner ? <>Filtered to {titleOf(index, initialOwner)}. </> : null}<button className={buttonClasses({ variant: "link" })} onClick={() => onNavigate("island:stacks")}>Show all infrastructure</button></p> : null}
    <div className={"flex [gap:10px] items-center flex-wrap [&_label]:flex-1"} data-slot="infrastructure-run"><button className={buttonClasses({ variant: "neutral" })} disabled={query.isPending || !!query.error || running || blocked} onClick={() => void synthesize()}>{running ? "Synthesizing…" : state?.inventory ? "Refresh from CDK" : "Synthesize CDK"}</button>
      {state && !running ? <span className={cx("text-caption", state.stale || state.status === "failed" ? "text-local" : "text-graphite")}>{state.stale ? "Needs refresh" : state.status === "failed" ? "Synthesis failed" : state.inventory ? "Up to date" : "Not synthesized"}</span> : null}
    </div>
    <p className={"text-caption text-graphite"}>Builds a local inventory and templates; does not deploy or rewrite stack source.</p>
    {blocked ? <p role="status">{draft.dirty ? "Apply or discard the current draft before synthesizing saved source." : model.stale ? "Fix the configuration errors before synthesizing saved source." : "Wait for source validation or the current operation to finish before synthesizing."}</p> : null}
    {query.isPending ? <p>Loading inventory…</p> : null}
    {query.error ? <p role="alert">{infrastructureError(query.error)}</p> : null}
    {error || state?.error ? <pre className={"whitespace-pre-wrap wrap-anywhere [max-height:240px] overflow-auto [padding:10px] [background:rgba(220,80,60,.1)]"} role="alert" data-slot="infrastructure-error">{error || state?.error}</pre> : null}
    {state?.stale ? <p className={"[padding:10px] [border:1px_solid_#b48335] rounded-md"} role="status" data-slot="infrastructure-stale">Stale inventory. Source or inputs changed, or the latest synthesis failed. Showing the last successful assembly.</p> : null}
    <details><InspectorSummary>Synthesis details{state?.generatedAt ? ` · ${new Date(state.generatedAt).toLocaleString()}` : ""}</InspectorSummary>
      <p className={"text-caption text-graphite"}>Uses an isolated copy of {state?.inputs?.file ?? inputFile}. May bundle assets and use AWS credentials for CDK context lookups. The inputs file stays unchanged.</p>
      {state?.inputs ? <p className={"text-caption text-graphite"}>{state.inputs.profile} · {state.inputs.modeSelection}</p> : null}
      {initialOwner ? <p className={"text-caption text-graphite"}>Synthesis refreshes the full app inventory. The results below are filtered to this stack.</p> : null}
    </details>
    {!inventory && running ? <p className={"text-caption text-graphite"} role="status">Synthesis is running. Resources will appear when the assembly is complete.</p> : null}
    {inventory ? <>
      <label>Search infrastructure<TextInput type="search" aria-label="Search infrastructure" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Resource type, logical ID, path or owner" /></label>
      <details><InspectorSummary>Filter resources{stack || type || owner ? " · active" : ""}</InspectorSummary><div className={"grid grid-cols-[minmax(0,1fr)] gap-2 [margin-top:8px] vp-540:grid-cols-[minmax(0,1fr)]"} data-slot="infrastructure-filters">
        <label>Stack<Select aria-label="Infrastructure stack" value={stack} onChange={(event) => setStack(event.target.value)}><option value="">All stacks</option>{inventory.stacks.map((stack) => <option key={stack.id} value={stack.id}>{stack.name}{managedStack(stack) ? " · Framework managed" : ""}</option>)}</Select></label>
        <label>Logical owner<Select aria-label="Infrastructure owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All owners</option><option value="__unknown">Unknown owner</option>{ownerIds.map((id) => <option key={id} value={id}>{titleOf(index, id)}</option>)}</Select></label>
        <label>Resource type<Select aria-label="Infrastructure resource type" value={type} onChange={(event) => setType(event.target.value)}><option value="">All types</option>{[...new Set(inventory.resources.map((resource) => resource.type))].sort().map((type) => <option key={type}>{type}</option>)}</Select></label>
      </div></details>
      <p role="status">{visible.length} of {inventory.resources.length} resources · {inventory.stacks.length} stacks</p>
      {inventory.stacks.filter((item) => (!stack || item.id === stack) && visible.some((resource) => resource.stack === item.id)).map((stack) => <section key={stack.id}><h3>{stack.name}</h3><p className={"text-caption text-graphite"}>{stack.environment}</p>
        <ResourceStatus resource={managedStack(stack)} />
        {visible.filter((resource) => resource.stack === stack.id).map((resource) => <details key={resource.id} className={"border-t border-rule p-[10px_0] [&_summary]:cursor-pointer [&_summary]:wrap-anywhere [&_summary_span]:block [&_summary_span]:mt-0.75"} data-slot="infrastructure-resource"><InspectorSummary><strong>{resource.logicalId ?? resource.constructPath}</strong><span className={"text-caption text-graphite"}>{resource.type} · {classification[resource.classification]}</span></InspectorSummary><ResourceDetails resource={resource} inventory={inventory} navigate={onNavigate} /></details>)}
      </section>)}
      {!visible.length ? <p>No matching resources. This declaration may run locally, be absent from this environment, or have no reliable ownership metadata.</p> : null}
      <details><InspectorSummary>Inventory evidence and limitations</InspectorSummary>{inventory.notes.map((note) => <p key={note} className={"text-caption text-graphite"}>{note}</p>)}<p className={"text-caption text-graphite"}>Only explicit synthesis metadata establishes ownership. Owner declarations were captured at synthesis{state?.sourceRevision ? ` from Studio revision ${state.sourceRevision}` : ""}.</p></details>
    </> : null}
  </div>;
}
