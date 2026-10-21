import { useId } from "react";
import { databaseConsumers } from "../../shared/managed-database";
import { useStudio } from "../studio";
import { InspectorSection } from "./InspectorUI";
import { EntityIcon } from "./EntityIcon";

/** Changing a stateful database's home is a coordinated source review, never a live move. */
export function DatabasePlacement() {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const prefix = useId();
  const database = model.managedDatabase;
  if (!database) return null;
  const current = draft.databasePlacement(database.id) ?? { kind: "databasePlacement" as const, database: database.id, vpc: database.networkId, subnet: database.subnet };
  const changed = current.vpc !== database.networkId || current.subnet !== database.subnet;
  const moving = current.vpc !== database.networkId;
  const networks = model.networks ?? [];
  const network = networks.find(item => item.id === current.vpc);
  const consumers = databaseConsumers(Object.values(snapshot.models), database.id);
  const disabled = !!draftState.busy || live.evaluating || !!model.stale || draft.conflict || database.consumers === undefined;
  const error = draftState.entries.find(entry => entry.kind === "databasePlacement" && entry.edit.database === database.id)?.error;
  return <InspectorSection title="Database home" description="Production placement. Local PostgreSQL keeps using Compose networking.">
    <button type="button" className="database-home" onClick={() => select(`island:vpc:${current.vpc}`)}>
      <EntityIcon icon="endpoint" /><span><strong>{network?.name ?? current.vpc}</strong><code>{network?.cidr ?? current.vpc} · {current.subnet} subnets</code></span><span className="small muted">{changed ? "Draft" : "View VPC"}</span>
    </button>
    <p className="small muted">This VPC is required while it owns the application database. Reassign the database and its consumers before removing the declaration.</p>
    <details className="database-placement-editor" open={changed || undefined}>
      <summary>Change placement</summary>
      <fieldset disabled={disabled}>
        <div className="fields">
          <div className="field"><label className="name" htmlFor={`${prefix}-vpc`}>VPC</label><span className="control"><select id={`${prefix}-vpc`} aria-label="Database VPC" value={current.vpc} onChange={event => draft.setDatabasePlacement({ ...current, vpc: event.target.value })}>{networks.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id} · {item.cidr}</option>)}</select></span></div>
          <div className="field"><label className="name" htmlFor={`${prefix}-subnet`}>Subnets</label><span className="control"><select id={`${prefix}-subnet`} aria-label="Database subnets" value={current.subnet} onChange={event => draft.setDatabasePlacement({ ...current, subnet: event.target.value as "private" | "isolated" })}><option value="isolated">Isolated</option><option value="private">Private</option></select></span></div>
        </div>
      </fieldset>
      <p className="small muted">Databases are never public. Workload subnet tiers stay as declared.</p>
      {networks.length < 2 ? <p className="small muted">Create another VPC to choose a different home.</p> : null}
      <button type="button" className="quiet small" disabled={disabled} onClick={() => draft.requestNavigation(() => draft.beginCreation("vpc"))}>Create a VPC</button>
      {moving ? <div className="database-placement-impact" role="status">
        <strong>Coordinated placement review</strong><p className="small">The database and {consumers.length} connected framework {consumers.length === 1 ? "workload" : "workloads"} will use {network?.name ?? current.vpc}. Their database access, IAM login and connection settings are preserved.</p>
        <ul className="small">{consumers.map(consumer => <li key={consumer.target}><code>{consumer.target}</code></li>)}</ul>
      </div> : null}
      <p className="small database-migration-note">For an existing RDS deployment, a VPC change needs a planned migration/cutover. Saving source does not copy data or relocate a running database. Review both synths and native CDK wiring before a separately authorized deployment.</p>
      {changed ? <button className="linkish small" disabled={disabled} onClick={() => draft.setDatabasePlacement({ kind: "databasePlacement", database: database.id, vpc: database.networkId, subnet: database.subnet })}>Restore current placement</button> : null}
      {database.consumers === undefined ? <p className="reason small">Restart Studio to load the database consumer index before changing placement.</p> : null}
      {error ? <p className="reason small" role="alert">{error}</p> : null}
    </details>
  </InspectorSection>;
}
