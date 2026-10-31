import {
  inspectorHeaderClasses,
  inspectorSectionClasses,
} from "../inspector-ui";
import { EntityName } from "./EntityName";
import {
  InspectorDisclosure,
  InspectorSummary,
  InspectorCount,
  InspectorKind,
  InspectorSwitch,
} from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { Fragment, useId, useState } from "react";
import { Plus, Trash2, ArrowUpRight, ChevronRight, Pencil } from "lucide-react";
import {
  CLIENT_ENVIRONMENT_FILES,
  CLIENT_ENVIRONMENT_FILE,
  clientBindingFor,
  isSplitMapping,
  type ClientEnvironmentFile,
  type ClientEnvironmentBinding,
  type ClientEnvironmentMapping,
  type ClientReferenceOption,
} from "../../shared/client-environment";
import { previewClientBinding } from "../../shared/client-environment-preview";
import type { ModelResource } from "../../shared/model";
import { useStudio } from "../studio";
import { Description } from "./Description";
import { EntityIcon } from "./EntityIcon";
import { EnvironmentPills } from "./DeploymentBadge";

const mappingLabelClasses = "grid min-w-0 gap-1 text-caption";
const mappingExpressionClasses =
  "min-w-0 text-caption leading-[1.5] text-graphite wrap-anywhere group-hover/mapping:text-ink";

const sourceKinds = {
  input: "Input parameter",
  output: "Stack output",
  region: "Stack region",
  endpoint: "URL from input parameter",
  empty: "Empty value",
} as const;

function InputSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly ClientReferenceOption[];
  disabled?: boolean;
  onChange: (name: string) => void;
}) {
  const { model } = useStudio();
  const inputs = options.filter((option) => option.binding.kind === "input");
  const alias = model.resources.find(
    (resource) => resource.kind === "input" && resource.fromEnv === value,
  )?.id;
  const selected = inputs.some(
    (option) =>
      option.binding.kind === "input" && option.binding.name === value,
  )
    ? value
    : (alias ?? value);
  return (
    <Select
      controlSize="panel"
      className="w-full"
      aria-label={label}
      value={selected}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" disabled>
        Select input parameter…
      </option>
      {selected &&
      !inputs.some(
        (option) =>
          option.binding.kind === "input" && option.binding.name === selected,
      ) ? (
        <option value={selected}>{value} (undeclared)</option>
      ) : null}
      {inputs.map((option) => (
        <option
          key={option.id}
          value={option.binding.kind === "input" ? option.binding.name : ""}
        >
          {option.label}
        </option>
      ))}
    </Select>
  );
}

function SourceControls({
  name,
  binding,
  options,
  disabled,
  onChange,
}: {
  name: string;
  binding: ClientEnvironmentBinding;
  options: readonly ClientReferenceOption[];
  disabled: boolean;
  onChange: (binding: ClientEnvironmentBinding) => void;
}) {
  const prefix = useId();
  const { model } = useStudio();
  const stacks = [
    ...new Set(
      options.flatMap((option) =>
        option.binding.kind ===
          (binding.kind === "output" ? "output" : "region") &&
        "stack" in option.binding
          ? [option.binding.stack]
          : [],
      ),
    ),
  ];
  const outputs =
    binding.kind === "output"
      ? options.flatMap((option) =>
          option.binding.kind === "output" &&
          option.binding.stack === binding.stack
            ? [...option.binding.outputs]
            : [],
        )
      : [];
  return (
    <fieldset
      className="m-0 grid min-w-0 gap-3 border-0 p-0"
      disabled={disabled}
      data-slot="client-mapping-controls"
    >
      <label className={mappingLabelClasses}>
        Value from
        <Select
          controlSize="panel"
          className="w-full"
          aria-label={`Source type for ${name}`}
          value={binding.kind}
          onChange={(event) => {
            const kind = event.target.value as ClientEnvironmentBinding["kind"];
            if (kind === binding.kind) return;
            const matchingInput = options.find((option) => {
              if (option.binding.kind !== "input") return false;
              const inputName = option.binding.name;
              return (
                inputName === name ||
                model.resources.find((resource) => resource.id === inputName)
                  ?.fromEnv === name
              );
            });
            const next: ClientEnvironmentBinding =
              kind === "input"
                ? {
                    kind,
                    name:
                      matchingInput?.binding.kind === "input"
                        ? matchingInput.binding.name
                        : "",
                  }
                : kind === "output"
                  ? { kind, stack: "", outputs: [] }
                  : kind === "region"
                    ? { kind, stack: "" }
                    : kind === "endpoint"
                      ? { kind, protocol: "http", port: "" }
                      : { kind: "empty" };
            onChange({
              ...next,
              ...(binding.when ? { when: binding.when } : {}),
            });
          }}
        >
          {Object.entries(sourceKinds).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </Select>
      </label>
      {binding.kind === "input" ? (
        <label className={mappingLabelClasses}>
          Input parameter
          <InputSelect
            label={`Mapping for ${name}`}
            value={binding.name}
            options={options}
            onChange={(input) => onChange({ ...binding, name: input })}
          />
        </label>
      ) : null}
      {binding.kind === "region" || binding.kind === "output" ? (
        <label className={mappingLabelClasses}>
          Stack
          <Select
            controlSize="panel"
            className="w-full"
            aria-label={`Stack for ${name}`}
            value={binding.stack}
            onChange={(event) =>
              onChange(
                binding.kind === "region"
                  ? { ...binding, stack: event.target.value }
                  : { ...binding, stack: event.target.value, outputs: [] },
              )
            }
          >
            <option value="" disabled>
              Select stack…
            </option>
            {binding.stack && !stacks.includes(binding.stack) ? (
              <option value={binding.stack}>
                {binding.stack} (unavailable)
              </option>
            ) : null}
            {stacks.map((stack) => (
              <option key={stack}>{stack}</option>
            ))}
          </Select>
        </label>
      ) : null}
      {binding.kind === "output" ? (
        <>
          <label className={mappingLabelClasses}>
            Public output
            <Select
              controlSize="panel"
              className="w-full"
              aria-label={`Mapping for ${name}`}
              value={binding.outputs[0] ?? ""}
              disabled={!binding.stack}
              onChange={(event) =>
                onChange({ ...binding, outputs: [event.target.value] })
              }
            >
              <option value="" disabled>
                Select output…
              </option>
              {binding.outputs[0] && !outputs.includes(binding.outputs[0]) ? (
                <option value={binding.outputs[0]}>
                  {binding.outputs[0]} (unavailable)
                </option>
              ) : null}
              {outputs.map((output) => (
                <option key={output}>{output}</option>
              ))}
            </Select>
          </label>
          {binding.outputs.length > 1 ? (
            <p className="m-0 text-caption text-graphite">
              Fallback outputs:{" "}
              <code>{binding.outputs.slice(1).join(", ")}</code>. Selecting
              another output replaces this list.
            </p>
          ) : null}
          <div
            className="flex min-w-0 items-center justify-between gap-3 text-label font-medium"
            data-slot="setting-switch"
          >
            <label
              className={cx(mappingLabelClasses, "wrap-anywhere")}
              htmlFor={`${prefix}-optional`}
            >
              Allow empty when stack is off
            </label>
            <InspectorSwitch
              id={`${prefix}-optional`}
              label={`Allow empty ${name}`}
              checked={!!binding.optional}
              onChange={(checked) => {
                const { optional: _old, ...reference } = binding;
                onChange(
                  checked ? { ...reference, optional: true } : reference,
                );
              }}
            />
          </div>
        </>
      ) : null}
      {binding.kind === "endpoint" ? (
        <>
          <div
            className="grid grid-cols-[100px_minmax(0,1fr)] gap-2 inspector-420:grid-cols-[minmax(0,1fr)]"
            data-slot="client-mapping-url"
          >
            <label className={mappingLabelClasses}>
              Protocol
              <Select
                controlSize="panel"
                className="w-full"
                aria-label={`Protocol for ${name}`}
                value={binding.protocol}
                onChange={(event) =>
                  onChange({
                    ...binding,
                    protocol: event.target.value as typeof binding.protocol,
                  })
                }
              >
                {["http", "https", "ws", "wss"].map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </Select>
            </label>
            <label className={mappingLabelClasses}>
              Hostname
              <TextInput
                controlSize="panel"
                className="w-full"
                aria-label={`Hostname for ${name}`}
                value={binding.host ?? "localhost"}
                onChange={(event) =>
                  onChange({ ...binding, host: event.target.value })
                }
              />
            </label>
          </div>
          <label className={mappingLabelClasses}>
            Port input parameter
            <InputSelect
              label={`Port input for ${name}`}
              value={binding.port}
              options={options}
              onChange={(port) => onChange({ ...binding, port })}
            />
          </label>
          <div
            className="flex min-w-0 items-center justify-between gap-3 text-label font-medium"
            data-slot="setting-switch"
          >
            <label
              className={cx(mappingLabelClasses, "wrap-anywhere")}
              htmlFor={`${prefix}-override`}
            >
              Use a URL override when set
            </label>
            <InspectorSwitch
              id={`${prefix}-override`}
              label={`Use URL override for ${name}`}
              checked={binding.override !== undefined}
              onChange={(checked) => {
                const { override: _old, ...reference } = binding;
                onChange(
                  checked ? { ...reference, override: name } : reference,
                );
              }}
            />
          </div>
          <InputSelect
            label={`Override input for ${name}`}
            value={binding.override ?? name}
            options={options}
            disabled={binding.override === undefined}
            onChange={(override) => onChange({ ...binding, override })}
          />
          <p className="m-0 text-caption text-graphite">
            The override takes priority. When empty, the URL uses the hostname
            and port above.
          </p>
        </>
      ) : null}
      <div
        className="flex min-w-0 items-center justify-between gap-3 text-label font-medium"
        data-slot="setting-switch"
      >
        <label
          className={cx(mappingLabelClasses, "wrap-anywhere")}
          htmlFor={`${prefix}-when`}
        >
          Use an input condition
        </label>
        <InspectorSwitch
          id={`${prefix}-when`}
          label={`Use input condition for ${name}`}
          checked={!!binding.when}
          onChange={(checked) => {
            const { when: _old, ...reference } = binding;
            onChange(
              checked
                ? { ...reference, when: { input: "", equals: "true" } }
                : reference,
            );
          }}
        />
      </div>
      {binding.when ? (
        <>
          <label className={mappingLabelClasses}>
            Condition input parameter
            <InputSelect
              label={`Condition input for ${name}`}
              value={binding.when.input}
              options={options}
              onChange={(input) =>
                onChange({ ...binding, when: { ...binding.when!, input } })
              }
            />
          </label>
          <label className={mappingLabelClasses}>
            Equals
            <TextInput
              controlSize="panel"
              className="w-full"
              aria-label={`Condition value for ${name}`}
              value={binding.when.equals}
              onChange={(event) =>
                onChange({
                  ...binding,
                  when: { ...binding.when!, equals: event.target.value },
                })
              }
            />
          </label>
          <p className="m-0 text-caption text-graphite">
            Written blank in an environment where the input does not match.
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

const MODE_LABELS = { dev: "Development", prod: "Production" } as const;

/**
 * Compact source overview; each editor participates in the shared review/apply transaction.
 *
 * Where a field is generated is not a setting. Each environment previews the field's own recipe,
 * and the Dev / Prod pills report the result: an input outside that environment, or an optional
 * one with no value and no default, leaves the field blank there.
 */
export function ClientEnvironmentMappings({
  file,
}: {
  readonly file: ClientEnvironmentFile;
}) {
  const { model, snapshot, select, draft, draftState, live } = useStudio();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("VITE_");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rename, setRename] = useState<{
    name: string;
    value: string;
    error: string;
  }>();
  const [error, setError] = useState("");
  const mappings = draft.clientMappings();
  const disabled =
    !!draftState.busy || draft.conflict || live.evaluating || !!file.problem;
  const update = (name: string, mapping: ClientEnvironmentMapping) =>
    draft.setClientMappings({ ...mappings, [name]: mapping });
  const remove = (name: string) =>
    draft.setClientMappings(
      Object.fromEntries(
        Object.entries(mappings).filter(([key]) => key !== name),
      ),
    );
  const renameField = () => {
    if (!rename) return;
    const name = rename.value.trim();
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) {
      setRename({
        ...rename,
        error:
          "Use VITE_ followed by uppercase letters, digits or underscores.",
      });
      return;
    }
    if (name !== rename.name && Object.hasOwn(mappings, name)) {
      setRename({ ...rename, error: "This field already exists." });
      return;
    }
    draft.setClientMappings(
      Object.fromEntries(
        Object.entries(mappings).map(([key, value]) => [
          key === rename.name ? name : key,
          value,
        ]),
      ),
    );
    if (expanded === rename.name) setExpanded(name);
    setFilter("");
    setRename(undefined);
  };
  const add = () => {
    const name = newName.trim();
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) {
      setError(
        "Use VITE_ followed by uppercase letters, digits or underscores.",
      );
      return;
    }
    if (Object.hasOwn(mappings, name)) {
      setError("This field already exists. Search for it below.");
      return;
    }
    draft.setClientMappings({ ...mappings, [name]: { kind: "empty" } });
    setExpanded(name);
    setFilter("");
    setAdding(false);
    setNewName("VITE_");
    setError("");
  };
  const rows = Object.entries(mappings).map(([name, mapping]) => {
    const previews = {
      dev: previewClientBinding(
        name,
        clientBindingFor(mapping, "dev"),
        snapshot.models.dev,
      ),
      prod: previewClientBinding(
        name,
        clientBindingFor(mapping, "prod"),
        snapshot.models.prod,
      ),
    };
    return { name, mapping, previews, split: isSplitMapping(mapping) };
  });
  const searchText = ({ name, mapping, previews }: (typeof rows)[number]) =>
    [
      name,
      ...(["dev", "prod"] as const).flatMap((mode) => [
        sourceKinds[clientBindingFor(mapping, mode).kind],
        previews[mode].expression,
        ...previews[mode].sources.map((source) => source.label),
      ]),
    ].join(" ");
  const matches = rows.filter((row) =>
    searchText(row).toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const editError = draftState.entries.find(
    (entry) => entry.kind === "clientEnvironment",
  )?.error;
  return (
    <section
      className={inspectorSectionClasses}
      data-slot="client-mapping-editor"
    >
      <div
        className="mb-4 grid gap-2"
        data-slot="client-mapping-context"
      >
        <details
          className="text-caption text-graphite"
          data-slot="client-mapping-help"
        >
          <InspectorSummary className="cursor-pointer">
            How mappings and files work
          </InspectorSummary>
          <p className="mt-2 mb-0 wrap-anywhere">
            Dev / Prod shows where a source supplies a value. Expand a field to
            edit its mapping.
          </p>
          <p className="mt-2 mb-0 wrap-anywhere">
            Source parameters use their declared values. Linked parameters read
            each environment's values or defaults from{" "}
            <button
              className={buttonClasses({ variant: "link" })}
              disabled={draft.dirty}
              onClick={() => select("envfile:dev")}
            >
              cdk-app/.env.dev
            </button>{" "}
            and{" "}
            <button
              className={buttonClasses({ variant: "link" })}
              disabled={draft.dirty}
              onClick={() => select("envfile:prod")}
            >
              cdk-app/.env.prod
            </button>
            . Stack outputs and regions refer to that environment's deployment.
          </p>
          <p className="mt-2 mb-0 wrap-anywhere">
            One source serves both environments unless a field's sources differ.
            Review and apply saves references in{" "}
            <code>framework-config/client-environment.ts</code>. This editor
            does not generate client files or load deployed values.
          </p>
          <p className="mt-2 mb-0 wrap-anywhere">
            An environment export writes{" "}
            <code>client-app/.env.development.local</code> or{" "}
            <code>client-app/.env.production.local</code>, which Vite reads over{" "}
            <code>client-app/.env</code>. A blank field is written blank, so
            nothing from <code>client-app/.env</code> shows through. Renaming a
            field changes its exported name in both; update any application code
            that reads its old name.
          </p>
          <p className="mt-2 mb-0 wrap-anywhere">
            Client settings are public in the browser. Secret inputs are
            excluded.
          </p>
          <p className="mt-2 mb-0 wrap-anywhere">
            An input that is not declared in an environment, or has no value and
            no default there, leaves the field blank.
          </p>
        </details>
      </div>
      <div
        className="flex items-center justify-between gap-2"
        data-slot="client-mapping-toolbar"
      >
        <h3 className="m-0 flex items-center gap-2 text-label font-semibold text-balance">
          Fields
          <InspectorCount>
            {filter ? `${matches.length} / ` : ""}
            {rows.length}
          </InspectorCount>
        </h3>
        <button
          className={cx(
            buttonClasses({ variant: "quiet" }),
            "[&]:gap-1 text-caption",
          )}
          disabled={disabled}
          onClick={() => {
            setAdding(!adding);
            setError("");
          }}
        >
          <Plus size={14} aria-hidden />
          Add field
        </button>
      </div>
      {adding ? (
        <form
          className="my-2.5 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5 inspector-420:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
          data-slot="client-mapping-add"
        >
          <TextInput
            controlSize="panel"
            className="w-full inspector-420:col-span-full"
            autoFocus
            aria-label="New client field name"
            autoComplete="off"
            spellCheck={false}
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
              setError("");
            }}
          />
          <button
            className={cx(
              buttonClasses({ variant: "primary" }),
              "text-caption",
            )}
            type="submit"
            disabled={disabled}
            data-variant="primary"
          >
            Add
          </button>
          <button
            className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
            type="button"
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
          <p className="col-span-full m-0 text-caption text-graphite">
            Starts blank in both environments. Choose its source next.
          </p>
          {error ? (
            <p
              role="alert"
              className="col-span-full m-0 text-refuse wrap-anywhere text-caption"
            >
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <TextInput
        controlSize="panel"
        type="search"
        className="mt-2 w-full"
        aria-label="Search client mappings"
        placeholder="Find a field or source…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        data-slot="client-mapping-search"
      />
      {file.problem ? (
        <p role="alert" className="mt-0 mb-2 text-refuse wrap-anywhere">
          {file.problem}
        </p>
      ) : null}
      <ul
        className="mx-0 mt-3 mb-0 list-none p-0"
        data-slot="client-environment-mappings"
      >
        {matches.map(({ name, mapping, previews, split }) => {
          const saved = file.mappings[name];
          const changed =
            JSON.stringify(mappings[name]) !== JSON.stringify(saved);
          const open = expanded === name;
          const attention = (["dev", "prod"] as const).filter(
            (mode) => previews[mode].status === "unavailable",
          );
          const notes =
            previews.dev.note === previews.prod.note
              ? [previews.dev.note]
              : (["dev", "prod"] as const).map(
                  (mode) => `${MODE_LABELS[mode]}: ${previews[mode].note}`,
                );
          const source =
            previews[model.mode].sources[0] ??
            previews[model.mode === "dev" ? "prod" : "dev"].sources[0];
          return (
            <li key={name} className="grid min-w-0 gap-2 border-t border-rule py-4 last:pb-0">
              <div
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1"
                data-slot="client-mapping-name"
              >
                <strong className="min-w-0 text-caption leading-[1.5] wrap-anywhere">
                  <code className="text-caption">{name}</code>
                </strong>
                <EnvironmentPills
                  className="col-span-full row-start-2 justify-self-start"
                  label={`${name} environments`}
                  availability={{
                    dev: previews.dev.status === "mapped",
                    prod: previews.prod.status === "mapped",
                  }}
                  descriptions={{
                    dev: "generated in development",
                    prod: "generated in production",
                  }}
                  unavailableDescription="blank"
                />
                <button
                  className={iconButtonClasses({ className: "col-start-2 row-start-1" })}
                  title="Rename field in both environments"
                  aria-label={`Rename ${name}`}
                  disabled={disabled}
                  onClick={() => setRename({ name, value: name, error: "" })}
                >
                  <Pencil size={14} aria-hidden />
                </button>
                <button
                  className={iconButtonClasses({ className: "col-start-3 row-start-1" })}
                  title="Remove field from both environments"
                  aria-label={`Remove ${name}`}
                  disabled={disabled}
                  onClick={() => remove(name)}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              {rename?.name === name ? (
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameField();
                  }}
                  data-slot="client-mapping-rename"
                >
                  <TextInput
                    controlSize="panel"
                    className="w-full"
                    autoFocus
                    aria-label={`New name for ${name}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={rename.value}
                    onChange={(event) =>
                      setRename({
                        ...rename,
                        value: event.target.value,
                        error: "",
                      })
                    }
                  />
                  <div
                    className="flex flex-wrap justify-between gap-2"
                    data-slot="client-mapping-actions"
                  >
                    <span className="text-caption text-graphite">
                      Renames the mapping in both environments. Update
                      application references to the old{" "}
                      <code>import.meta.env</code> key separately.
                    </span>
                    <button
                      className={cx(
                        buttonClasses({ variant: "quiet" }),
                        "text-caption",
                      )}
                      type="button"
                      onClick={() => setRename(undefined)}
                    >
                      Cancel rename
                    </button>
                    <button
                      className={cx(
                        buttonClasses({ variant: "primary" }),
                        "text-caption",
                      )}
                      type="submit"
                      disabled={disabled}
                      data-variant="primary"
                    >
                      Save name
                    </button>
                  </div>
                  {rename.error ? (
                    <p
                      role="alert"
                      className="m-0 text-caption text-refuse wrap-anywhere"
                    >
                      {rename.error}
                    </p>
                  ) : null}
                </form>
              ) : null}
              <button
                className="group/mapping grid min-w-0 w-full cursor-pointer gap-2 rounded-sm border-0 bg-transparent p-0 text-left text-ink"
                aria-label={`Edit mapping for ${name}`}
                aria-expanded={open}
                aria-controls={`mapping-${name}`}
                onClick={() => setExpanded(open ? null : name)}
                data-slot="client-mapping-summary"
              >
                <span
                  className="flex min-w-0 items-start gap-2 text-caption text-graphite"
                  data-slot="client-mapping-summary-heading"
                >
                  <span className="min-w-0 flex-1">
                    {split
                      ? "Different sources"
                      : sourceKinds[clientBindingFor(mapping, "dev").kind]}
                  </span>
                  <span
                    className={
                      attention.length
                        ? "text-refuse wrap-anywhere"
                        : "text-graphite"
                    }
                  >
                    {changed ? "Edited" : ""}
                    {changed && attention.length ? " · " : ""}
                    {attention.length
                      ? `Needs attention in ${attention.map((mode) => MODE_LABELS[mode]).join(" and ")}`
                      : ""}
                  </span>
                  <ChevronRight
                    size={14}
                    className={cx(
                      "flex-none transition-transform duration-150",
                      open && "rotate-90",
                    )}
                    aria-hidden
                  />
                </span>
                {split ? (
                  (["dev", "prod"] as const).map((mode) => (
                    <span
                      key={mode}
                      className="grid min-w-0 grid-cols-[4ch_minmax(0,1fr)] items-baseline gap-2"
                    >
                      <span className="text-meta text-graphite">
                        {mode === "dev" ? "Dev" : "Prod"}
                      </span>
                      <code className={mappingExpressionClasses}>{previews[mode].expression}</code>
                    </span>
                  ))
                ) : (
                  <code className={mappingExpressionClasses}>
                    {previews.dev.expression}
                  </code>
                )}
              </button>
              {open ? (
                <div
                  id={`mapping-${name}`}
                  className="grid gap-3 p-3 border border-rule rounded-md bg-paper"
                  data-slot="client-mapping-detail"
                >
                  {split ? (
                    (["dev", "prod"] as const).map((mode) => (
                      <div
                        key={mode}
                        className="grid min-w-0 gap-2 border-b border-rule pb-3"
                        data-slot="client-mapping-mode"
                      >
                        <h4 className="m-0 flex items-center gap-2 text-caption font-semibold">
                          <span
                            aria-hidden
                            className={cx(
                              "size-1.5 shrink-0 rounded-full",
                              mode === "dev" ? "bg-dev" : "bg-prod",
                            )}
                          />
                          {MODE_LABELS[mode]}
                        </h4>
                        <SourceControls
                          name={`${name} in ${MODE_LABELS[mode]}`}
                          binding={clientBindingFor(mapping, mode)}
                          options={file.options}
                          disabled={disabled}
                          onChange={(next) =>
                            update(name, {
                              ...clientBindingSplit(mapping),
                              [mode]: next,
                            })
                          }
                        />
                      </div>
                    ))
                  ) : (
                    <SourceControls
                      name={name}
                      binding={clientBindingFor(mapping, "dev")}
                      options={file.options}
                      disabled={disabled}
                      onChange={(next) => update(name, next)}
                    />
                  )}
                  <div
                    className="flex min-w-0 items-center justify-between gap-3 text-label font-medium"
                    data-slot="setting-switch"
                  >
                    <label
                      className="min-w-0 wrap-anywhere"
                      htmlFor={`split-${name}`}
                    >
                      Different source in each environment
                    </label>
                    <InspectorSwitch
                      id={`split-${name}`}
                      label={`Different source in each environment for ${name}`}
                      checked={split}
                      disabled={disabled}
                      onChange={(checked) =>
                        update(
                          name,
                          checked
                            ? clientBindingSplit(mapping)
                            : clientBindingFor(mapping, model.mode),
                        )
                      }
                    />
                  </div>
                  {notes.map((note) => (
                    <p
                      key={note}
                      className={cx(
                        "m-0 text-caption",
                        attention.length
                          ? "text-refuse wrap-anywhere"
                          : "text-graphite",
                      )}
                      role="status"
                      data-slot="client-mapping-note"
                    >
                      {note}
                    </p>
                  ))}
                  <div
                    className="flex flex-wrap justify-between gap-2"
                    data-slot="client-mapping-actions"
                  >
                    {source?.entity ? (
                      <button
                        className={cx(
                          buttonClasses({ variant: "quiet" }),
                          "text-caption",
                        )}
                        aria-label={`Open source for ${name}`}
                        title={
                          draft.dirty
                            ? "Apply or discard changes before opening the source"
                            : source.label
                        }
                        disabled={draft.dirty}
                        onClick={() => select(source.entity!)}
                      >
                        <ArrowUpRight size={14} aria-hidden />
                        Open source
                      </button>
                    ) : null}
                    <button
                      className={cx(
                        buttonClasses({ variant: "quiet" }),
                        "text-caption",
                      )}
                      aria-label={`Reset mapping for ${name}`}
                      disabled={disabled || !changed || !saved}
                      onClick={() => {
                        if (saved)
                          draft.setClientMappings({
                            ...mappings,
                            [name]: saved,
                          });
                      }}
                    >
                      Reset mapping
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!matches.length ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          {rows.length
            ? "No matching fields or sources."
            : "Add a field to choose its source."}
        </p>
      ) : null}
      {editError ? (
        <p
          role="alert"
          className="mt-0 mb-2 text-caption text-refuse wrap-anywhere"
        >
          {editError}
        </p>
      ) : null}
    </section>
  );
}

/** The same recipe written once per environment, ready to diverge. */
const clientBindingSplit = (mapping: ClientEnvironmentMapping) => ({
  dev: clientBindingFor(mapping, "dev"),
  prod: clientBindingFor(mapping, "prod"),
});

export function ClientEnvironmentFileView({
  resource,
}: {
  readonly resource: ModelResource;
}) {
  const { snapshot } = useStudio();
  const file = resource.clientEnvironment;
  if (!file) return null;
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind>Environment file</InspectorKind>
        <EntityName
          entity={resource.id}
          fallback="client-app/.env"
          icon={<EntityIcon size={24} icon="envFile" />}
        />
        {/* Where exports are written reads as the header's source lines do: one label column, same row height. */}
        <dl
          aria-label="Generated environment files"
          data-ui="written"
          data-slot="client-environment-files"
          className="mt-2 mb-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-meta text-graphite"
        >
          {(["dev", "prod"] as const).map((mode) => (
            <Fragment key={mode}>
              <dt>{mode === "dev" ? "Dev" : "Prod"} export</dt>
              <dd className="m-0 flex min-h-5.5 min-w-0 items-center">
                <code className="min-w-0 text-meta wrap-anywhere">
                  {snapshot.models[mode].resources.find(
                    (item) => item.id === resource.id,
                  )?.clientEnvironment?.path ?? CLIENT_ENVIRONMENT_FILES[mode]}
                </code>
              </dd>
            </Fragment>
          ))}
        </dl>
      </header>
      <Description entity={resource.id} />
      <ClientEnvironmentMappings file={file} />
      <InspectorDisclosure title="File details">
        <p className="mt-0 mb-2 text-caption text-graphite">
          Export writes the Dev / Prod files above. Their values override{" "}
          <code>client-app/.env</code>. These mappings describe sources, not
          saved file contents.
        </p>
        <p className="mt-0 mb-2 text-caption text-graphite wrap-anywhere">
          Mappings saved in <code>{CLIENT_ENVIRONMENT_FILE}</code>.
        </p>
      </InspectorDisclosure>
    </>
  );
}
