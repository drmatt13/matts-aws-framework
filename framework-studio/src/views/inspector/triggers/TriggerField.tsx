import type { ModeModel, Snapshot } from "../../../../shared/model";
import type { TriggerBinding, TriggerCapability, TriggerField as TriggerFieldDefinition } from "../../../../shared/triggers";
import type { TriggerProblem } from "../../../../shared/trigger-availability";
import { enumChoices, eventPatternBasics, eventPatternFrom, S3_BASIC_EVENTS, scheduleBasics, scheduleExpression, type ScheduleBasics } from "../../../../shared/trigger-presets";
import { buttonClasses } from "../../../ui/Button";
import { Select, TextInput, Textarea, checkboxClasses } from "../../../ui/FormControls";
import { cx } from "../../../ui/classes";
import type { TriggerForm } from "./form";

interface TriggerFieldProps {
  readonly field: TriggerFieldDefinition;
  readonly form: TriggerForm;
  readonly snapshot: Snapshot;
  readonly model: ModeModel;
  readonly capabilities: readonly TriggerCapability[];
  readonly others: readonly TriggerBinding[];
  readonly problems: readonly TriggerProblem[];
  readonly setForm: (form: TriggerForm) => void;
  readonly setOption: (name: string, value: unknown) => void;
  readonly setRaw: (field: TriggerFieldDefinition, raw: string) => void;
}

export function TriggerField({
  field, form, snapshot, model, capabilities, others, problems, setForm, setOption, setRaw,
}: TriggerFieldProps) {
  const current = form;
  const label = `Trigger ${field.label}`;
  const value = current.options[field.name];
  const error = problems.find(
    (problem) =>
      problem.field === field.name &&
      (problem.kind === "form" || problem.kind === "source"),
  )?.message;
  const note = error ? <span className={"text-refuse wrap-anywhere text-caption"}>{error}</span> : null;
  const raw =
    current.text[field.name] ??
    (value === undefined
      ? ""
      : field.kind === "json"
        ? JSON.stringify(value, null, 2)
        : String(value));
  const toJson = () =>
    setForm({
      ...current,
      json: { ...current.json, [field.name]: true },
      text: {
        ...current.text,
        [field.name]:
          value === undefined ? "" : JSON.stringify(value, null, 2),
      },
    });
  const basics =
    current.adapter === "eventbridge" &&
    field.name === "eventPattern" &&
    !current.json[field.name]
      ? eventPatternBasics(value)
      : undefined;
  if (basics) {
    const part = (name: "source" | "detailType") =>
      current.text[`eventPattern.${name}`] ?? basics[name];
    const change = (name: "source" | "detailType", text: string) => {
      const next = {
        source: part("source"),
        detailType: part("detailType"),
        [name]: text,
      };
      setForm({
        ...current,
        text: {
          ...current.text,
          "eventPattern.source": next.source,
          "eventPattern.detailType": next.detailType,
        },
        options: {
          ...current.options,
          eventPattern: eventPatternFrom(next.source, next.detailType),
        },
      });
    };
    return (
      <fieldset className={"grid [gap:6px] m-0 p-[var(--space-2)_10px] border border-rule rounded-md [&_legend]:p-[0_var(--space-1)] [&_legend]:text-step-minus1 [&_legend]:font-semibold"} data-slot="trigger-fieldset">
        <legend>Match events</legend>
        <label>
          Source
          <TextInput
            aria-label="Trigger event source"
            placeholder="my.app.orders"
            value={part("source")}
            onChange={(event) => change("source", event.target.value)}
          />
        </label>
        <label>
          Detail type
          <TextInput
            aria-label="Trigger detail type"
            placeholder="OrderPlaced"
            value={part("detailType")}
            onChange={(event) => change("detailType", event.target.value)}
          />
        </label>
        <span className={"text-caption text-graphite"}>
          Separate several values with commas.{" "}
          <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={toJson}>
            Edit full pattern as JSON
          </button>
        </span>
        {note}
      </fieldset>
    );
  }
  const scheduled =
    current.adapter === "schedule" &&
    field.name === "expression" &&
    !current.json[field.name]
      ? scheduleBasics(value ?? field.default)
      : undefined;
  if (scheduled) {
    const set = (next: ScheduleBasics) =>
      setOption(field.name, scheduleExpression(next));
    return (
      <fieldset className={"grid [gap:6px] m-0 p-[var(--space-2)_10px] border border-rule rounded-md [&_legend]:p-[0_var(--space-1)] [&_legend]:text-step-minus1 [&_legend]:font-semibold"} data-slot="trigger-fieldset">
        <legend>Run</legend>
        <label>
          Repeat
          <Select
            aria-label="Trigger repeat"
            value={scheduled.kind}
            onChange={(event) =>
              set(
                event.target.value === "daily"
                  ? { kind: "daily", time: "09:00" }
                  : { kind: "rate", count: 1, unit: "hours" },
              )
            }
          >
            <option value="rate">Every…</option>
            <option value="daily">Daily at…</option>
          </Select>
        </label>
        {scheduled.kind === "rate" ? (
          <div className="flex gap-[6px] [&&_input]:w-[6em]" data-slot="trigger-inline">
            <TextInput
              aria-label="Trigger every"
              type="number"
              min={1}
              value={scheduled.count}
              onChange={(event) =>
                set({
                  ...scheduled,
                  count: Math.max(
                    1,
                    Math.floor(Number(event.target.value) || 1),
                  ),
                })
              }
            />
            <Select
              aria-label="Trigger unit"
              value={scheduled.unit}
              onChange={(event) =>
                set({
                  ...scheduled,
                  unit: event.target.value as "minutes" | "hours" | "days",
                })
              }
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
          </div>
        ) : (
          <label>
            Time
            {typeof current.options.timezone === "string"
              ? ` (${current.options.timezone})`
              : " (UTC)"}
            <TextInput
              aria-label="Trigger time"
              type="time"
              value={scheduled.time}
              onChange={(event) =>
                set({ kind: "daily", time: event.target.value || "00:00" })
              }
            />
          </label>
        )}
        <span className={"text-caption text-graphite"}>
          <code>{String(value ?? field.default)}</code> ·{" "}
          <button
            className={cx(buttonClasses({ variant: "link" }), "text-caption")}
            onClick={() =>
              setForm({
                ...current,
                json: { ...current.json, [field.name]: true },
              })
            }
          >
            Write a cron expression
          </button>
        </span>
        {note}
      </fieldset>
    );
  }
  const s3Basic =
    current.adapter === "s3" &&
    field.name === "eventTypes" &&
    !current.json[field.name] &&
    Array.isArray(value) &&
    value.every((item) =>
      S3_BASIC_EVENTS.some((basic) => basic.value === item),
    );
  if (s3Basic)
    return (
      <fieldset className={"grid [gap:6px] m-0 p-[var(--space-2)_10px] border border-rule rounded-md [&_legend]:p-[0_var(--space-1)] [&_legend]:text-step-minus1 [&_legend]:font-semibold"} data-slot="trigger-fieldset">
        <legend>When objects are</legend>
        {S3_BASIC_EVENTS.map((basic) => (
          <label key={basic.value} className={"flex items-start gap-2 coarse:min-h-11"} data-slot="trigger-check">
            <input
              type="checkbox"
              aria-label={`Trigger on ${basic.label.toLowerCase()}`}
              checked={(value as string[]).includes(basic.value)}
              onChange={(event) =>
                setOption(
                  field.name,
                  event.target.checked
                    ? [...(value as string[]), basic.value]
                    : (value as string[]).filter(
                        (item) => item !== basic.value,
                      ),
                )
              } className={checkboxClasses}
            />
            {basic.label}
          </label>
        ))}
        {current.options.delivery !== "eventbridge" ? (
          <span className={"text-caption text-graphite"}>
            <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={toJson}>
              Choose specific S3 events
            </button>
          </span>
        ) : null}
        {note}
      </fieldset>
    );
  if (field.kind === "enum") {
    const choices = enumChoices(snapshot, field, {
      event: current.event,
      resource: current.resource,
      adapter: current.adapter,
      others,
    });
    const workable = choices.filter((choice) => !choice.reason);
    // One workable value of a required choice is a fact about the source, not a decision.
    if (
      field.required &&
      !field.advanced &&
      choices.length > 1 &&
      workable.length === 1 &&
      value === workable[0]!.value
    )
      return (
        <p className={"text-caption m-0"} data-slot="trigger-fact">
          <strong>{field.label}:</strong> {String(value)}{" "}
          <span className={"text-graphite"}>
            {choices
              .filter((choice) => choice.reason)
              .map((choice) => choice.reason)
              .join(" ")}
          </span>
        </p>
      );
    return (
      <label>
        {field.label}
        <Select
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) =>
            setOption(field.name, event.target.value || undefined)
          }
        >
          {value === undefined || !field.required ? (
            <option value="">{field.required ? "Choose" : "Default"}</option>
          ) : null}
          {choices.map((choice) => (
            <option
              key={choice.value}
              value={choice.value}
              disabled={!!choice.reason}
              title={choice.reason}
            >
              {choice.value}
              {choice.short ? ` · ${choice.short}` : ""}
            </option>
          ))}
        </Select>
        {note}
      </label>
    );
  }
  if (field.kind === "boolean")
    return (
      <label>
        {field.label}
        <Select
          aria-label={label}
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            setOption(
              field.name,
              event.target.value === ""
                ? undefined
                : event.target.value === "true",
            )
          }
        >
          <option value="">Default</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </Select>
        {note}
      </label>
    );
  if (field.kind === "resource") {
    const type = `${field.resourceType?.module}:${field.resourceType?.name}`;
    const chosen = (
      value as { readonly path?: readonly string[] } | undefined
    )?.path;
    return (
      <label>
        {field.label}
        <Select
          aria-label={label}
          value={chosen ? `resource:${chosen.join(".")}` : ""}
          onChange={(event) =>
            setOption(
              field.name,
              event.target.value
                ? {
                    $cdk: "@repo/framework/cdk-resource",
                    path: model.resources.find(
                      (item) => item.id === event.target.value,
                    )!.path,
                    optional: false,
                  }
                : undefined,
            )
          }
        >
          <option value="">None</option>
          {capabilities
            .filter((item) => item.canonicalTypes.includes(type))
            .map((item) => {
              const imported = field.resourceType?.owned && !item.owned;
              return (
                <option
                  key={item.resource}
                  value={item.resource}
                  disabled={!!imported}
                >
                  {item.resource.replace(/^resource:/, "")}
                  {imported ? " · imported" : ""}
                </option>
              );
            })}
        </Select>
        {note}
      </label>
    );
  }
  if (field.kind === "json")
    return (
      <label>
        {field.label}
        <Textarea
          aria-label={label}
          rows={4}
          value={raw}
          onChange={(event) => setRaw(field, event.target.value)}
        />
        {note}
      </label>
    );
  return (
    <label>
      {field.label}
      <TextInput
        aria-label={label}
        type={field.kind === "number" ? "number" : "text"}
        min={field.min}
        max={field.max}
        value={raw}
        onChange={(event) => setRaw(field, event.target.value)}
      />
      {note}
    </label>
  );
}
