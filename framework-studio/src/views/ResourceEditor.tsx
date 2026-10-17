import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelResource } from "../../shared/model";
import type { ResourceDetails, ResourceIntent, ResourcePlan } from "../../shared/resources";
import { api } from "../api";
import { useStudio } from "../studio";

export function ResourceEditor({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, mode, model, live, select, toast } = useStudio();
  const query = useQueryClient();
  const [details, setDetails] = useState<ResourceDetails>();
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState(resource.kind === "secret");
  const [fallback, setFallback] = useState(resource.default ?? "");
  const [hasDefault, setHasDefault] = useState(resource.default !== undefined);
  const [group, setGroup] = useState(resource.path.length > 1 ? resource.path[0]! : "");
  const [requirements, setRequirements] = useState<ResourceIntent["requirements"]>({});
  const [plan, setPlan] = useState<ResourcePlan>();
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const previewElement = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setRevealed(false);
    setPlan(undefined);
    setError(undefined);
    setSecret(resource.kind === "secret");
    setFallback(resource.default ?? "");
    setHasDefault(resource.default !== undefined);
    setGroup(resource.path.length > 1 ? resource.path[0]! : "");
    setRequirements({});
    ++request.current;
    setBusy(false);
    if (!resource.absent && !model.stale) {
      void api.resourceDetails(resource.id, mode, controller.signal).then(setDetails).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load this input.");
      });
    }
    return () => { controller.abort(); ++request.current; };
  }, [resource, snapshot.revision, mode, model.stale]);

  useEffect(() => { if (plan) previewElement.current?.scrollIntoView({ block: "start" }); }, [plan]);

  const intent: ResourceIntent = { resource: resource.id, kind: secret ? "secret" : "input", default: secret || !hasDefault ? null : fallback, group: group.trim(), requirements };
  const changed = intent.kind !== resource.kind || intent.default !== (resource.default ?? null) || intent.group !== (resource.path.length > 1 ? resource.path[0] : "") || Object.keys(requirements).length > 0;
  const disabled = busy || live.evaluating || live.running !== null || model.stale || resource.absent;
  const preview = async () => {
    const serial = ++request.current;
    setBusy(true); setError(undefined);
    try {
      const result = await api.resourcePlan(intent, snapshot.revision, mode);
      if (request.current === serial) setPlan(result);
    } catch (reason) { if (request.current === serial) setError(reason instanceof Error ? reason.message : "Could not preview this edit."); }
    finally { if (request.current === serial) setBusy(false); }
  };
  const write = async (direction?: "undo" | "redo") => {
    const serial = ++request.current;
    setBusy(true); setError(undefined);
    try {
      const result = direction ? await api.resourceHistory(direction) : await api.resourceApply(plan!.planId);
      toast(result.message, result.status === "applied" ? "plain" : "refuse");
      if (new URL(window.location.href).searchParams.get("select") === resource.id) select(result.resource);
      setPlan(undefined);
      await query.invalidateQueries({ queryKey: ["snapshot"] });
    } catch (reason) { if (request.current === serial) setError(reason instanceof Error ? reason.message : "Could not write this edit."); }
    finally { if (request.current === serial) setBusy(false); }
  };
  const invalidate = () => { setPlan(undefined); ++request.current; };
  return <>
    <section className="resource-editor">
      <h3>Local value</h3>
      <div className="resource-value">
        <code>{resource.fromEnv}</code>
        {resource.absent ? <p className="muted">Not declared in this graph.</p> : details ? <>
          <pre className="env-value">{details.configured ? resource.kind === "secret" && !revealed ? "••••••••••••" : details.value === "" ? "(empty)" : details.value : "Not set in cdk-app/.env"}</pre>
          {resource.kind === "secret" && details.configured ? <button className="quiet" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>{revealed ? "Hide value" : "Reveal value"}</button> : null}
          {!details.configured && resource.default !== undefined ? <p className="small muted">Using default: <code>{resource.default}</code></p> : null}
        </> : <p className="small muted" role="status">{model.stale ? "Unavailable until the configuration loads." : "Reading cdk-app/.env…"}</p>}
      </div>
    </section>
    <section className="resource-editor">
      <h3>Configuration</h3>
      <fieldset disabled={disabled} onChange={invalidate}>
        <label className="resource-check"><input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />Secret</label>
        <p className="small muted">{secret ? "Uploaded to Secrets Manager at deployment. The value belongs in cdk-app/.env." : "Read as a regular string from cdk-app/.env."}</p>
        <label className="resource-check"><input type="checkbox" checked={!secret && hasDefault} disabled={secret} onChange={(event) => setHasDefault(event.target.checked)} />Default value</label>
        {!secret && hasDefault ? <label className="resource-control"><span className="sr-only">Default value</span>{resource.values ? <select aria-label="Default value" value={fallback} onChange={(event) => setFallback(event.target.value)}><option value="" disabled>Choose a default</option>{resource.values.map((value) => <option key={value}>{value}</option>)}</select> : <input aria-label="Default value" value={fallback} onChange={(event) => setFallback(event.target.value)} />}</label> : null}
        {secret ? <p className="small muted">Secrets have no source-code default.</p> : null}
        <label className="resource-control"><span>Group</span><input aria-label="Resource group" list="resource-groups" value={group} placeholder="Ungrouped" onChange={(event) => setGroup(event.target.value)} /><datalist id="resource-groups">{model.resources.filter((item) => item.kind === "group").map((item) => <option key={item.id} value={item.path[0]} />)}</datalist></label>
        <p className="small muted">Leave empty for no group. Moving an input updates references and preserves its environment variable name.</p>
        <h4>Required to deploy</h4>
        {details?.consumers.length ? details.consumers.map((consumer) => {
          const rules = consumer.rules.filter((rule) => rule.require.includes(resource.id));
          const summary = rules.length ? rules.map((rule) => rule.when ? `When ${rule.when.resource.slice(9)} = ${JSON.stringify(rule.when.equals)}` : "Required").join("; ") : "Optional";
          return <label key={consumer.target} className="resource-control"><span>{consumer.title}</span><select aria-label={`Deployment requirement for ${consumer.title}`} value={requirements[consumer.target] ?? "preserve"} onChange={(event) => setRequirements((current) => {
            const next = { ...current };
            if (event.target.value === "preserve") delete next[consumer.target];
            else next[consumer.target] = event.target.value as "required" | "optional";
            return next;
          })}><option value="preserve">Keep current: {summary}</option><option value="required">Required</option><option value="optional">Optional</option></select></label>;
        }) : <p className="small muted">No workload consumes this input. Application stacks may have their own requirements.</p>}
        <p className="small muted">Requirements apply to enabled workloads in each graph. Conditional rules stay as declared unless you change them here.</p>
      </fieldset>
      {error ? <p className="reason" role="alert">{error}</p> : null}
      <div className="resource-actions"><button className="primary" disabled={disabled || !changed || !details || (!secret && hasDefault && !fallback.trim())} onClick={() => void preview()}>{busy ? "Checking…" : "Preview changes"}</button>
        {details?.history.undo ? <button className="quiet" disabled={disabled} onClick={() => void write("undo")}>Undo resource edit</button> : null}
        {details?.history.redo ? <button className="quiet" disabled={disabled} onClick={() => void write("redo")}>Redo resource edit</button> : null}
      </div>
    </section>
    {plan ? <section ref={previewElement} className="resource-preview" aria-label="Resource edit preview">
      <h3>Review resource changes</h3>
      <p className={plan.ok ? "small" : "reason"}>{plan.ok ? "Accepted by both graphs and TypeScript." : "This change cannot be applied."}</p>
      {plan.diagnostics.map((diagnostic, index) => <p key={index} className={diagnostic.severity === "error" ? "reason" : "small muted"}>{diagnostic.message}</p>)}
      {Object.keys(requirements).length ? <p className="small muted">Changed workloads receive their own requirement list; other shared consumers keep their original rules.</p> : null}
      {plan.changes.map((change) => <details key={change.file} open><summary><code>{change.file}</code></summary><pre className="resource-diff">{change.diff.lines.map((line, index) => <span key={index} className={line.kind}>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}{line.text}{"\n"}</span>)}</pre></details>)}
      <div className="resource-actions"><button className="quiet" disabled={disabled} onClick={() => setPlan(undefined)}>Cancel</button><button className="primary" disabled={disabled || !plan.ok} onClick={() => void write()}>Apply resource changes</button></div>
    </section> : null}
  </>;
}
