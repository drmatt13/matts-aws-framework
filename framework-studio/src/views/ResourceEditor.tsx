import { cx } from "../ui/classes";
import { inspectorSectionClasses } from "../inspector-ui";
import { sourceEditBlocked } from "../editing-state";
import { checkboxClasses, Select, TextInput } from "../ui/FormControls";

import { useEffect, useId, useRef, useState } from "react";
import type { Mode, ModelResource } from "../../shared/model";
import type { ResourceDetails } from "../../shared/resources";
import { api } from "../api";
import { useStudio } from "../studio";
import type { ResourceModeForm } from "../draft";
import { resourceOutputEnvironmentName } from "@repo/framework/config";
import { FormGroup, InspectorSwitch } from "./InspectorUI";
import { LocalValue } from "./LocalValue";

const modeCellClasses = "px-0 py-1 text-left align-middle";
const insetModeCellClasses = cx(modeCellClasses, "pl-2");
const modeRowHeadingClasses = cx(modeCellClasses, "w-[34%] font-normal");

const MODES = ["dev", "prod"] as const;
const MODE_NAMES = { dev: "development", prod: "production" } as const;

export function ResourceEditor({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, mode, model, live, draft, draftState } = useStudio();
  const help = useId();
  const [details, setDetails] = useState<ResourceDetails>();
  const [detailsError, setDetailsError] = useState<string>();
  const [reload, setReload] = useState(0);
  const linkedVariable = useRef(resource.fromEnv);
  useEffect(() => {
    linkedVariable.current = resource.fromEnv;
  }, [resource.id, resource.fromEnv]);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setDetailsError(undefined);
    if (resource.fromEnv && !resource.absent && !model.stale) {
      void api
        .resourceDetails(resource.id, mode, controller.signal)
        .then((details) => {
          if (!controller.signal.aborted) setDetails(details);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setDetailsError(
              reason instanceof Error ? reason.message : "Could not load this input.",
            );
        });
    }
    return () => controller.abort();
  }, [resource, snapshot.revision, mode, model.stale, reload]);

  const form = draft.resourceForm(resource);
  const { secret, modes, group } = form;
  const fromEnv = form.fromEnv === undefined ? (resource.fromEnv ?? null) : form.fromEnv;
  const linked = fromEnv !== null;
  const update = (change: Partial<typeof form>) =>
    draft.setResource(resource, { ...form, ...change });
  const setSecret = (secret: boolean) =>
    update({
      secret,
      ...(secret && !linked
        ? {
            fromEnv: resourceOutputEnvironmentName(resource),
            modes: {
              dev: { ...modes.dev, default: "", value: undefined },
              prod: { ...modes.prod, default: "", value: undefined },
            },
          }
        : {}),
    });
  const setLinked = (linked: boolean) => {
    if (!linked && fromEnv !== null) linkedVariable.current = fromEnv;
    const column = (column: ResourceModeForm): ResourceModeForm =>
      linked
        ? { ...column, default: column.value ?? column.default, value: undefined }
        : { ...column, required: false, value: column.default, default: "" };
    update({
      fromEnv: linked
        ? (linkedVariable.current ?? resource.fromEnv ?? resourceOutputEnvironmentName(resource))
        : null,
      modes: { dev: column(modes.dev), prod: column(modes.prod) },
    });
  };
  const setMode = (mode: Mode, change: Partial<ResourceModeForm>) =>
    update({ modes: { ...modes, [mode]: { ...modes[mode], ...change } } });
  const setGroup = (group: string) => update({ group });
  const entry = draftState.entries.find(
    (entry) => entry.kind === "resource" && entry.intent.resource === resource.id,
  );
  const environmentPending = draftState.entries.some((entry) => entry.kind === "environment");
  const disabled =
    sourceEditBlocked({ draftState, draft, model, live }) ||
    live.running !== null ||
    environmentPending;
  return (
    <>
      <section
        className={inspectorSectionClasses}
        aria-label="Value source"
        data-slot="input-source"
      >
        <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
          <div className="flex min-w-0 items-center justify-between gap-3 text-label font-medium">
            <label htmlFor={`${help}-linked-switch`}>Link to .env file</label>
            <InspectorSwitch
              className="-my-1.5"
              id={`${help}-linked-switch`}
              label="Link to .env file"
              describedBy={`${help}-source`}
              checked={linked}
              disabled={secret}
              onChange={setLinked}
            />
          </div>
          <p id={`${help}-source`} className="mb-2 mt-2 text-caption text-graphite">
            {secret
              ? "Secrets use a protected environment file. Their values never belong in source."
              : linked
                ? "Each environment reads its linked variable. An optional default supplies a value when the file leaves it unset."
                : "The value is saved in the source declaration. Environment files do not supply or override it."}
          </p>
          {linked ? (
            <label className="mt-3 grid gap-2 text-label font-medium">
              <span>Environment variable</span>
              <TextInput
                aria-label="Environment variable"
                value={fromEnv}
                onChange={(event) => update({ fromEnv: event.target.value })}
              />
            </label>
          ) : null}
        </fieldset>
      </section>
      {linked && resource.fromEnv && fromEnv === resource.fromEnv ? (
        <LocalValue
          resource={resource}
          details={details}
          error={detailsError}
          busy={!!draftState.busy}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : linked ? (
        <section className={inspectorSectionClasses} aria-label="Local value">
          <p className="mt-0 mb-2 text-caption text-graphite">
            Review and apply this link before editing values in the environment files.
          </p>
        </section>
      ) : null}
      {/* Its first group's legend heads the section; a generic "Configuration" heading above it said nothing more. */}
      <section
        className={inspectorSectionClasses}
        aria-label="Input settings"
        data-slot="resource-editor"
      >
        {environmentPending ? (
          <p className="mt-0 mb-2 text-caption text-graphite">
            Apply or discard local value changes before editing input settings.
          </p>
        ) : null}
        <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
          <FormGroup title="Input behavior" appearance="plain">
            <table
              className="mb-1 w-full table-fixed border-collapse text-caption"
              aria-describedby={`${help}-modes`}
              data-slot="input-modes"
            >
              <thead>
                <tr>
                  <td className={cx(modeCellClasses, "w-[34%] font-normal")} />
                  <th scope="col" className={cx(modeCellClasses, "font-medium text-graphite")}>
                    Dev
                  </th>
                  <th scope="col" className={cx(insetModeCellClasses, "font-medium text-graphite")}>
                    Prod
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className={modeRowHeadingClasses}>
                    Present
                  </th>
                  {MODES.map((mode) => (
                    <td key={mode} className={insetModeCellClasses}>
                      <input
                        type="checkbox"
                        aria-label={`Present in ${MODE_NAMES[mode]}`}
                        checked={modes[mode].present}
                        onChange={(event) => setMode(mode, { present: event.target.checked })}
                        className={checkboxClasses}
                      />
                    </td>
                  ))}
                </tr>
                {linked ? (
                  <tr>
                    <th scope="row" className={modeRowHeadingClasses}>
                      Required
                    </th>
                    {MODES.map((mode) => (
                      <td key={mode} className={insetModeCellClasses}>
                        <input
                          type="checkbox"
                          aria-label={`Required in ${MODE_NAMES[mode]}`}
                          disabled={!modes[mode].present}
                          checked={modes[mode].present && modes[mode].required}
                          onChange={(event) => setMode(mode, { required: event.target.checked })}
                          className={checkboxClasses}
                        />
                      </td>
                    ))}
                  </tr>
                ) : null}
                {!secret ? (
                  <tr>
                    <th scope="row" className={modeRowHeadingClasses}>
                      {linked ? "Default" : "Value"}
                    </th>
                    {MODES.map((mode) => {
                      const label = `${linked ? "Default" : "Value"} in ${MODE_NAMES[mode]}`;
                      const value = modes[mode].present
                        ? linked
                          ? modes[mode].default
                          : (modes[mode].value ?? "")
                        : "";
                      const change = (value: string) =>
                        setMode(mode, linked ? { default: value } : { value });
                      return (
                        <td key={mode} className={insetModeCellClasses}>
                          {resource.values ? (
                            <Select
                              className="w-full"
                              aria-label={label}
                              aria-describedby={`${help}-modes`}
                              disabled={!modes[mode].present}
                              value={value}
                              onChange={(event) => change(event.target.value)}
                            >
                              <option value="" disabled={!linked}>
                                {linked ? "None" : "Choose a value"}
                              </option>
                              {resource.values.map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </Select>
                          ) : (
                            <TextInput
                              className="w-full"
                              aria-label={label}
                              aria-describedby={`${help}-modes`}
                              disabled={!modes[mode].present}
                              value={value}
                              placeholder={linked ? "None" : "Enter a value"}
                              onChange={(event) => change(event.target.value)}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p id={`${help}-modes`} className="mt-0 mb-2 text-caption text-graphite">
              {linked ? (
                <>
                  An environment without the input never reads it. A required input needs a value in
                  that environment's file
                  {secret
                    ? ". Secrets have no defaults."
                    : ", or a default. Defaults are optional and stand in when the file leaves the value blank."}
                </>
              ) : (
                "Set a value for each environment that holds the parameter. These values are saved in source and do not use environment files."
              )}
            </p>
            <div
              className="mt-3 mb-1 flex min-w-0 items-center justify-between gap-3 text-label font-medium"
              data-slot="setting-switch"
            >
              <label className="min-w-0 wrap-anywhere" htmlFor={`${help}-secret-switch`}>
                Secret
              </label>
              <InspectorSwitch
                id={`${help}-secret-switch`}
                label="Secret"
                describedBy={`${help}-secret`}
                checked={secret}
                onChange={setSecret}
              />
            </div>
            <p id={`${help}-secret`} className="mt-0 mb-2 text-caption text-graphite">
              On creates a secret whose value is authored separately in a protected environment file
              and delivered through Secrets Manager at deployment.
            </p>
            <label
              className="my-3 grid min-w-0 gap-2 text-label font-medium wrap-anywhere"
              data-slot="resource-control"
            >
              <span>Group</span>
              <TextInput
                className="w-full"
                aria-label="Resource group"
                aria-describedby={`${help}-group`}
                list={`${help}-groups`}
                value={group}
                placeholder="Ungrouped"
                onChange={(event) => setGroup(event.target.value)}
              />
              <datalist id={`${help}-groups`}>
                {model.resources
                  .filter((item) => item.kind === "group")
                  .map((item) => (
                    <option key={item.id} value={item.path[0]} />
                  ))}
              </datalist>
            </label>
            <p id={`${help}-group`} className="mt-0 mb-2 text-caption text-graphite">
              Leave empty for no group. Moving an input updates references
              {linked ? " and preserves its environment variable name" : ""}.
            </p>
          </FormGroup>
        </fieldset>
        {entry?.error ? (
          <p className="mt-0 mb-2 text-refuse wrap-anywhere" role="alert">
            {entry.error}
          </p>
        ) : null}
      </section>
    </>
  );
}
