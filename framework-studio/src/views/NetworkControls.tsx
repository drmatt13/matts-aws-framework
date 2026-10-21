import { CREATORS } from "../../shared/creation";
import type { ModelTarget } from "../../shared/model";
import type { NetworkSettings, PlacementEdit } from "../../shared/networks";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";
import { InspectorSection, InspectorSwitch } from "./InspectorUI";
import { InterfaceEndpointPicker } from "./InterfaceEndpointPicker";
import { useId } from "react";

/** One placement edit keeps VPC references and subnet selection in the same reviewed transaction. */
export function PlacementControl({ target }: { readonly target: ModelTarget }) {
  const { model, draft } = useStudio();
  const prefix = useId();
  if (!["lambda", "service", "task"].includes(target.kind) || (target.compute.kind === "lambda" && target.compute.implementation !== "typescript")) return null;
  const lambda = target.kind === "lambda";
  const current: PlacementEdit = draft.placement(target.ref) ?? {
    target: target.ref,
    vpc: target.placement.kind === "vpc" ? target.placement.networkId : null,
    subnet: target.placement.kind === "vpc" ? target.placement.subnet : "none",
  };
  return <div className="fields">
    <div className="field"><label className="name" htmlFor={`${prefix}-vpc`}>VPC</label><span className="control"><select id={`${prefix}-vpc`} aria-label="Workload VPC" value={current.vpc ?? ""} onChange={event => {
      const vpc = event.target.value || null;
      draft.setPlacement({ ...current, vpc, subnet: vpc ? current.subnet === "none" ? "private" : current.subnet : "none" });
    }}>
      {lambda ? <option value="">Outside VPCs</option> : null}
      {(model.networks ?? []).map(network => <option key={network.id} value={network.id}>{network.id} · {network.cidr}</option>)}
    </select></span></div>
    {current.vpc ? <div className="field"><label className="name" htmlFor={`${prefix}-subnet`}>Subnet</label><span className="control"><select id={`${prefix}-subnet`} aria-label="Workload subnet" value={current.subnet} onChange={event => draft.setPlacement({ ...current, subnet: event.target.value as PlacementEdit["subnet"] })}>
      {(lambda ? ["private", "isolated"] : ["public", "private"]).map(subnet => <option key={subnet} value={subnet}>{subnet}</option>)}
    </select></span></div> : null}
    {target.origins.length > 1 ? <p className="small muted">Updates all routes sharing this workload.</p> : null}
    {!model.networks?.length ? <p className="small muted">Create a VPC before placing this workload in a network.</p> : null}
  </div>;
}

export function NetworkControls({ id }: { readonly id: string }) {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const prefix = useId();
  const network = model.networks?.find(network => `island:vpc:${network.id}` === id);
  if (!network) return null;
  const settings = draft.network(network.id)!;
  const source = snapshot.source.entities[id]?.value;
  const fields = CREATORS.vpc.fields.filter(field => !["id", "description", "endpoints"].includes(field.key));
  const form = settings;
  const update = (key: string, value: string | number | boolean) => {
    const next = { ...form, [key]: value };
    draft.setNetwork(network.id, next as NetworkSettings);
  };
  const error = draft.getSnapshot().entries.find(entry => entry.kind === "network" && entry.network === network.id)?.error;
  const assigned = Object.values(snapshot.models).some(model => model.databaseNetworkId === network.id || model.targets.some(target => target.placement.kind === "vpc" && target.placement.networkId === network.id));
  const used = assigned || Object.values(snapshot.models).some(model => model.networks?.find(item => item.id === network.id)?.builtInProd);
  const database = Object.values(snapshot.models).flatMap(graph => graph.managedDatabase?.networkId === network.id ? [graph.managedDatabase] : [])[0];
  return <InspectorSection title="VPC settings" description="Applies to this VPC and its assigned resources.">
    <p className="small muted">Identity: {network.id} · {network.constructId}</p>
    {database ? <div className="network-database-home"><strong>Home of the application database</strong><p className="small muted">This VPC cannot be removed while the database is placed here.</p><button className="linkish small" onClick={() => select(database.resource)}>Configure application PostgreSQL</button></div> : null}
    <div className="fields">{fields.map(field => <div className="field" key={field.key}><label className="name" htmlFor={`${prefix}-${field.key}`}>{field.label}</label><span className="control">
      {field.type === "boolean" ? <InspectorSwitch id={`${prefix}-${field.key}`} label={field.label} checked={form[field.key as keyof typeof form] === true} onChange={checked => update(field.key, checked)} describedBy={field.help ? `${prefix}-${field.key}-help` : undefined} />
        : <input id={`${prefix}-${field.key}`} type={field.type === "number" ? "number" : "text"} value={String(form[field.key as keyof typeof form])} onChange={event => update(field.key, field.type === "number" ? Number(event.target.value) : event.target.value)} />}</span>
      {field.help ? <span id={`${prefix}-${field.key}-help`} className="note">{field.help}</span> : null}
    </div>)}<div className="field endpoint-field"><label className="name" htmlFor={`${prefix}-endpoints`}>Interface endpoints</label>
      <InterfaceEndpointPicker id={`${prefix}-endpoints`} services={model.interfaceEndpointServices} selected={settings.endpoints}
        onChange={endpoints => draft.setNetwork(network.id, { ...settings, endpoints })} disabled={!!draftState.busy || live.evaluating || !!model.stale || draft.conflict}
        describedBy={`${prefix}-endpoints-help`} />
      <p id={`${prefix}-endpoints-help`} className="small muted">Each service incurs hourly charges in each zone and per GB.</p>
    </div></div>
    {error ? <p className="reason small" role="alert">{error}</p> : null}
    <p className="small muted">CIDR or zone changes may replace attached infrastructure on deployment. NAT gateways and interface endpoints incur charges when built.</p>
    <p className="small muted">Local Compose networking is shared; the selected VPC controls declaration checks and existing Lambda egress rules.</p>
    <p className="small muted">All VPCs inherit the named deployment's region from cdk-app/cdk.json.</p>
    {source ? <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>Open VPC declaration in VS Code</a> : null}
    <details><summary>Remove VPC</summary>
      <p className="small muted">Removes this unused declaration and registry entry through diff review. Applying source does not delete AWS resources.</p>
      {used ? <p className="small muted">Reassign workloads, the database, and native resource references before removal.</p> : null}
      <button className="button" disabled={used || draft.dirty} onClick={() => { draft.removeNetwork(network.id); void draft.review(); }}>Review VPC removal</button>
    </details>
  </InspectorSection>;
}
