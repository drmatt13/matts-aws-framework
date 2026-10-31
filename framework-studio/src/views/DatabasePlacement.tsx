import {
  databaseCardClasses,
  databaseCardIdentityClasses,
  databaseCardTitleClasses,
  databaseCardReferenceClasses,
} from "./inspector/database-styles";
import { InspectorSummary, InspectorSection } from "./InspectorUI";
import { Select } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorFieldClasses,
  inspectorLabelClasses,
  inspectorControlClasses,
  inspectorActionGroupClasses,
  inspectorNoteClasses,
} from "../inspector-ui";
import { useId } from "react";
import { databaseConsumers } from "../../shared/managed-database";
import { useStudio } from "../studio";

import { EntityIcon } from "./EntityIcon";

/** Changing a stateful database's home is a coordinated source review, never a live move. */
export function DatabasePlacement() {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const prefix = useId();
  const database = model.managedDatabase;
  if (!database) return null;
  const current = draft.databasePlacement(database.id) ?? {
    kind: "databasePlacement" as const,
    database: database.id,
    vpc: database.networkId,
    subnet: database.subnet,
  };
  const changed = current.vpc !== database.networkId || current.subnet !== database.subnet;
  const moving = current.vpc !== database.networkId;
  const networks = model.networks ?? [];
  const network = networks.find((item) => item.id === current.vpc);
  const consumers = databaseConsumers(Object.values(snapshot.models), database.id);
  const disabled =
    !!draftState.busy ||
    live.evaluating ||
    !!model.stale ||
    draft.conflict ||
    database.consumers === undefined;
  const error = draftState.entries.find(
    (entry) => entry.kind === "databasePlacement" && entry.edit.database === database.id,
  )?.error;
  return (
    <InspectorSection
      title="Database home"
      description="Production placement. Local PostgreSQL keeps using Compose networking."
    >
      <button
        type="button"
        className={cx(
          databaseCardClasses,
          "w-full cursor-pointer border-rule-strong text-left text-ink [font:inherit] hover:border-graphite hover:bg-wash",
        )}
        onClick={() => select(`island:vpc:${current.vpc}`)}
        data-slot="database-home"
      >
        <EntityIcon icon="endpoint" size={32} />
        <span className={databaseCardIdentityClasses}>
          <strong className={databaseCardTitleClasses}>{network?.name ?? current.vpc}</strong>
          <code className={databaseCardReferenceClasses}>
            {network?.cidr ?? current.vpc} · {current.subnet} subnets
          </code>
        </span>
        <span className="flex-none text-caption text-graphite">
          {changed ? "Draft" : "View VPC"}
        </span>
      </button>
      <p className="mb-2 mt-2 text-caption text-graphite">
        This VPC is required while it owns the application database. Reassign the database and its
        consumers before removing the declaration.
      </p>
      <details open={changed || undefined} data-slot="database-placement-editor">
        <InspectorSummary className="cursor-pointer py-2 text-label font-medium">
          Change placement
        </InspectorSummary>
        <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled}>
          <div data-slot="fields">
            <div className={inspectorFieldClasses} data-slot="field">
              <label
                className={inspectorLabelClasses}
                htmlFor={`${prefix}-vpc`}
                data-slot="field-label"
              >
                VPC
              </label>
              <span className={inspectorControlClasses} data-slot="control">
                <Select
                  className="w-full"
                  id={`${prefix}-vpc`}
                  aria-label="Database VPC"
                  value={current.vpc}
                  onChange={(event) =>
                    draft.setDatabasePlacement({ ...current, vpc: event.target.value })
                  }
                >
                  {networks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? item.id} · {item.cidr}
                    </option>
                  ))}
                </Select>
              </span>
            </div>
            <div className={inspectorFieldClasses} data-slot="field">
              <label
                className={inspectorLabelClasses}
                htmlFor={`${prefix}-subnet`}
                data-slot="field-label"
              >
                Subnets
              </label>
              <span className={inspectorControlClasses} data-slot="control">
                <Select
                  className="w-full"
                  id={`${prefix}-subnet`}
                  aria-label="Database subnets"
                  value={current.subnet}
                  onChange={(event) =>
                    draft.setDatabasePlacement({
                      ...current,
                      subnet: event.target.value as "private" | "isolated",
                    })
                  }
                >
                  <option value="isolated">Isolated</option>
                  <option value="private">Private</option>
                </Select>
              </span>
            </div>
          </div>
        </fieldset>
        <p className={cx(inspectorNoteClasses, "mt-1")}>
          Databases are never public. Workload subnet tiers stay as declared.
        </p>
        <div className={cx(inspectorActionGroupClasses, "mt-4")}>
          {networks.length < 2 ? (
            <p className={inspectorNoteClasses}>Create another VPC to choose a different home.</p>
          ) : null}
          <button
            type="button"
            className={buttonClasses({ variant: "quiet" })}
            disabled={disabled}
            onClick={() => draft.requestNavigation(() => draft.beginCreation("vpc"))}
          >
            Create a VPC
          </button>
        </div>
        {moving ? (
          <div
            className="my-3 rounded-md border border-rule-strong bg-wash p-3"
            role="status"
            data-slot="database-placement-impact"
          >
            <strong className="text-label font-medium">Coordinated placement review</strong>
            <p className="my-2 text-caption">
              The database and {consumers.length} connected framework{" "}
              {consumers.length === 1 ? "workload" : "workloads"} will use{" "}
              {network?.name ?? current.vpc}. Their database access, IAM login and connection
              settings are preserved.
            </p>
            <ul className="pl-4.5 text-caption wrap-anywhere">
              {consumers.map((consumer) => (
                <li key={consumer.target}>
                  <code>{consumer.target}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p
          className="mt-4 mb-2 border-l-2 border-prod pl-3 text-caption text-graphite"
          data-slot="database-migration-note"
        >
          For an existing RDS deployment, a VPC change needs a planned migration/cutover. Saving
          source does not copy data or relocate a running database. Review both synths and native
          CDK wiring before a separately authorized deployment.
        </p>
        {changed ? (
          <button
            className={cx(buttonClasses({ variant: "link" }), "text-caption")}
            disabled={disabled}
            onClick={() =>
              draft.setDatabasePlacement({
                kind: "databasePlacement",
                database: database.id,
                vpc: database.networkId,
                subnet: database.subnet,
              })
            }
          >
            Restore current placement
          </button>
        ) : null}
        {database.consumers === undefined ? (
          <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption">
            Restart Studio to load the database consumer index before changing placement.
          </p>
        ) : null}
        {error ? (
          <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption" role="alert">
            {error}
          </p>
        ) : null}
      </details>
    </InspectorSection>
  );
}
