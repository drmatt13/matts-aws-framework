import { sourceEditBlocked } from "../editing-state";
import {
  InspectorSummary,
  InspectorDisclosure,
  InspectorSection,
  InspectorSwitch,
} from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorFieldClasses,
  inspectorSwitchFieldClasses,
  inspectorLabelClasses,
  inspectorControlClasses,
  inspectorHelpClasses,
  inspectorFullWidthHelpClasses,
} from "../inspector-ui";
import {
  DATABASE_SETTING_INPUTS,
  resolveDatabaseSettings,
  type DatabaseSettings,
  type DatabaseSettingsInput,
} from "@repo/framework/config/database";
import { useId } from "react";
import { useStudio } from "../studio";

import { SharedDefaults } from "./SharedDefaults";

const connectionPathClasses = "grid grid-cols-[100px_minmax(0,1fr)] gap-3 text-label";
const policySummaryClasses = "rounded-sm bg-wash px-[7px] py-1 text-caption";

type Group = "capacity" | "resilience" | "connections" | "maintenance";
const fields: readonly {
  key: keyof DatabaseSettings;
  label: string;
  group: Group;
  type?: "number" | "boolean";
  options?: readonly string[];
}[] = [
  { key: "instanceClass", label: "Instance class", group: "capacity" },
  { key: "storageType", label: "Storage type", options: ["gp2", "gp3", "io2"], group: "capacity" },
  { key: "allocatedStorage", label: "Allocated storage (GiB)", type: "number", group: "capacity" },
  {
    key: "maxAllocatedStorage",
    label: "Storage autoscaling ceiling (GiB)",
    type: "number",
    group: "capacity",
  },
  { key: "iops", label: "Provisioned IOPS", type: "number", group: "capacity" },
  { key: "throughput", label: "Storage throughput (MiB/s)", type: "number", group: "capacity" },
  { key: "multiAz", label: "Multi-AZ standby", type: "boolean", group: "resilience" },
  { key: "readReplicaCount", label: "Read replicas", type: "number", group: "resilience" },
  { key: "readReplicaInstanceClass", label: "Replica instance class", group: "resilience" },
  { key: "readReplicaMultiAz", label: "Multi-AZ replicas", type: "boolean", group: "resilience" },
  {
    key: "backupRetentionDays",
    label: "Backup retention (days)",
    type: "number",
    group: "resilience",
  },
  { key: "backupWindow", label: "Backup window (UTC)", group: "resilience" },
  {
    key: "proxyEnabled",
    label: "RDS Proxy with IAM authentication",
    type: "boolean",
    group: "connections",
  },
  {
    key: "proxyMaxConnectionsPercent",
    label: "Proxy connection limit (%)",
    type: "number",
    group: "connections",
  },
  {
    key: "proxyBorrowTimeoutSeconds",
    label: "Proxy borrow timeout (seconds)",
    type: "number",
    group: "connections",
  },
  {
    key: "proxyIdleClientTimeoutSeconds",
    label: "Proxy idle timeout (seconds)",
    type: "number",
    group: "connections",
  },
  { key: "engineVersion", label: "PostgreSQL version", group: "maintenance" },
  {
    key: "autoMinorVersionUpgrade",
    label: "Automatic minor version upgrades",
    type: "boolean",
    group: "maintenance",
  },
  {
    key: "allowMajorVersionUpgrade",
    label: "Allow major version upgrade",
    type: "boolean",
    group: "maintenance",
  },
  {
    key: "applyImmediately",
    label: "Apply outside maintenance window",
    type: "boolean",
    group: "maintenance",
  },
  { key: "maintenanceWindow", label: "Maintenance window (UTC)", group: "maintenance" },
  { key: "logRetentionDays", label: "Log retention (days)", type: "number", group: "maintenance" },
];
const groups: readonly { id: Group; title: string; help: string }[] = [
  {
    id: "capacity",
    title: "Capacity and storage",
    help: "Writer sizing and storage autoscaling. Storage changes need review before deployment.",
  },
  {
    id: "resilience",
    title: "Availability and backups",
    help: "Multi-AZ adds a standby for failover. Read replicas serve explicitly requested, potentially stale reads and require backups.",
  },
  {
    id: "connections",
    title: "Proxy and connections",
    help: "Proxy handles application writer traffic with end-to-end IAM. Migrations stay direct; replicas use direct reader connections.",
  },
  {
    id: "maintenance",
    title: "Maintenance and logs",
    help: "Engine upgrades and immediate application affect production operations; review them before deployment.",
  },
];

/** All settings use the existing declaration resolver and guarded source transaction. */
export function ManagedDatabaseControls() {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const prefix = useId();
  const database = model.managedDatabase;
  if (!database) return null;
  const authored = draft.database(database.id) ?? database.authored;
  let settings: DatabaseSettings;
  try {
    settings = resolveDatabaseSettings({
      getContext: () => undefined,
      env: {},
      defaults: authored,
    });
  } catch {
    settings = { ...database.settings, ...authored };
  }
  const error = draftState.entries.find(
    (entry) => entry.kind === "database" && entry.database === database.id,
  )?.error;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const inputNames = new Set<string>(Object.values(DATABASE_SETTING_INPUTS));
  const overrides = Object.values(snapshot.models)
    .flatMap((graph) =>
      graph.resources.flatMap((resource) =>
        resource.deploymentFile
          ? [
              {
                file: resource.deploymentFile,
                entries: resource.deploymentFile.entries.filter((entry) =>
                  inputNames.has(entry.name),
                ),
              },
            ]
          : [],
      ),
    )
    .filter(({ entries }) => entries.length);
  const uniqueOverrides = [...new Map(overrides.map((item) => [item.file.mode, item])).values()];
  const update = (key: keyof DatabaseSettings, value: unknown) => {
    const next = { ...authored } as Record<string, unknown>;
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    draft.setDatabase(database.id, next as DatabaseSettingsInput);
  };
  const inputs = (group: Group) => (
    <div data-slot="fields">
      {fields
        .filter((field) => field.group === group)
        .map((field) => {
          const value = settings[field.key];
          const id = `${prefix}-${field.key}`;
          const unavailable =
            field.key.startsWith("proxy") && field.key !== "proxyEnabled" && !settings.proxyEnabled
              ? "Enable Proxy to configure its pool."
              : ["readReplicaInstanceClass", "readReplicaMultiAz"].includes(field.key) &&
                  !settings.readReplicaCount
                ? "Add a read replica to configure its sizing."
                : field.key === "iops" && settings.storageType === "gp2"
                  ? "Custom IOPS requires gp3 or io2."
                  : field.key === "throughput" && settings.storageType !== "gp3"
                    ? "Custom throughput requires gp3."
                    : undefined;
          const invalid = !!error?.includes(`settings.${field.key}`);
          return (
            <div
              className={
                field.type === "boolean" ? inspectorSwitchFieldClasses : inspectorFieldClasses
              }
              key={field.key}
              data-slot="field"
            >
              <label className={inspectorLabelClasses} htmlFor={id} data-slot="field-label">
                {field.label}
              </label>
              <span className={inspectorControlClasses} data-slot="control">
                {field.type === "boolean" ? (
                  <InspectorSwitch
                    id={id}
                    label={field.label}
                    checked={value === true}
                    disabled={disabled || !!unavailable}
                    onChange={(checked) => update(field.key, checked)}
                    invalid={invalid}
                  />
                ) : field.options ? (
                  <Select
                    className="w-full"
                    id={id}
                    aria-label={field.label}
                    value={String(value)}
                    disabled={disabled || !!unavailable}
                    onChange={(event) => update(field.key, event.target.value)}
                  >
                    {field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    className="w-full flex-1"
                    id={id}
                    aria-label={field.label}
                    type={field.type === "number" ? "number" : "text"}
                    disabled={disabled || !!unavailable}
                    value={value === undefined ? "" : String(value)}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? `${prefix}-error` : undefined}
                    onChange={(event) =>
                      update(
                        field.key,
                        field.type === "number" && event.target.value !== ""
                          ? Number(event.target.value)
                          : event.target.value,
                      )
                    }
                  />
                )}
              </span>
              <span
                className={
                  field.type === "boolean" ? inspectorFullWidthHelpClasses : inspectorHelpClasses
                }
                data-slot="note"
              >
                {unavailable ? <span>{unavailable} </span> : null}
                {Object.hasOwn(authored, field.key) ? (
                  <button
                    className={cx(buttonClasses({ variant: "link" }), "text-caption")}
                    type="button"
                    disabled={disabled}
                    aria-label={`Use framework default for ${field.label}`}
                    onClick={() => update(field.key, undefined)}
                  >
                    Use framework default
                  </button>
                ) : (
                  "Framework default"
                )}
              </span>
            </div>
          );
        })}
    </div>
  );
  return (
    <>
      <InspectorSection
        title="Connection paths"
        description="Production routes from the declaration preview; these are not live connection checks."
      >
        <div className="grid gap-2" aria-live="polite" data-slot="database-paths">
          <div className={connectionPathClasses}>
            <span className="text-graphite">Application</span>
            <strong className="font-medium wrap-anywhere">
              {settings.proxyEnabled ? "IAM → Proxy → Writer" : "IAM → Writer"}
            </strong>
          </div>
          <div className={connectionPathClasses}>
            <span className="text-graphite">Migrations</span>
            <strong className="font-medium wrap-anywhere">IAM → Direct writer</strong>
          </div>
          <div className={connectionPathClasses}>
            <span className="text-graphite">Reader access</span>
            <strong className="font-medium wrap-anywhere">
              {settings.readReplicaCount
                ? `${settings.readReplicaCount} direct ${settings.readReplicaCount === 1 ? "replica" : "replicas"}`
                : "Writer fallback"}
            </strong>
          </div>
        </div>
        <p className="mt-0 mb-2 text-caption text-graphite">
          Reader access is opt-in per workload. Replica reads can be stale; development uses the
          same local instance for both roles.
        </p>
      </InspectorSection>
      <InspectorSection
        title="Production RDS"
        description="Declaration defaults for RDS. Local PostgreSQL is configured separately in Compose."
      >
        <div className="flex flex-wrap gap-2" data-slot="database-policy-summary">
          <span className={policySummaryClasses}>{settings.instanceClass}</span>
          <span className={policySummaryClasses}>PostgreSQL {settings.engineVersion}</span>
          <span className={policySummaryClasses}>
            {settings.allocatedStorage}–{settings.maxAllocatedStorage || settings.allocatedStorage}{" "}
            GiB
          </span>
        </div>
        <p className="mt-0 mb-2 text-caption text-graphite">
          {settings.multiAz ? "Multi-AZ standby" : "Single-AZ writer"} ·{" "}
          {settings.readReplicaCount
            ? `${settings.readReplicaCount} read replicas`
            : "No read replicas"}
        </p>
        {settings.multiAz && !database.settings.multiAz ? (
          <p className="mt-0 mb-2 text-caption">
            Multi-AZ upgrade staged. Review the source diff and production synth before a separate
            deployment.
          </p>
        ) : null}
        {error ? (
          <p
            id={`${prefix}-error`}
            className="mt-0 mb-2 text-refuse wrap-anywhere text-caption"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </InspectorSection>
      {groups.map((group) => (
        <InspectorDisclosure
          key={group.id}
          title={group.title}
          open={
            error &&
            fields.some(
              (field) => field.group === group.id && error.includes(`settings.${field.key}`),
            )
              ? true
              : undefined
          }
          data-slot="database-policy-group"
        >
          <p className="mt-0 mb-2 text-caption text-graphite">{group.help}</p>
          {inputs(group.id)}
          {group.id === "resilience" || group.id === "connections" ? (
            <p className="mt-0 mb-2 text-caption text-graphite">
              Standby instances, read replicas and Proxy add billed capacity.
            </p>
          ) : null}
          {group.id === "maintenance" ? (
            <>
              <div data-slot="fields">
                {(["postgresql", "upgrade"] as const).map((name) => (
                  <div className={inspectorSwitchFieldClasses} key={name} data-slot="field">
                    <label
                      className={inspectorLabelClasses}
                      htmlFor={`${prefix}-logs-${name}`}
                      data-slot="field-label"
                    >
                      {name === "postgresql" ? "PostgreSQL logs" : "Upgrade logs"}
                    </label>
                    <span className={inspectorControlClasses} data-slot="control">
                      <InspectorSwitch
                        id={`${prefix}-logs-${name}`}
                        label={name === "postgresql" ? "PostgreSQL logs" : "Upgrade logs"}
                        disabled={disabled}
                        checked={settings.logExports.includes(name)}
                        onChange={(checked) =>
                          update(
                            "logExports",
                            checked
                              ? [...settings.logExports, name]
                              : settings.logExports.filter((item) => item !== name),
                          )
                        }
                      />
                    </span>
                  </div>
                ))}
              </div>
              {Object.hasOwn(authored, "logExports") ? (
                <button
                  className={cx(buttonClasses({ variant: "link" }), "text-caption")}
                  disabled={disabled}
                  onClick={() => update("logExports", undefined)}
                >
                  Use framework default for log exports
                </button>
              ) : null}
            </>
          ) : null}
        </InspectorDisclosure>
      ))}
      <InspectorDisclosure title="Connection pool defaults" data-slot="database-pool-defaults">
        <p className="mt-0 mb-2 text-caption text-graphite">
          Limits apply per warm process and per writer/reader connection, not across the entire
          database. Workloads can override these shared defaults.
        </p>
        <SharedDefaults
          embedded
          families={["database"]}
          title="Per-process pools"
          description="The framework resolves these limits for each declared database consumer."
        />
      </InspectorDisclosure>
      <InspectorDisclosure title="Deployment overrides">
        <p className="mt-0 mb-2 text-caption text-graphite">
          DATABASE_* inputs and CDK context take precedence over these declaration defaults.
          Synthesis resolves the effective AWS settings.
        </p>
        {uniqueOverrides.map(({ file, entries }) => (
          <div key={file.mode}>
            <button
              className={cx(buttonClasses({ variant: "link" }), "text-caption")}
              onClick={() => select(`envfile:${file.mode}`)}
            >
              {file.path}
            </button>
            <p className="mt-0 mb-2 text-caption text-graphite">
              {entries.length} database setting entries. Empty entries do not override defaults.
            </p>
            <details>
              <InspectorSummary>Setting names</InspectorSummary>
              <ul className="text-caption">
                {entries.map((entry) => (
                  <li key={entry.name}>
                    <code>{entry.name}</code>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))}
      </InspectorDisclosure>
    </>
  );
}
