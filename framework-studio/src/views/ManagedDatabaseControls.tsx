import { DATABASE_SETTING_INPUTS, resolveDatabaseSettings, type DatabaseSettings, type DatabaseSettingsInput } from "@repo/framework/config/database";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";
import { InspectorSection, InspectorSwitch } from "./InspectorUI";
import { useId } from "react";
import { SharedDefaults } from "./SharedDefaults";

const fields: readonly { key: keyof DatabaseSettings; label: string; type?: "number" | "boolean" | "list"; options?: readonly string[]; advanced?: boolean }[] = [
  { key: "instanceClass", label: "Instance class" },
  { key: "multiAz", label: "Multi-AZ standby", type: "boolean" },
  { key: "readReplicaCount", label: "Read replicas", type: "number" },
  { key: "backupRetentionDays", label: "Backup retention (days)", type: "number" },
  { key: "storageType", label: "Storage type", options: ["gp2", "gp3", "io2"] },
  { key: "allocatedStorage", label: "Allocated storage (GiB)", type: "number" },
  { key: "maxAllocatedStorage", label: "Storage autoscaling ceiling (GiB)", type: "number" },
  { key: "proxyEnabled", label: "RDS Proxy with IAM authentication", type: "boolean" },
  { key: "engineVersion", label: "PostgreSQL version", advanced: true },
  { key: "readReplicaInstanceClass", label: "Replica instance class", advanced: true },
  { key: "readReplicaMultiAz", label: "Multi-AZ replicas", type: "boolean", advanced: true },
  { key: "iops", label: "Provisioned IOPS", type: "number", advanced: true },
  { key: "throughput", label: "Storage throughput (MiB/s)", type: "number", advanced: true },
  { key: "backupWindow", label: "Backup window (UTC)", advanced: true },
  { key: "maintenanceWindow", label: "Maintenance window (UTC)", advanced: true },
  { key: "logExports", label: "Log exports (comma-separated)", type: "list", advanced: true },
  { key: "logRetentionDays", label: "Log retention (days)", type: "number", advanced: true },
  { key: "allowMajorVersionUpgrade", label: "Allow major version upgrade", type: "boolean", advanced: true },
  { key: "autoMinorVersionUpgrade", label: "Automatic minor version upgrades", type: "boolean", advanced: true },
  { key: "applyImmediately", label: "Apply outside maintenance window", type: "boolean", advanced: true },
  { key: "proxyMaxConnectionsPercent", label: "Proxy connection limit (%)", type: "number", advanced: true },
  { key: "proxyBorrowTimeoutSeconds", label: "Proxy borrow timeout (seconds)", type: "number", advanced: true },
  { key: "proxyIdleClientTimeoutSeconds", label: "Proxy idle timeout (seconds)", type: "number", advanced: true },
];

/** Edits the source policy; never connects to, migrates, or changes a live database. */
export function ManagedDatabaseControls() {
  const { model, snapshot, draft } = useStudio();
  const prefix = useId();
  const database = model.managedDatabase;
  if (!database) return null;
  const authored = draft.database(database.id) ?? database.authored;
  let settings: DatabaseSettings;
  try { settings = resolveDatabaseSettings({ getContext: () => undefined, env: {}, defaults: authored }); }
  catch { settings = { ...database.settings, ...authored }; }
  const source = snapshot.source.entities[`database:${database.id}`]?.value;
  const error = draft.getSnapshot().entries.find(entry => entry.kind === "database" && entry.database === database.id)?.error;
  const inputNames = new Set(Object.values(DATABASE_SETTING_INPUTS));
  const overrides = model.resources.flatMap(resource => resource.deploymentFile?.mode === model.mode ? resource.deploymentFile.entries.filter(entry => inputNames.has(entry.name as never)).map(entry => entry.name) : []);
  const update = (key: keyof DatabaseSettings, value: unknown) => {
    const next = { ...authored } as Record<string, unknown>;
    if (value === undefined || value === "") delete next[key]; else next[key] = value;
    draft.setDatabase(database.id, next as DatabaseSettingsInput);
  };
  const inputs = (advanced: boolean) => <div className="fields">{fields.filter(field => !!field.advanced === advanced).map(field => {
    const value = settings[field.key];
    const id = `${prefix}-${field.key}`;
    return <div className="field" key={field.key}><label className="name" htmlFor={id}>{field.label}</label><span className="control">
      {field.type === "boolean" ? <InspectorSwitch id={id} label={field.label} checked={value === true} onChange={checked => update(field.key, checked)} />
        : field.options ? <select id={id} aria-label={field.label} value={String(value)} onChange={event => update(field.key, event.target.value)}>{field.options.map(option => <option key={option}>{option}</option>)}</select>
        : field.type === "list" ? <input id={id} aria-label={field.label} key={draft.getSnapshot().baseline.revision} defaultValue={(value as readonly string[]).join(", ")} onChange={event => update(field.key, event.target.value.split(",").map(item => item.trim()).filter(Boolean))} />
        : <input id={id} aria-label={field.label} type={field.type === "number" ? "number" : "text"} value={value === undefined ? "" : String(value)} onChange={event => update(field.key, field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}</span>
      <span className="note">{Object.hasOwn(authored, field.key) ? <button className="linkish small" type="button" aria-label={`Use framework default for ${field.label}`} onClick={() => update(field.key, undefined)}>Use framework default</button> : "Framework default"}</span>
    </div>;
  })}</div>;
  return <><InspectorSection title="Managed PostgreSQL" description="Declaration defaults shared by both modes. Production builds RDS; development uses local PostgreSQL.">
    <p className="small">{database.id} · {database.networkId} VPC · {database.subnet} subnets · {database.databaseName}</p>
    <p className="small muted">IAM-only workload login. Network, database name, engine family, and deployed identities remain source-owned.</p>
    {inputs(false)}
    <p className="small muted">Multi-AZ, replicas, and Proxy add billed capacity. Enabling replicas requires backups; workloads request replica access explicitly.</p>
    {settings.multiAz && !database.settings.multiAz ? <p className="small">Multi-AZ upgrade staged. Review the source diff, then review a production synth before a separate deployment.</p> : null}
    <details><summary>Advanced PostgreSQL settings</summary>{inputs(true)}<p className="small muted">Engine upgrades, storage changes, and immediate application need a separate operational review before deployment.</p></details>
    {error ? <p className="reason small" role="alert">{error}</p> : null}
    <p className="small muted">{overrides.length ? `This mode has deployment inputs: ${overrides.join(", ")}. ` : ""}DATABASE_* inputs and CDK context override declaration defaults. Synthesis resolves the final deployment settings.</p>
    {source ? <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>Open database declaration in VS Code</a> : null}
  </InspectorSection><SharedDefaults families={["database"]} title="Connection pool defaults" description="Shared by database callers across all VPCs. Individual workload overrides take precedence; these settings do not size the database server." /></>;
}
