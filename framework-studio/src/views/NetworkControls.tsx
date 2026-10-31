import { sourceEditBlocked } from "../editing-state";
import { InspectorSummary, InspectorSection, InspectorSwitch } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorFieldClasses,
  inspectorSwitchFieldClasses,
  inspectorWideFieldClasses,
  inspectorLabelClasses,
  inspectorFieldLabelClasses,
  inspectorControlClasses,
  inspectorHelpClasses,
  inspectorFullWidthHelpClasses,
} from "../inspector-ui";
import { CREATORS } from "../../shared/creation";
import type { ModelTarget } from "../../shared/model";
import type { NetworkSettings, PlacementEdit } from "../../shared/networks";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";

import { InterfaceEndpointPicker } from "./InterfaceEndpointPicker";
import { useId } from "react";

/** One placement edit keeps VPC references and subnet selection in the same reviewed transaction. */
export function PlacementControl({ target }: { readonly target: ModelTarget }) {
  const { model, draft, draftState, live } = useStudio();
  const prefix = useId();
  if (
    !["lambda", "service", "task"].includes(target.kind) ||
    (target.compute.kind === "lambda" && target.compute.implementation !== "typescript")
  )
    return null;
  const lambda = target.kind === "lambda";
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const current: PlacementEdit = draft.placement(target.ref) ?? {
    target: target.ref,
    vpc: target.placement.kind === "vpc" ? target.placement.networkId : null,
    subnet: target.placement.kind === "vpc" ? target.placement.subnet : "none",
  };
  return (
    <div data-slot="fields">
      <div className={inspectorFieldClasses} data-slot="field">
        <label className={inspectorLabelClasses} htmlFor={`${prefix}-vpc`} data-slot="field-label">
          VPC
        </label>
        <span className={inspectorControlClasses} data-slot="control">
          <Select
            className="w-full"
            id={`${prefix}-vpc`}
            aria-label="Workload VPC"
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
              className="w-full"
              id={`${prefix}-subnet`}
              aria-label="Workload subnet"
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
        </div>
      ) : null}
      {target.origins.length > 1 ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          Updates all routes sharing this workload.
        </p>
      ) : null}
      {!model.networks?.length ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          Create a VPC before placing this workload in a network.
        </p>
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
    <InspectorSection
      title="VPC settings"
      description="Applies to this VPC and its assigned resources."
    >
      <p className="mt-0 mb-2 text-caption text-graphite">
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
            className={inspectorFieldLabelClasses({ stacked: true })}
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
          <p id={`${prefix}-endpoints-help`} className="mt-0 mb-2 text-caption text-graphite">
            Each service incurs hourly charges in each zone and per GB.
          </p>
        </div>
      </div>
      {error ? (
        <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-0 mb-2 text-caption text-graphite">
        CIDR or zone changes may replace attached infrastructure on deployment. NAT gateways and
        interface endpoints incur charges when built.
      </p>
      <p className="mt-0 mb-2 text-caption text-graphite">
        Local Compose networking is shared; the selected VPC controls declaration checks and
        existing Lambda egress rules.
      </p>
      <p className="mt-0 mb-2 text-caption text-graphite">
        All VPCs inherit the named deployment's region from cdk-app/cdk.json.
      </p>
      {source ? (
        <a className="text-caption" href={editorLink(snapshot.repositoryRoot, source)}>
          Open VPC declaration in VS Code
        </a>
      ) : null}
      <details>
        <InspectorSummary>Remove VPC</InspectorSummary>
        <p className="mt-0 mb-2 text-caption text-graphite">
          Removes this unused declaration and registry entry through diff review. Applying source
          does not delete AWS resources.
        </p>
        {used ? (
          <p className="mt-0 mb-2 text-caption text-graphite">
            Reassign workloads, the database, and native resource references before removal.
          </p>
        ) : null}
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
      </details>
    </InspectorSection>
  );
}
