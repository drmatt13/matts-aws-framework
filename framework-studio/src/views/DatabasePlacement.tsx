import { InspectorSummary } from "./InspectorUI";
import { Select } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { inspectorFieldClasses, inspectorLabelClasses, inspectorControlClasses } from "../inspector-ui";
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
    <button type="button" className={"flex items-center gap-3 min-w-0 p-3 border border-rule-strong rounded-md bg-paper [&>[data-entity-icon]]:size-8 [&>[data-entity-icon]]:flex-none [&>span:first-of-type]:grid [&>span:first-of-type]:gap-0.5 [&>span:first-of-type]:flex-1 [&>span:first-of-type]:min-w-0 [&_strong]:text-label [&_strong]:font-semibold [&_strong]:wrap-anywhere [&_code]:text-graphite [&_code]:text-meta [&_code]:wrap-anywhere [&>span:last-child]:flex-none w-full text-left text-ink [font:inherit] cursor-pointer hover:border-graphite hover:bg-wash"} onClick={() => select(`island:vpc:${current.vpc}`)} data-slot="database-home">
      <EntityIcon icon="endpoint" /><span><strong>{network?.name ?? current.vpc}</strong><code>{network?.cidr ?? current.vpc} · {current.subnet} subnets</code></span><span className={"text-caption text-graphite"}>{changed ? "Draft" : "View VPC"}</span>
    </button>
    <p className={"text-caption text-graphite"}>This VPC is required while it owns the application database. Reassign the database and its consumers before removing the declaration.</p>
    <details className={"[&>summary]:cursor-pointer [&>summary]:text-label [&>summary]:font-medium [&>summary]:py-2 [&_fieldset]:min-w-0 [&_fieldset]:[border:0] [&_fieldset]:p-0 [&_fieldset]:m-0"} open={changed || undefined} data-slot="database-placement-editor">
      <InspectorSummary>Change placement</InspectorSummary>
      <fieldset disabled={disabled}>
        <div className={"[&>div+div]:border-t [&>div+div]:border-rule [&>div>[data-slot=field]]:border-0"} data-slot="fields">
          <div className={inspectorFieldClasses} data-slot="field"><label className={inspectorLabelClasses} htmlFor={`${prefix}-vpc`} data-slot="field-label">VPC</label><span className={inspectorControlClasses} data-slot="control"><Select id={`${prefix}-vpc`} aria-label="Database VPC" value={current.vpc} onChange={event => draft.setDatabasePlacement({ ...current, vpc: event.target.value })}>{networks.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id} · {item.cidr}</option>)}</Select></span></div>
          <div className={inspectorFieldClasses} data-slot="field"><label className={inspectorLabelClasses} htmlFor={`${prefix}-subnet`} data-slot="field-label">Subnets</label><span className={inspectorControlClasses} data-slot="control"><Select id={`${prefix}-subnet`} aria-label="Database subnets" value={current.subnet} onChange={event => draft.setDatabasePlacement({ ...current, subnet: event.target.value as "private" | "isolated" })}><option value="isolated">Isolated</option><option value="private">Private</option></Select></span></div>
        </div>
      </fieldset>
      <p className={"text-caption text-graphite"}>Databases are never public. Workload subnet tiers stay as declared.</p>
      {networks.length < 2 ? <p className={"text-caption text-graphite"}>Create another VPC to choose a different home.</p> : null}
      <button type="button" className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} disabled={disabled} onClick={() => draft.requestNavigation(() => draft.beginCreation("vpc"))}>Create a VPC</button>
      {moving ? <div className={"m-[var(--space-3)_0] p-3 border border-rule-strong rounded-md bg-wash [&_strong]:text-label [&_strong]:font-medium [&_p]:m-[var(--space-2)_0] [&_ul]:pl-4.5 [&_ul]:wrap-anywhere"} role="status" data-slot="database-placement-impact">
        <strong>Coordinated placement review</strong><p className={"text-caption"}>The database and {consumers.length} connected framework {consumers.length === 1 ? "workload" : "workloads"} will use {network?.name ?? current.vpc}. Their database access, IAM login and connection settings are preserved.</p>
        <ul className={"text-caption"}>{consumers.map(consumer => <li key={consumer.target}><code>{consumer.target}</code></li>)}</ul>
      </div> : null}
      <p className={"text-caption [border-left:2px_solid_var(--prod)] pl-3 text-graphite"} data-slot="database-migration-note">For an existing RDS deployment, a VPC change needs a planned migration/cutover. Saving source does not copy data or relocate a running database. Review both synths and native CDK wiring before a separately authorized deployment.</p>
      {changed ? <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} disabled={disabled} onClick={() => draft.setDatabasePlacement({ kind: "databasePlacement", database: database.id, vpc: database.networkId, subnet: database.subnet })}>Restore current placement</button> : null}
      {database.consumers === undefined ? <p className={"text-refuse wrap-anywhere text-caption"}>Restart Studio to load the database consumer index before changing placement.</p> : null}
      {error ? <p className={"text-refuse wrap-anywhere text-caption"} role="alert">{error}</p> : null}
    </details>
  </InspectorSection>;
}
