import { useId } from "react";
import type { ModelResource } from "../../shared/model";
import type { ResourceDetails } from "../../shared/resources";
import type { EnvironmentEdit } from "../draft";
import { useStudio } from "../studio";
import { EnvironmentValueControl } from "./EnvironmentValueControl";
import { RequirementNotice } from "./InputRequirement";

export function LocalValue({ resource, details, error, busy, onRetry }: {
  readonly resource: ModelResource; readonly details?: ResourceDetails; readonly error?: string;
  readonly busy: boolean; readonly onRetry: () => void;
}) {
  const { mode, model, draft, draftState, live, select } = useStudio();
  const help = useId();
  const name = resource.fromEnv!;
  const file = details?.file ?? `cdk-app/.env.${mode}`;
  const pending = draft.environment(mode);
  const edit = pending?.edits.find((item) => item.name === name);
  const value = edit?.value ?? details?.value ?? "";
  const secret = resource.kind === "secret";
  const hasDefault = !secret && resource.default !== undefined;
  const usingDefault = !value.trim() && hasDefault && !!resource.default?.trim();
  const otherChanges = draftState.entries.some((entry) => entry.kind !== "environment" || entry.mode !== mode);
  const disabled = busy || !!draftState.busy || draft.conflict || otherChanges || live.evaluating || live.running !== null || model.stale || !details?.inputFile?.exists;
  const update = (nextValue: string) => {
    if (!details?.inputFile) return;
    const others = pending?.edits.filter((item) => item.name !== name) ?? [];
    const next: EnvironmentEdit = edit ? { ...edit, value: nextValue } : { key: name, name, value: nextValue, ...(details.configured ? { original: details.value ?? "" } : { create: true }) };
    draft.setEnvironment(mode, pending?.hash ?? details.inputFile.hash, !details.configured && nextValue === "" ? others : [...others, next], details.configured ? [name] : []);
  };
  const revert = () => {
    if (pending) draft.setEnvironment(mode, pending.hash, pending.edits.filter((item) => item.name !== name), details?.configured ? [name] : []);
  };
  const status = edit ? "Unsaved change" : usingDefault ? "Using default" : value.trim() ? "Set locally" : details?.configured ? "Empty" : "Not set";
  const requiredMissing = resource.inputRequirement?.required && !value.trim() && !usingDefault;
  return <section className="resource-editor local-input" aria-label="Local value">
    <div className="section-heading"><h3>Local value</h3><span className={`local-input-mode ${mode}`}>{mode === "dev" ? "Development" : "Production"} file</span></div>
    <code className="local-input-name">{name}</code>
    <p className="local-input-source small muted">Saves to <button className="linkish" title="Open all variables in this local file" onClick={() => select(`envfile:${mode}`)}>{file}</button></p>
    {resource.absent || model.stale ? <p className="small muted">{resource.absent ? "Not declared in this graph." : "Unavailable until the configuration loads."}</p>
      : error ? <div className="local-input-error"><p className="reason" role="alert">{error}</p><button className="quiet small" onClick={onRetry}>Retry value read</button></div>
      : !details ? <p role="status" className="small muted">Reading local value…</p>
      : <>
        <div className={`local-input-status${edit ? " pending" : requiredMissing ? " missing" : ""}`} role="status"><span aria-hidden /><span className="inspector-status-copy">
          <span aria-hidden={otherChanges}>{status}</span>
          <span aria-hidden={!otherChanges}>Apply or discard settings to edit this value.</span>
        </span></div>
        {details.inputFile?.exists === false ? <div className="local-input-empty"><p className="small muted">Create this environment file before setting a local value.</p><button className="quiet small" onClick={() => select(`envfile:${mode}`)}>Set up .env.{mode}</button></div>
          : <>
            {resource.values && !secret ? <select className="local-input-choice" aria-label={`Value for ${name}`} aria-describedby={help} value={value} disabled={disabled} onChange={(event) => update(event.target.value)}>
              <option value="">{hasDefault ? `Use default · ${resource.default}` : "No local value"}</option>
              {value && !resource.values.includes(value) ? <option value={value}>{value} (current)</option> : null}
              {resource.values.map((option) => <option key={option}>{option}</option>)}
            </select> : <EnvironmentValueControl key={`${resource.id}:${mode}`} name={name} value={value} sensitive={secret} disabled={disabled} describedBy={help} placeholder={hasDefault ? "Blank uses the default" : secret ? "Enter a secret value…" : "Enter a local value…"} onChange={update} />}
            <div className="local-input-actions">
              {value !== "" ? <button className="linkish small" disabled={disabled} onClick={() => update("")}>{hasDefault ? "Use default" : "Clear local value"}</button> : null}
              {edit ? <button className="linkish small" disabled={!!draftState.busy} onClick={revert}>Revert value</button> : null}
            </div>
          </>}
        <div id={help} className="local-input-help small muted">
          {hasDefault ? <p>Default: <code>{resource.default}</code></p> : !value.trim() ? <p>{requiredMissing ? "A non-blank value is required." : "No local value is supplied."}</p> : null}
          {edit ? <p>Review Changes to save this value. Nothing is deployed.</p> : null}
          {secret ? <p>Masked by default. Saved only in this local file.</p> : null}
          {!details.inputFile ? <p>Restart Studio to enable inline value editing.</p> : null}
        </div>
        {!edit ? <RequirementNotice requirement={resource.inputRequirement} /> : null}
        {pending?.error ? <p className="reason small" role="alert">{pending.error}</p> : null}
      </>}
  </section>;
}
