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
  return <div className="failure-destination">
    <h5>When a run fails</h5>
    {!form ? <p className="small">
      <span>{current ? describe(current) : "Dropped after Lambda's two retries."}</span>
      <button className="linkish small" aria-label={current ? "Change failure destination" : "Set failure destination"} onClick={() => setForm({ destination: current?.destination ?? "", retries: current?.retryAttempts === undefined ? "" : String(current.retryAttempts), age: current?.maxEventAgeSeconds === undefined ? "" : String(current.maxEventAgeSeconds) })}><Pencil size={12} aria-hidden />{current ? "Change" : "Set destination"}</button>
      {current ? <button className="linkish small" aria-label="Remove failure destination" onClick={() => draft.setFailure(event, null)}><Trash2 size={12} aria-hidden />Remove</button> : null}
    </p> : <div className="trigger-form">
      <label>Destination<select aria-label="Failure destination" value={form.destination} onChange={(item) => setForm({ ...form, destination: item.target.value })}>
        <option value="">Choose queue or topic</option>
        {choices.map((item) => { const fifo = item.facts?.fifo === true || item.facts?.fifoName === true; return <option key={item.resource} value={item.resource} disabled={fifo}>{item.resource.replace(/^resource:/, "")}{fifo ? " · FIFO not supported" : ""}</option>; })}
      </select></label>
      <label>Retries before it is sent<select aria-label="Failure retry attempts" value={form.retries} onChange={(item) => setForm({ ...form, retries: item.target.value })}>
        <option value="">Default (2)</option><option value="0">0</option><option value="1">1</option><option value="2">2</option>
      </select></label>
      <label>Maximum event age (seconds)<input aria-label="Failure maximum event age" type="number" min={60} max={21600} placeholder="21600 (six hours)" value={form.age} onChange={(item) => setForm({ ...form, age: item.target.value })} /></label>
      <p className="small muted">Applies to EventBridge, SNS, S3 and schedule triggers. Queue and stream triggers use their own dead-letter settings.</p>
      {problem ? <p className="reason small">{problem}</p> : null}
      <div className="resource-actions">
        <button className="primary compact" disabled={!!problem} onClick={save}>Save destination</button>
        <button className="quiet small" onClick={() => setForm(undefined)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
