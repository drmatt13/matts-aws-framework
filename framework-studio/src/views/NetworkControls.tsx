import { sourceEditBlocked } from "../editing-state";
import { InspectorDisclosure, InspectorSection, InspectorSwitch } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorFieldClasses,
  inspectorSwitchFieldClasses,
  inspectorWideFieldClasses,
  inspectorLabelClasses,
  inspectorControlClasses,
  inspectorHelpClasses,
  inspectorFullWidthHelpClasses,
  inspectorNoteClasses,
  inspectorIntroClasses,
  inspectorActionGroupClasses,
} from "../inspector-ui";
import { CREATORS } from "../../shared/creation";
import type { ModelTarget } from "../../shared/model";
import type { NetworkSettings, PlacementEdit } from "../../shared/networks";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";

import { InterfaceEndpointPicker } from "./InterfaceEndpointPicker";
import { useId, type ReactNode } from "react";

/** Only TypeScript Lambdas, services and tasks choose their own placement in Studio. */
export function placementEditable(target: ModelTarget): boolean {
  return (
    ["lambda", "service", "task"].includes(target.kind) &&
    (target.compute.kind !== "lambda" || target.compute.implementation === "typescript")
  );
}

/**
 * One placement edit keeps VPC references and subnet selection in the same reviewed transaction.
 * Label, select and help stack on one left edge; `help` explains the placement beneath the last
 * select and describes both.
 */
export function PlacementControl({
  target,
  help,
}: {
  readonly target: ModelTarget;
  readonly help?: ReactNode;
}) {
  const { model, draft, draftState, live } = useStudio();
  const prefix = useId();
  if (!placementEditable(target)) return null;
  const lambda = target.kind === "lambda";
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const current: PlacementEdit = draft.placement(target.ref) ?? {
    target: target.ref,
    vpc: target.placement.kind === "vpc" ? target.placement.networkId : null,
    subnet: target.placement.kind === "vpc" ? target.placement.subnet : "none",
  };
  const helpText = help ? (
    <div id={`${prefix}-help`} className={cx(inspectorHelpClasses, "grid gap-1")} data-slot="note">
      {help}
    </div>
  ) : null;
  return (
    <div data-slot="fields">
      <div className={inspectorFieldClasses} data-slot="field">
        <label className={inspectorLabelClasses} htmlFor={`${prefix}-vpc`} data-slot="field-label">
          VPC
        </label>
        <span className={inspectorControlClasses} data-slot="control">
          <Select
            controlSize="panel"
            className="w-full"
            id={`${prefix}-vpc`}
            aria-label="Workload VPC"
            aria-describedby={help ? `${prefix}-help` : undefined}
            disabled={disabled}
            value={current.vpc ?? ""}
            onChange={(event) => {
              const vpc = event.target.value || null;
              draft.setPlacement({
                ...current,
                vpc,
                subnet: vpc ? (current.subnet === "none" ? "private" : current.subnet) : "none",
              });
            }}
          >
            {lambda ? <option value="">Outside VPCs</option> : null}
            {(model.networks ?? []).map((network) => (
              <option key={network.id} value={network.id}>
                {network.id} · {network.cidr}
              </option>
            ))}
          </Select>
        </span>
        {!current.vpc ? helpText : null}
      </div>
      {current.vpc ? (
        <div className={inspectorFieldClasses} data-slot="field">
          <label
            className={inspectorLabelClasses}
            htmlFor={`${prefix}-subnet`}
            data-slot="field-label"
          >
            Subnet
          </label>
          <span className={inspectorControlClasses} data-slot="control">
            <Select
              controlSize="panel"
              className="w-full"
              id={`${prefix}-subnet`}
              aria-label="Workload subnet"
              aria-describedby={help ? `${prefix}-help` : undefined}
              disabled={disabled}
              value={current.subnet}
              onChange={(event) =>
                draft.setPlacement({
                  ...current,
                  subnet: event.target.value as PlacementEdit["subnet"],
                })
              }
            >
              {(lambda ? ["private", "isolated"] : ["public", "private"]).map((subnet) => (
                <option key={subnet} value={subnet}>
                  {subnet}
                </option>
              ))}
            </Select>
          </span>
          {helpText}
        </div>
      ) : null}
      {target.origins.length > 1 || !model.networks?.length ? (
        <div className="mt-3 grid gap-1">
          {target.origins.length > 1 ? (
            <p className={inspectorNoteClasses}>Updates all routes sharing this workload.</p>
          ) : null}
          {!model.networks?.length ? (
            <p className={inspectorNoteClasses}>
              Create a VPC before placing this workload in a network.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function NetworkControls({ id }: { readonly id: string }) {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const prefix = useId();
  const network = model.networks?.find((network) => `island:vpc:${network.id}` === id);
  if (!network) return null;
  const settings = draft.network(network.id)!;
  const source = snapshot.source.entities[id]?.value;
  const fields = CREATORS.vpc.fields.filter(
    (field) => !["id", "name", "description", "endpoints", "tags"].includes(field.key),
  );
  const form = settings;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const update = (key: string, value: string | number | boolean) => {
    const next = { ...form, [key]: value };
    draft.setNetwork(network.id, next as NetworkSettings);
  };
  const error = draft
    .getSnapshot()
    .entries.find((entry) => entry.kind === "network" && entry.network === network.id)?.error;
  const assigned = Object.values(snapshot.models).some(
    (model) =>
      model.databaseNetworkId === network.id ||
      model.targets.some(
        (target) => target.placement.kind === "vpc" && target.placement.networkId === network.id,
      ),
  );
  const used =
    assigned ||
    Object.values(snapshot.models).some(
      (model) => model.networks?.find((item) => item.id === network.id)?.builtInProd,
    );
  const database = Object.values(snapshot.models).flatMap((graph) =>
    graph.managedDatabase?.networkId === network.id ? [graph.managedDatabase] : [],
  )[0];
  return (
    <>
      <InspectorSection
        title="VPC settings"
        description="Applies to this VPC and its assigned resources."
      >
        <p className={inspectorIntroClasses}>
          Identity: {network.id} · {network.constructId}
        </p>
        {database ? (
          <div
            className="my-3 p-3 border border-rule-strong rounded-md bg-wash"
            data-slot="network-database-home"
          >
            <strong className="text-label font-medium">Home of the application database</strong>
            <p className="my-2 text-caption text-graphite">
              This VPC cannot be removed while the database is placed here.
            </p>
            <button
              className={cx(buttonClasses({ variant: "link" }), "text-caption")}
              onClick={() => select(database.resource)}
            >
              Configure application PostgreSQL
            </button>
          </div>
        ) : null}
        <div data-slot="fields">
          {fields.map((field) => (
            <div
              className={
                field.type === "boolean" ? inspectorSwitchFieldClasses : inspectorFieldClasses
              }
              key={field.key}
              data-slot="field"
            >
              <label
                className={inspectorLabelClasses}
                htmlFor={`${prefix}-${field.key}`}
                data-slot="field-label"
              >
                {field.label}
              </label>
              <span className={inspectorControlClasses} data-slot="control">
                {field.type === "boolean" ? (
                  <InspectorSwitch
                    id={`${prefix}-${field.key}`}
                    label={field.label}
                    disabled={disabled}
                    checked={form[field.key as keyof typeof form] === true}
                    onChange={(checked) => update(field.key, checked)}
                    describedBy={field.help ? `${prefix}-${field.key}-help` : undefined}
                  />
                ) : (
                  <TextInput
                    controlSize="panel"
                    className="w-full flex-1"
                    id={`${prefix}-${field.key}`}
                    disabled={disabled}
                    type={field.type === "number" ? "number" : "text"}
                    value={String(form[field.key as keyof typeof form])}
                    onChange={(event) =>
                      update(
                        field.key,
                        field.type === "number" ? Number(event.target.value) : event.target.value,
                      )
                    }
                  />
                )}
              </span>
              {field.help ? (
                <span
                  id={`${prefix}-${field.key}-help`}
                  className={
                    field.type === "boolean" ? inspectorFullWidthHelpClasses : inspectorHelpClasses
                  }
                  data-slot="note"
                >
                  {field.help}
                </span>
              ) : null}
            </div>
          ))}
          <div className={inspectorWideFieldClasses} data-slot="endpoint-field">
            <label
              className={inspectorLabelClasses}
              htmlFor={`${prefix}-endpoints`}
              data-slot="field-label"
            >
              Interface endpoints
            </label>
            <InterfaceEndpointPicker
              id={`${prefix}-endpoints`}
              services={model.interfaceEndpointServices}
              selected={settings.endpoints}
              onChange={(endpoints) => draft.setNetwork(network.id, { ...settings, endpoints })}
              disabled={disabled}
              describedBy={`${prefix}-endpoints-help`}
            />
            <p id={`${prefix}-endpoints-help`} className={inspectorNoteClasses}>
              Each service incurs hourly charges in each zone and per GB.
            </p>
          </div>
        </div>
        {error ? (
          <p className="mt-3 mb-0 text-caption text-refuse wrap-anywhere" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 grid justify-items-start gap-2 border-t border-rule pt-3">
          <p className={inspectorNoteClasses}>
            CIDR or zone changes may replace attached infrastructure on deployment. NAT gateways and
            interface endpoints incur charges when built.
          </p>
          <p className={inspectorNoteClasses}>
            Local Compose networking is shared; the selected VPC controls declaration checks and
            existing Lambda egress rules.
          </p>
          <p className={inspectorNoteClasses}>
            All VPCs inherit the named deployment's region from cdk-app/cdk.json.
          </p>
          {source ? (
            <a
              className={cx(buttonClasses({ variant: "link" }), "text-caption")}
              href={editorLink(snapshot.repositoryRoot, source)}
            >
              Open VPC declaration in VS Code
            </a>
          ) : null}
        </div>
      </InspectorSection>
      <InspectorDisclosure title="Remove VPC">
        <p className={inspectorIntroClasses}>
          Removes this unused declaration and registry entry through diff review. Applying source
          does not delete AWS resources.
        </p>
        <div className={inspectorActionGroupClasses}>
          <button
            className={buttonClasses({ variant: "neutral" })}
            disabled={disabled || used || draft.dirty}
            onClick={() => {
              draft.removeNetwork(network.id);
              void draft.review();
            }}
          >
            Review VPC removal
          </button>
          {used ? (
            <p className={inspectorNoteClasses}>
              Reassign workloads, the database, and native resource references before removal.
            </p>
          ) : null}
        </div>
      </InspectorDisclosure>
    </>
  );
}
