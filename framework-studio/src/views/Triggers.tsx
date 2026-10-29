import { InspectorSummary } from "./InspectorUI";

import { Select, TextInput, checkboxClasses, Textarea } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { ArrowLeft, Check, CircleAlert, Info, Pencil, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ModelResource, ModelTarget } from "../../shared/model";
import type { TriggerBinding, TriggerField } from "../../shared/triggers";
import { blockingProblems, eventUnavailable, triggerProblems, triggerUnavailable, type TriggerProblem } from "../../shared/trigger-availability";
import { enumChoices, eventPatternBasics, eventPatternFrom, fieldGroups, initialOptions, nextAttachmentId, S3_BASIC_EVENTS, scheduleBasics, scheduleExpression, type ScheduleBasics } from "../../shared/trigger-presets";
import { useStudio } from "../studio";
import { titleOf } from "../lookup";
import { Written } from "./Written";
import { TriggerSourcePicker } from "./TriggerGuide";
import { FailureDestination } from "./FailureDestination";
import { InspectorDisclosure } from "./InspectorUI";

// Nested trigger actions retain their compact padding while sharing regular control height.
// Semantic part selectors make this exception win independently of utility emission order.
const triggerEditorClasses = "[&_summary]:cursor-pointer [&_summary]:font-semibold [&_[data-slot=trigger-row]_[data-variant=quiet]]:gap-1 [&_[data-slot=trigger-row]_[data-variant=quiet]]:px-2 [&_[data-slot=trigger-row]_[data-variant=quiet]]:py-0.75 [&_[data-slot=trigger-form]_[data-variant=quiet]]:gap-1 [&_[data-slot=trigger-form]_[data-variant=quiet]]:px-2 [&_[data-slot=trigger-form]_[data-variant=quiet]]:py-0.75";

type Step = "source" | "settings" | "confirm";

interface Form {
  readonly step: Step;
  /** The service whose resources step one is showing. */
  readonly service?: string;
  readonly event: string;
  readonly resource: string;
  readonly adapter: string;
  readonly id: string;
  readonly accepts: boolean;
  readonly options: Readonly<Record<string, unknown>>;
  /** Input text as typed, for fields whose value is parsed. */
  readonly text: Readonly<Record<string, string>>;
  readonly unparsed: Readonly<Record<string, string>>;
  /** Fields switched from their guided inputs to the JSON editor. */
  readonly json: Readonly<Record<string, boolean>>;
  /** The staged binding this form replaces. */
  readonly editing?: { readonly event: string; readonly key: string };
}

const PROBLEM_ICONS = {
  form: CircleAlert,
  source: CircleAlert,
  warning: TriangleAlert,
  advice: Info,
} as const;

export function Triggers({
  resource,
  target,
}: {
  readonly resource?: ModelResource;
  readonly target?: ModelTarget;
}) {
  const { snapshot, model, index, draft, draftState, select } = useStudio();
  const [form, setForm] = useState<Form>();
  const formRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!form) return;
    formRoot.current?.scrollIntoView?.({ block: "start" });
    if (form.step !== "source") {
      const controls = formRoot.current?.querySelectorAll<HTMLElement>(
        "input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      );
      [...(controls ?? [])]
        .find((control) => !control.closest("details:not([open])"))
        ?.focus({ preventScroll: true });
    }
  }, [form?.step]);
  const [open, setOpen] = useState(false);
  // Nothing is staged until the trigger is added, so only a saved or discarded draft closes the form.
  useEffect(() => {
    if (!draft.dirty) setForm(undefined);
  }, [draftState.entries]);
  const events = model.targets.filter((item) => item.role === "event");
  const capabilities = snapshot.source.triggerCapabilities ?? [];
  const capability =
    resource && capabilities.find((item) => item.resource === resource.id);
  if (resource && !capability) return null;
  const adapters = model.triggerAdapters ?? [];
  const all = events.flatMap((event) => draft.triggers(event.id));
  const owns = (binding: TriggerBinding) =>
    resource ? binding.resource === resource.id : binding.event === target?.id;
  const managed = all.filter(owns);
  // Removed but not yet reviewed: kept visible so the developer can restore it.
  const pendingRemovals = (model.triggers ?? [])
    .filter(owns)
    .filter(
      (binding) =>
        !all.some(
          (item) => item.event === binding.event && item.key === binding.key,
        ),
    );
  const native = model.edges.filter(
    (edge) =>
      edge.relation === "trigger" &&
      edge.provenance === "source" &&
      (resource ? edge.from === resource.id : edge.to === target?.ref),
  );
  const resourceReason = resource
    ? capability?.adapters.some(
        (item) => !triggerUnavailable(snapshot, resource.id, item.kind),
      )
      ? undefined
      : capability?.adapters[0]
        ? triggerUnavailable(snapshot, resource.id, capability.adapters[0].kind)
        : "Unknown public type; no compatible trigger adapter."
    : undefined;
  const others = all.filter(
    (binding) =>
      !(
        form?.editing &&
        binding.event === form.editing.event &&
        binding.key === form.editing.key
      ),
  );
  const metadata = adapters.find((item) => item.kind === form?.adapter);
  const problems: readonly TriggerProblem[] =
    form && metadata && form.step !== "source"
      ? triggerProblems(
          snapshot,
          {
            event: form.event,
            resource: form.resource,
            adapter: form.adapter,
            id: form.id,
            accepts: form.accepts ? metadata.contract : "",
            options: form.options,
            unparsed: form.unparsed,
          },
          others,
        )
      : [];
  const blocking = blockingProblems(problems);
  const groups = metadata ? fieldGroups(metadata) : undefined;

  const fresh = (patch: Partial<Form>): Form => ({
    step: "source",
    event: target?.id ?? "",
    resource: resource?.id ?? "",
    adapter: resource
      ? (capability?.adapters.find(
          (item) => !triggerUnavailable(snapshot, resource.id, item.kind),
        )?.kind ?? "")
      : "",
    id: "",
    accepts: false,
    options: {},
    text: {},
    unparsed: {},
    json: {},
    ...patch,
  });
  const start = () => {
    setOpen(true);
    setForm(fresh({}));
  };
  // A newly chosen source starts again from its defaults.
  const choose = (base: Form, patch: Partial<Form>) => {
    const next = { ...base, ...patch };
    const resourceless =
      adapters.find((item) => item.kind === next.adapter)?.resourceless ===
      true;
    if (!next.event || !next.adapter || (!resourceless && !next.resource)) {
      setForm({ ...next, step: "source" });
      return;
    }
    const context = {
      event: next.event,
      resource: next.resource,
      adapter: next.adapter,
      others,
    };
    setForm({
      ...next,
      step: "settings",
      options: initialOptions(snapshot, context),
      id: nextAttachmentId(snapshot, context),
      accepts: false,
      text: {},
      unparsed: {},
      json: {},
    });
  };
  const edit = (binding: TriggerBinding) => {
    setOpen(true);
    setForm({
      step: "settings",
      event: binding.event,
      resource: binding.resource,
      adapter: binding.adapter,
      id: binding.id,
      accepts: true,
      options: binding.options,
      text: {},
      unparsed: {},
      json: {},
      editing: { event: binding.event, key: binding.key },
    });
  };
  const close = () => setForm(undefined);
  const commit = () => {
    if (!form || !metadata || blocking.length) return;
    const key = metadata.resourceless
      ? `${form.adapter}/${form.id}`
      : `${form.resource.replace(/^resource:/, "")}/${form.id}`;
    const binding: TriggerBinding = {
      event: form.event,
      resource: form.resource,
      adapter: form.adapter,
      id: form.id,
      key,
      accepts: metadata.contract,
      options: form.options,
    };
    if (form.editing)
      draft.setTriggers(
        form.editing.event,
        draft
          .triggers(form.editing.event)
          .filter((item) => item.key !== form.editing!.key),
      );
    draft.setTriggers(form.event, [...draft.triggers(form.event), binding]);
    close();
  };
  const removeEditing = () => {
    if (form?.editing)
      draft.setTriggers(
        form.editing.event,
        draft
          .triggers(form.editing.event)
          .filter((item) => item.key !== form.editing!.key),
      );
    close();
  };

  const nativeLabel = (edge: (typeof native)[number]) =>
    `${edge.label} · ${resource ? titleOf(index, edge.to) : titleOf(index, edge.from)}`;
  const describe = (binding: TriggerBinding) =>
    `${resource ? titleOf(index, `lambda:${binding.event}`) : binding.resource ? binding.resource.replace(/^resource:/, "") : (adapters.find((item) => item.kind === binding.adapter)?.label ?? binding.adapter)} · ${String(binding.options.operation ?? binding.options.expression ?? binding.adapter)}`;

  return (
    <InspectorDisclosure
      title="Triggers"
      count={managed.length + native.length}
      open={open}
      onToggle={setOpen}
      className={triggerEditorClasses} data-slot="trigger-editor"
    >
      {native.map((edge) => {
        const removed = draft.nativeRemoved(edge.id);
        const refused = !edge.removal
          ? "This wiring must be removed in source."
          : "refused" in edge.removal
            ? edge.removal.refused
            : undefined;
        return (
          <div
            className={cx("flex gap-2 flex-wrap items-baseline p-[10px_0] m-0 border-b border-rule", removed ? "[&>:first-child]:line-through [&>:first-child]:text-faint" : "")}
            key={edge.id} data-slot="trigger-row"
          >
            <button className={buttonClasses({ variant: "link" })} onClick={() => select(edge.id)}>
              {nativeLabel(edge)}
            </button>
            <span className={"text-caption text-graphite"}>
              {removed ? "Will be removed" : "Native"}
            </span>
            {removed ? (
              <button
                className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
                aria-label={`Restore native trigger ${edge.label}`}
                onClick={() => draft.restoreNative(edge.id)} data-variant="quiet"
              >
                <RotateCcw size={13} aria-hidden />
                Restore
              </button>
            ) : (
              <button
                className={iconButtonClasses()}
                aria-label={`Remove native trigger ${edge.label}`}
                title={refused ?? `Remove from ${edge.source?.file}`}
                aria-disabled={!!refused}
                onClick={() => {
                  if (!refused) draft.removeNative(edge.id);
                }}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            )}
            <Written location={edge.source} label="Wired in" />
          </div>
        );
      })}
      {managed
        .filter(
          (binding) =>
            !form?.editing ||
            binding.key !== form.editing.key ||
            binding.event !== form.editing.event,
        )
        .map((binding) => (
          <div className={"flex gap-2 flex-wrap items-baseline p-[10px_0] m-0 border-b border-rule"} key={`${binding.event}:${binding.key}`} data-slot="trigger-row">
            <span className={"text-caption"}>{describe(binding)}</span>
            <button
              className={iconButtonClasses()}
              aria-label={`Edit trigger ${binding.id}`}
              title="Edit"
              onClick={() => edit(binding)}
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              className={iconButtonClasses()}
              aria-label={`Remove trigger ${binding.id}`}
              title="Remove"
              onClick={() =>
                draft.setTriggers(
                  binding.event,
                  draft
                    .triggers(binding.event)
                    .filter((item) => item.key !== binding.key),
                )
              }
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        ))}
      {pendingRemovals.map((binding) => (
        <div
          className={"flex gap-2 flex-wrap items-baseline p-[10px_0] m-0 border-b border-rule [&>:first-child]:line-through [&>:first-child]:text-faint"}
          key={`removed:${binding.event}:${binding.key}`} data-slot="trigger-row"
        >
          <span className={"text-caption"}>{describe(binding)}</span>
          <span className={"text-caption text-graphite"}>Will be removed</span>
          <button
            className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
            aria-label={`Restore trigger ${binding.id}`}
            onClick={() =>
              draft.setTriggers(binding.event, [
                ...draft.triggers(binding.event),
                binding,
              ])
            } data-variant="quiet"
          >
            <RotateCcw size={13} aria-hidden />
            Restore
          </button>
        </div>
      ))}
      {resourceReason ? (
        <p className={"text-caption text-graphite"}>{resourceReason}</p>
      ) : !form ? (
        <button
          className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
          onClick={start}
          style={{ marginTop: 12 }} data-variant="quiet"
        >
          Add trigger
        </button>
      ) : (
        <div className={"[&_label:not([data-slot=trigger-check]):not([data-slot=trigger-ack])]:grid [&_label:not([data-slot=trigger-check]):not([data-slot=trigger-ack])]:gap-1 [&_label:not([data-slot=trigger-check]):not([data-slot=trigger-ack])]:text-step-minus1 [&_input:not([type=checkbox])]:w-full [&_select]:w-full [&_textarea]:w-full grid mt-3 [gap:14px] [padding-top:6px]"} ref={formRoot} data-slot="trigger-form">
          <ol className={"[&[aria-current=step]]:text-ink [&[aria-current=step]]:font-semibold flex m-0 p-0 list-none text-faint gap-2 pb-3 border-b border-rule text-caption [&_li]:flex-1"} aria-label="Trigger setup" data-slot="trigger-steps">
            {(["source", "settings", "confirm"] as const).map(
              (step, position) => (
                <li
                  key={step}
                  aria-current={form.step === step ? "step" : undefined}
                >
                  {position + 1}.{" "}
                  {step === "source"
                    ? resource
                      ? "Lambda"
                      : "Source"
                    : step === "settings"
                      ? "Settings"
                      : "Confirm"}
                </li>
              ),
            )}
          </ol>
          {form.step === "source" ? (
            renderSource()
          ) : (
            <>
              {renderRoute()}
              {form.step === "settings" ? renderSettings() : renderConfirm()}
            </>
          )}
        </div>
      )}
      {target &&
      (managed.some(
        (binding) =>
          adapters.find((item) => item.kind === binding.adapter)?.asyncInvoke,
      ) ||
        draft.failure(target.id)) ? (
        <FailureDestination event={target.id} />
      ) : null}
    </InspectorDisclosure>
  );

  function renderSource() {
    const current = form!;
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

  function renderRoute() {
    const current = form!;
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

  function renderSettings() {
    const current = form!;
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

  function renderConfirm() {
    const current = form!;
    const confirmations = new Set([
      "accepts",
      ...groups!.confirm.map((field) => field.name),
    ]);
    const dropped: TriggerProblem[] =
      metadata!.asyncInvoke && !draft.failure(current.event)
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
            disabled={!!left || !!draftState.busy}
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

  function setOption(name: string, value: unknown) {
    const current = form!;
    const options = { ...current.options },
      text = { ...current.text },
      unparsed = { ...current.unparsed };
    if (value === undefined) delete options[name];
    else options[name] = value;
    delete text[name];
    delete unparsed[name];
    setForm({ ...current, options, text, unparsed });
  }

  function setRaw(field: TriggerField, raw: string) {
    const current = form!;
    const options = { ...current.options },
      unparsed = { ...current.unparsed };
    delete unparsed[field.name];
    if (!raw.trim()) delete options[field.name];
    else if (field.kind === "number") {
      const value = Number(raw);
      if (Number.isFinite(value)) options[field.name] = value;
      else {
        delete options[field.name];
        unparsed[field.name] = raw;
      }
    } else if (field.kind === "json") {
      try {
        options[field.name] = JSON.parse(raw);
      } catch {
        delete options[field.name];
        unparsed[field.name] = raw;
      }
    } else options[field.name] = raw;
    setForm({
      ...current,
      options,
      unparsed,
      text: { ...current.text, [field.name]: raw },
    });
  }

  function renderField(field: TriggerField) {
    const current = form!;
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
}
