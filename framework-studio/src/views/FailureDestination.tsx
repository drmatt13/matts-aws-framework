import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FailureDestinationSettings } from "../../shared/triggers";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";

const TYPES = ["aws-sqs:IQueue", "aws-sns:ITopic"];

interface Form { readonly destination: string; readonly retries: string; readonly age: string }

/**
 * Where an event's failed asynchronous runs go once Lambda stops retrying them.
 * Staged through the shared draft like triggers; queue and stream triggers keep
 * their own failure handling, which the text says.
 */
export function FailureDestination({ event }: { readonly event: string }) {
  const { snapshot, index, draft } = useStudio();
  const [form, setForm] = useState<Form>();
  const current = draft.failure(event);
  const choices = (snapshot.source.triggerCapabilities ?? []).filter((item) => item.canonicalTypes.some((type) => TYPES.includes(type)));
  const describe = (value: FailureDestinationSettings) => `Sent to ${titleOf(index, value.destination)} after ${value.retryAttempts ?? 2} ${value.retryAttempts === 1 ? "retry" : "retries"}${value.maxEventAgeSeconds !== undefined ? `, or once ${value.maxEventAgeSeconds}s old` : ""}.`;
  const age = form?.age.trim() ? Number(form.age) : undefined;
  const problem = !form ? undefined
    : !form.destination ? "Choose a queue or topic."
    : age !== undefined && (!Number.isInteger(age) || age < 60 || age > 21600) ? "Maximum age is a whole number from 60 to 21600 seconds."
    : undefined;
  const save = () => {
    if (!form || problem) return;
    draft.setFailure(event, { destination: form.destination, ...(form.retries ? { retryAttempts: Number(form.retries) } : {}), ...(age !== undefined ? { maxEventAgeSeconds: age } : {}) });
    setForm(undefined);
  };
  return <div className={"mt-3 [padding-top:10px] border-t border-rule [&_h5]:m-[0_0_var(--space-1)] [&_h5]:text-step-minus1 [&_h5]:text-graphite [&_h5]:uppercase [&_h5]:[letter-spacing:.04em] [&_p]:flex [&_p]:flex-wrap [&_p]:gap-2 [&_p]:items-baseline [&_p]:m-0"} data-slot="failure-destination">
    <h5>When a run fails</h5>
    {!form ? <p className={"text-caption"}>
      <span>{current ? describe(current) : "Dropped after Lambda's two retries."}</span>
      <button className={cx(buttonClasses({ variant: "link", className: "inline-flex items-center gap-[3px]" }), "text-caption")} aria-label={current ? "Change failure destination" : "Set failure destination"} onClick={() => setForm({ destination: current?.destination ?? "", retries: current?.retryAttempts === undefined ? "" : String(current.retryAttempts), age: current?.maxEventAgeSeconds === undefined ? "" : String(current.maxEventAgeSeconds) })}><Pencil size={12} aria-hidden />{current ? "Change" : "Set destination"}</button>
      {current ? <button className={cx(buttonClasses({ variant: "link", className: "inline-flex items-center gap-[3px]" }), "text-caption")} aria-label="Remove failure destination" onClick={() => draft.setFailure(event, null)}><Trash2 size={12} aria-hidden />Remove</button> : null}
    </p> : <div className={"[&_label]:grid [&_label]:gap-1 [&_label]:text-step-minus1 [&_input:not([type=checkbox])]:w-full [&_select]:w-full [&_textarea]:w-full grid mt-3 [gap:14px] [padding-top:6px]"} data-slot="trigger-form">
      <label>Destination<Select aria-label="Failure destination" value={form.destination} onChange={(item) => setForm({ ...form, destination: item.target.value })}>
        <option value="">Choose queue or topic</option>
        {choices.map((item) => { const fifo = item.facts?.fifo === true || item.facts?.fifoName === true; return <option key={item.resource} value={item.resource} disabled={fifo}>{item.resource.replace(/^resource:/, "")}{fifo ? " · FIFO not supported" : ""}</option>; })}
      </Select></label>
      <label>Retries before it is sent<Select aria-label="Failure retry attempts" value={form.retries} onChange={(item) => setForm({ ...form, retries: item.target.value })}>
        <option value="">Default (2)</option><option value="0">0</option><option value="1">1</option><option value="2">2</option>
      </Select></label>
      <label>Maximum event age (seconds)<TextInput aria-label="Failure maximum event age" type="number" min={60} max={21600} placeholder="21600 (six hours)" value={form.age} onChange={(item) => setForm({ ...form, age: item.target.value })} /></label>
      <p className={"text-caption text-graphite"}>Applies to EventBridge, SNS, S3 and schedule triggers. Queue and stream triggers use their own dead-letter settings.</p>
      {problem ? <p className={"text-refuse wrap-anywhere text-caption"}>{problem}</p> : null}
      <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions">
        <button className={buttonClasses({ variant: "primary", size: "compact" })} disabled={!!problem} onClick={save} data-variant="primary">Save destination</button>
        <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={() => setForm(undefined)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
