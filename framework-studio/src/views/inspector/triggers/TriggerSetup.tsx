import { ArrowLeft, Check, CircleAlert, Info, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { ModelResource, ModelTarget, Snapshot } from "../../../../shared/model";
import type { TriggerAdapterMetadata, TriggerCapability, TriggerField } from "../../../../shared/triggers";
import { eventUnavailable, triggerUnavailable, type TriggerProblem } from "../../../../shared/trigger-availability";
import type { fieldGroups } from "../../../../shared/trigger-presets";
import { titleOf, type ModelIndex } from "../../../lookup";
import { buttonClasses } from "../../../ui/Button";
import { Select, TextInput, checkboxClasses } from "../../../ui/FormControls";
import { cx } from "../../../ui/classes";
import { InspectorSummary } from "../../InspectorUI";
import { TriggerSourcePicker } from "../../TriggerGuide";
import type { TriggerForm } from "./form";

type FieldGroups = ReturnType<typeof fieldGroups>;
type SetForm = (form: TriggerForm) => void;
interface SourceStepProps {
  readonly form: TriggerForm;
  readonly resource?: ModelResource;
  readonly capability?: TriggerCapability;
  readonly events: readonly ModelTarget[];
  readonly adapters: readonly TriggerAdapterMetadata[];
  readonly snapshot: Snapshot;
  readonly setForm: SetForm;
  readonly choose: (base: TriggerForm, patch: Partial<TriggerForm>) => void;
  readonly close: () => void;
}
interface RouteProps {
  readonly form: TriggerForm;
  readonly metadata?: TriggerAdapterMetadata;
  readonly index: ModelIndex;
  readonly setForm: SetForm;
}
interface SettingsStepProps {
  readonly form: TriggerForm;
  readonly metadata: TriggerAdapterMetadata;
  readonly groups: FieldGroups;
  readonly problems: readonly TriggerProblem[];
  readonly setForm: SetForm;
  readonly renderField: (field: TriggerField) => ReactNode;
  readonly close: () => void;
  readonly removeEditing: () => void;
}
interface ConfirmStepProps {
  readonly form: TriggerForm;
  readonly metadata: TriggerAdapterMetadata;
  readonly groups: FieldGroups;
  readonly problems: readonly TriggerProblem[];
  readonly blocking: readonly TriggerProblem[];
  readonly missingFailureDestination: boolean;
  readonly busy: boolean;
  readonly setForm: SetForm;
  readonly setOption: (name: string, value: unknown) => void;
  readonly commit: () => void;
  readonly close: () => void;
  readonly removeEditing: () => void;
}

const PROBLEM_ICONS = {
  form: CircleAlert,
  source: CircleAlert,
  warning: TriangleAlert,
  advice: Info,
} as const;

export function TriggerSourceStep({
  form, resource, capability, events, adapters, snapshot, setForm, choose, close,
}: SourceStepProps) {
  const current = form;
  if (!resource)
    return (
      <>
        <TriggerSourcePicker
          event={current.event}
          kind={current.service}
          onKind={(service) => setForm({ ...current, service })}
          onChoose={(chosen, adapter) =>
            choose(current, { resource: chosen, adapter, service: adapter })
          }
        />
        <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions">
          <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={close} data-variant="quiet">
            Cancel
          </button>
        </div>
      </>
    );
  return (
    <>
      {(capability?.adapters.length ?? 0) > 1 ? (
        <label>
          Invocation
          <Select
            aria-label="Trigger invocation"
            value={current.adapter}
            onChange={(event) =>
              setForm({ ...current, adapter: event.target.value })
            }
          >
            {capability!.adapters.map((item) => {
              const reason = triggerUnavailable(
                snapshot,
                resource.id,
                item.kind,
              );
              return (
                <option
                  key={item.kind}
                  value={item.kind}
                  disabled={!!reason}
                  title={reason}
                >
                  {adapters.find((adapter) => adapter.kind === item.kind)
                    ?.label ?? item.kind}
                </option>
              );
            })}
          </Select>
        </label>
      ) : null}
      <label>
        Event Lambda
        <Select
          aria-label="Trigger event Lambda"
          value={current.event}
          onChange={(event) => choose(current, { event: event.target.value })}
        >
          <option value="">Choose event Lambda</option>
          {events.map((event) => {
            const reason = current.adapter
              ? eventUnavailable(snapshot, event.id, current.adapter)
              : undefined;
            return (
              <option
                key={event.id}
                value={event.id}
                disabled={!!reason}
                title={reason}
              >
                {event.id}
                {reason ? " · not available" : ""}
              </option>
            );
          })}
        </Select>
      </label>
      <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions">
        <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={close} data-variant="quiet">
          Cancel
        </button>
      </div>
    </>
  );
}

export function TriggerRoute({ form, metadata, index, setForm }: RouteProps) {
  const current = form;
  const source = metadata?.resourceless
    ? metadata.label
    : `${metadata?.label ?? current.adapter} · ${titleOf(index, current.resource)}`;
  return (
    <p className={"[&>span]:min-w-0 [&>span]:wrap-anywhere [&>button]:flex-none [&>button]:whitespace-nowrap flex justify-between gap-2 m-0 bg-wash rounded-md [padding:10px] items-center text-caption"} data-slot="trigger-route">
      <span>
        <strong>{source}</strong> → {current.event}
      </span>
      <button
        className={cx(buttonClasses({ variant: "link" }), "text-caption")}
        onClick={() => setForm({ ...current, step: "source" })}
      >
        Change
      </button>
    </p>
  );
}

export function TriggerSettingsStep({
  form, metadata, groups, problems, setForm, renderField, close, removeEditing,
}: SettingsStepProps) {
  const current = form;
  const id = problems.find(
    (problem) => problem.field === "id" && problem.kind === "form",
  )?.message;
  return (
    <>
      {groups!.basic.length ? (
        groups!.basic.map((field) => (
          <Fragment key={field.name}>{renderField(field)}</Fragment>
        ))
      ) : (
        <p className={"text-caption text-graphite"}>
          Nothing to set; the defaults suit most {metadata!.label} triggers.
        </p>
      )}
      <details
        className={"grid gap-2 [&_summary]:text-step-minus1 [&_summary]:text-graphite [&[open]>:not(summary)]:mt-2"}
        open={
          !!id ||
          groups!.advanced.some((field) =>
            problems.some(
              (problem) =>
                problem.field === field.name && problem.kind === "form",
            ),
          )
        } data-slot="trigger-advanced"
      >
        <InspectorSummary>Advanced options</InspectorSummary>
        <label>
          Attachment id
          <TextInput
            aria-label="Trigger attachment id"
            value={current.id}
            onChange={(event) =>
              setForm({ ...current, id: event.target.value })
            }
          />
          {id ? <span className={"text-refuse wrap-anywhere text-caption"}>{id}</span> : null}
        </label>
        {groups!.advanced.map((field) => (
          <Fragment key={field.name}>{renderField(field)}</Fragment>
        ))}
      </details>
      <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions">
        <button
          className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
          onClick={() => setForm({ ...current, step: "source" })} data-variant="quiet"
        >
          <ArrowLeft size={13} aria-hidden />
          Back
        </button>
        <button
          className={buttonClasses({ variant: "primary", size: "compact" })}
          onClick={() => setForm({ ...current, step: "confirm" })} data-variant="primary"
        >
          Next
        </button>
        <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={close} data-variant="quiet">
          Cancel
        </button>
        {current.editing ? (
          <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption text-refuse [&&]:border-refuse")} onClick={removeEditing} data-variant="quiet">
            <Trash2 size={13} aria-hidden />
            Remove trigger
          </button>
        ) : null}
      </div>
    </>
  );
}

export function TriggerConfirmStep({
  form, metadata, groups, problems, blocking, missingFailureDestination, busy,
  setForm, setOption, commit, close, removeEditing,
}: ConfirmStepProps) {
  const current = form;
  const confirmations = new Set([
    "accepts",
    ...groups!.confirm.map((field) => field.name),
  ]);
  const dropped: TriggerProblem[] =
    missingFailureDestination
      ? [
          {
            kind: "advice",
            message: `Failed runs are dropped after Lambda's two retries. Once this trigger is added, set where they go under "When a run fails" on ${current.event}.`,
          },
        ]
      : [];
  const listed = [
    ...problems.filter(
      (problem) => !problem.field || !confirmations.has(problem.field),
    ),
    ...dropped,
  ];
  const left = blocking.length;
  return (
    <>
      <ul className={"list-none m-0 p-0 grid [gap:6px] text-step-minus1 [&_li]:flex [&_li]:items-start [&_li]:gap-1.5 [&_li>svg]:flex-none [&_li>svg]:mt-0.5 [&_li>span]:flex-1"} aria-label="Trigger checklist" data-slot="trigger-checklist">
        {listed.map((problem) => {
          const Icon = PROBLEM_ICONS[problem.kind];
          return (
            <li
              key={`${problem.kind}:${problem.field ?? ""}:${problem.message}`}
              className={problem.kind === "form" || problem.kind === "source" ? "text-refuse" : problem.kind === "warning" ? "text-local" : "text-graphite"}
            >
              <Icon size={14} aria-hidden />
              <span>{problem.message}</span>
              {problem.kind === "form" ? (
                <button
                  className={cx(buttonClasses({ variant: "link" }), "text-caption")}
                  onClick={() => setForm({ ...current, step: "settings" })}
                >
                  Fix
                </button>
              ) : null}
            </li>
          );
        })}
        {!listed.some(
          (problem) => problem.kind === "form" || problem.kind === "source",
        ) ? (
          <li className={"text-accept"}>
            <Check size={14} aria-hidden />
            <span>Source and settings check out.</span>
          </li>
        ) : null}
      </ul>
      <label className={"flex items-start gap-2 [&_input]:mt-0.5 border border-rule-strong rounded-md bg-sheet text-caption! p-3 [line-height:1.5]"} data-slot="trigger-ack">
        <input
          type="checkbox"
          aria-label="Acknowledge trigger handler contract"
          checked={current.accepts}
          onChange={(event) =>
            setForm({ ...current, accepts: event.target.checked })
          } className={checkboxClasses}
        />
        <span>
          My handler accepts this event: {metadata!.delivery}.{" "}
          <span className={"text-graphite"}>
            Contract <code>{metadata!.contract}</code>.
          </span>
        </span>
      </label>
      {groups!.confirm.map((field) => (
        <label key={field.name} className={"flex items-start gap-2 [&_input]:mt-0.5 border border-rule-strong rounded-md bg-sheet text-caption! p-3 [line-height:1.5]"} data-slot="trigger-ack">
          <input
            type="checkbox"
            aria-label={`Trigger ${field.label}`}
            checked={current.options[field.name] === true}
            onChange={(event) =>
              setOption(field.name, event.target.checked ? true : undefined)
            } className={checkboxClasses}
          />
          <span>{field.label}</span>
        </label>
      ))}
      <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions">
        <button
          className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
          onClick={() => setForm({ ...current, step: "settings" })} data-variant="quiet"
        >
          <ArrowLeft size={13} aria-hidden />
          Back
        </button>
        <button
          className={buttonClasses({ variant: "primary", size: "compact" })}
          disabled={!!left || busy}
          onClick={commit} data-variant="primary"
        >
          {current.editing ? "Save trigger" : "Add trigger"}
        </button>
        <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={close} data-variant="quiet">
          Cancel
        </button>
        {current.editing ? (
          <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption text-refuse [&&]:border-refuse")} onClick={removeEditing} data-variant="quiet">
            <Trash2 size={13} aria-hidden />
            Remove trigger
          </button>
        ) : null}
      </div>
      {left ? (
        <p className={"text-caption text-graphite"} role="status">
          {left === 1 ? "1 item left" : `${left} items left`} before this
          trigger can be {current.editing ? "saved" : "added"}.
        </p>
      ) : null}
    </>
  );
}

