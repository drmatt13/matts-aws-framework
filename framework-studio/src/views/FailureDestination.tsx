import { triggerFieldLabelClasses } from "./inspector/triggers/styles";
import {
  inspectorActionGroupClasses,
  inspectorNoteClasses,
  inspectorRelationListClasses,
} from "../inspector-ui";
import { ICONS, resourceIcon, type IconKey } from "../icons";
import { iconButtonClasses } from "../ui/IconButton";
import { EntityIcon } from "./EntityIcon";
import { DottedName, InspectorResourceRow } from "./InspectorUI";
import { Select, UnitInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FailureDestinationSettings } from "../../shared/triggers";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";

const TYPES = ["aws-sqs:IQueue", "aws-sns:ITopic"];

interface Form {
  readonly destination: string;
  readonly retries: string;
  readonly age: string;
}

/**
 * Where an event's failed asynchronous runs go once Lambda stops retrying them.
 * Staged through the shared draft like triggers; queue and stream triggers keep
 * their own failure handling, which the text says.
 */
export function FailureDestination({ event }: { readonly event: string }) {
  const { snapshot, index, draft, select } = useStudio();
  const [form, setForm] = useState<Form>();
  const current = draft.failure(event);
  const choices = (snapshot.source.triggerCapabilities ?? []).filter((item) =>
    item.canonicalTypes.some((type) => TYPES.includes(type)),
  );
  // The destination is the row's title; its service and retry policy are the metadata beneath.
  const destination = current && index.resources.get(current.destination);
  const destinationIcon: IconKey = destination ? resourceIcon(destination) : "topic";
  const policy = (value: FailureDestinationSettings) =>
    [
      ICONS[destinationIcon][1],
      `after ${value.retryAttempts ?? 2} ${value.retryAttempts === 1 ? "retry" : "retries"}${value.maxEventAgeSeconds !== undefined ? `, or once ${value.maxEventAgeSeconds}s old` : ""}`,
    ].join(" · ");
  const begin = () =>
    setForm({
      destination: current?.destination ?? "",
      retries: current?.retryAttempts === undefined ? "" : String(current.retryAttempts),
      age: current?.maxEventAgeSeconds === undefined ? "" : String(current.maxEventAgeSeconds),
    });
  const age = form?.age.trim() ? Number(form.age) : undefined;
  const problem = !form
    ? undefined
    : !form.destination
      ? "Choose a queue or topic."
      : age !== undefined && (!Number.isInteger(age) || age < 60 || age > 21600)
        ? "Maximum age is a whole number from 60 to 21600 seconds."
        : undefined;
  const save = () => {
    if (!form || problem) return;
    draft.setFailure(event, {
      destination: form.destination,
      ...(form.retries ? { retryAttempts: Number(form.retries) } : {}),
      ...(age !== undefined ? { maxEventAgeSeconds: age } : {}),
    });
    setForm(undefined);
  };
  return (
    <div className="mt-4 border-t border-rule pt-3" data-slot="failure-destination">
      <h4 className="mt-0 mb-3 text-label font-semibold text-balance">When a run fails</h4>
      {!form ? (
        current ? (
          <ul className={inspectorRelationListClasses}>
            <InspectorResourceRow
              icon={<EntityIcon size={26} icon={destinationIcon} />}
              title={
                <button
                  className={buttonClasses({ variant: "link" })}
                  onClick={() => select(current.destination)}
                >
                  <DottedName>{titleOf(index, current.destination)}</DottedName>
                </button>
              }
              trailing={
                <>
                  <button
                    className={iconButtonClasses()}
                    aria-label="Change failure destination"
                    title="Change"
                    onClick={begin}
                  >
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button
                    className={iconButtonClasses()}
                    aria-label="Remove failure destination"
                    title="Remove"
                    onClick={() => draft.setFailure(event, null)}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </>
              }
            >
              <span>{policy(current)}</span>
            </InspectorResourceRow>
          </ul>
        ) : (
          <div className={inspectorActionGroupClasses}>
            <p className={inspectorNoteClasses}>Dropped after Lambda's two retries.</p>
            <button
              className={buttonClasses({ variant: "quiet" })}
              aria-label="Set failure destination"
              onClick={begin}
            >
              Set destination
            </button>
          </div>
        )
      ) : (
        <div className="grid gap-3.5" data-slot="trigger-form">
          <label className={triggerFieldLabelClasses}>
            Destination
            <Select
              controlSize="panel"
              className="w-full"
              aria-label="Failure destination"
              value={form.destination}
              onChange={(item) => setForm({ ...form, destination: item.target.value })}
            >
              <option value="">Choose queue or topic</option>
              {choices.map((item) => {
                const fifo = item.facts?.fifo === true || item.facts?.fifoName === true;
                return (
                  <option key={item.resource} value={item.resource} disabled={fifo}>
                    {item.resource.replace(/^resource:/, "")}
                    {fifo ? " · FIFO not supported" : ""}
                  </option>
                );
              })}
            </Select>
          </label>
          <label className={triggerFieldLabelClasses}>
            Retries before it is sent
            <Select
              controlSize="panel"
              className="w-full"
              aria-label="Failure retry attempts"
              value={form.retries}
              onChange={(item) => setForm({ ...form, retries: item.target.value })}
            >
              <option value="">Default (2)</option>
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
            </Select>
          </label>
          <label className={triggerFieldLabelClasses}>
            Maximum event age
            <UnitInput
              controlSize="panel"
              unit="seconds"
              aria-label="Failure maximum event age"
              type="number"
              min={60}
              max={21600}
              placeholder="21600 (six hours)"
              value={form.age}
              onChange={(item) => setForm({ ...form, age: item.target.value })}
            />
          </label>
          <p className="m-0 flex flex-wrap items-baseline gap-2 text-caption text-graphite">
            Applies to EventBridge, SNS, S3 and schedule triggers. Queue and stream triggers use
            their own dead-letter settings.
          </p>
          {problem ? (
            <p className="m-0 flex flex-wrap items-baseline gap-2 text-caption text-refuse wrap-anywhere">
              {problem}
            </p>
          ) : null}
          <div
            className="flex flex-wrap items-center gap-2 empty:hidden"
            data-slot="resource-actions"
          >
            <button
              className={buttonClasses({ variant: "primary" })}
              disabled={!!problem}
              onClick={save}
              data-variant="primary"
            >
              Save destination
            </button>
            <button
              className={buttonClasses({ variant: "quiet" })}
              onClick={() => setForm(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
