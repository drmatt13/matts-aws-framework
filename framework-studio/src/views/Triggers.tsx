import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelResource, ModelTarget } from "../../shared/model";
import type { TriggerBinding, TriggerField as TriggerFieldDefinition } from "../../shared/triggers";
import { blockingProblems, triggerProblems, triggerUnavailable, type TriggerProblem } from "../../shared/trigger-availability";
import { fieldGroups, initialOptions, nextAttachmentId } from "../../shared/trigger-presets";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { FailureDestination } from "./FailureDestination";
import { InspectorDisclosure } from "./InspectorUI";
import { Written } from "./Written";
import { TriggerField } from "./inspector/triggers/TriggerField";
import { TriggerConfirmStep, TriggerRoute, TriggerSettingsStep, TriggerSourceStep } from "./inspector/triggers/TriggerSetup";
import type { TriggerForm } from "./inspector/triggers/form";

// Nested trigger actions retain their compact padding while sharing regular control height.
// Semantic part selectors make this exception win independently of utility emission order.
const triggerEditorClasses = "[&_summary]:cursor-pointer [&_summary]:font-semibold [&_[data-slot=trigger-row]_[data-variant=quiet]]:gap-1 [&_[data-slot=trigger-row]_[data-variant=quiet]]:px-2 [&_[data-slot=trigger-row]_[data-variant=quiet]]:py-0.75 [&_[data-slot=trigger-form]_[data-variant=quiet]]:gap-1 [&_[data-slot=trigger-form]_[data-variant=quiet]]:px-2 [&_[data-slot=trigger-form]_[data-variant=quiet]]:py-0.75";

export function Triggers({
  resource,
  target,
}: {
  readonly resource?: ModelResource;
  readonly target?: ModelTarget;
}) {
  const { snapshot, model, index, draft, draftState, select } = useStudio();
  const [form, setForm] = useState<TriggerForm>();
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

  const fresh = (patch: Partial<TriggerForm>): TriggerForm => ({
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
  const choose = (base: TriggerForm, patch: Partial<TriggerForm>) => {
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
            <TriggerSourceStep
              form={form}
              resource={resource}
              capability={capability}
              events={events}
              adapters={adapters}
              snapshot={snapshot}
              setForm={setForm}
              choose={choose}
              close={close}
            />
          ) : (
            <>
              <TriggerRoute form={form} metadata={metadata} index={index} setForm={setForm} />
              {form.step === "settings" ? (
                <TriggerSettingsStep
                  form={form}
                  metadata={metadata!}
                  groups={groups!}
                  problems={problems}
                  setForm={setForm}
                  close={close}
                  removeEditing={removeEditing}
                  renderField={field => (
                    <TriggerField
                      field={field}
                      form={form}
                      snapshot={snapshot}
                      model={model}
                      capabilities={capabilities}
                      others={others}
                      problems={problems}
                      setForm={setForm}
                      setOption={setOption}
                      setRaw={setRaw}
                    />
                  )}
                />
              ) : (
                <TriggerConfirmStep
                  form={form}
                  metadata={metadata!}
                  groups={groups!}
                  problems={problems}
                  blocking={blocking}
                  missingFailureDestination={!!metadata?.asyncInvoke && !draft.failure(form.event)}
                  busy={!!draftState.busy}
                  setForm={setForm}
                  setOption={setOption}
                  commit={commit}
                  close={close}
                  removeEditing={removeEditing}
                />
              )}
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

  function setRaw(field: TriggerFieldDefinition, raw: string) {
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

}
