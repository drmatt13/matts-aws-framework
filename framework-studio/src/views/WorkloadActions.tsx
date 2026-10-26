import { useEffect, useState } from "react";
import type { ModelTarget } from "../../shared/model";
import type { DraftEdit } from "../../shared/api";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";
import { grantOptions, type NativeGrantMethod } from "../../shared/grants";

export function ImplementationStatus({ target }: { readonly target: ModelTarget }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  if (!target.directory) return null;
  const file = `${target.kind === "agent" ? "" : "cdk-app"}${target.directory}/${target.compute.kind === "lambda" && target.compute.implementation === "python" ? "lambda_function.py" : target.kind === "service" || target.kind === "task" ? "index.mjs" : "index.ts"}`.replace(/^\//, "");
  const pending = draftState.entries.some(entry => entry.kind === "operation" && entry.operation.kind === "implementation" && entry.operation.target === target.ref);
  return <InspectorSection title="Implementation">
    <code>{target.directory}</code>
    <p className="small muted">{target.implementation?.ready ? "Required source artifacts present. Runtime and deployment checks are separate." : "Implementation needs attention."}</p>
    {target.implementation?.problems.map(problem => <p key={problem} className="reason" role="status">{problem}</p>)}
    <a className="linkish small" href={editorLink(snapshot.repositoryRoot, { file, line: 1, column: 1, start: 0, end: 0 })}>Open implementation in editor</a>
    {!target.implementation?.ready ? <p><button className="quiet" disabled={pending || !!draftState.busy || draft.conflict || model.stale || live.evaluating} onClick={() => draft.stageOperation({ kind: "implementation", target: target.ref })}>{pending ? "Starter files staged" : "Create missing starter files"}</button></p> : null}
    {pending ? <p className="small muted">Review shows new files at this configured path. Existing files are preserved; nothing starts or deploys.</p> : null}
  </InspectorSection>;
}

export function WorkloadConnections({ target }: { readonly target: ModelTarget }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  const [connection, setConnection] = useState<Extract<DraftEdit, { kind: "connection" }>["connection"]>(target.kind === "agent" ? "tool" : "database");
  const [destination, setDestination] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [variable, setVariable] = useState("");
  const [grant, setGrant] = useState<NativeGrantMethod>("grantRead");
  const [scope, setScope] = useState("uploads/*");
  useEffect(() => { setConnection(target.kind === "agent" ? "tool" : "database"); setDestination(""); setVariable(""); setEnabled(true); }, [target.ref, target.kind]);
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  const destinations = model.targets.filter(item => connection === "runsTask" ? item.kind === "task" : connection === "startsWorkflow" ? item.kind === "workflow" : connection === "invokesAgent" ? item.kind === "agent" : connection === "tool" ? item.role === "tool" : false);
  const simple = connection === "database" || connection === "userPool";
  const catalog = connection === "resource" || connection === "grant";
  const optionsFor = (id: string) => grantOptions(snapshot.source.triggerCapabilities?.find(capability => capability.resource === id)?.canonicalTypes ?? []);
  const resources = model.resources.filter(item => connection === "resource" ? ["input", "secret"].includes(item.kind) : optionsFor(item.id).length > 0);
  const options = optionsFor(destination), selectedGrant = options.find(option => option.method === grant);
  const selectDestination = (value: string) => {
    setDestination(value);
    const first = optionsFor(value)[0];
    setGrant(first?.method ?? "grantRead"); setScope(first?.scope ? "uploads/*" : "");
  };
  const source = snapshot.source.entities[target.ref]?.value;
  return <InspectorDisclosure title="Connect workload">
    {target.kind !== "workflow" ? <>
      <label className="resource-control"><span>Purpose</span><select value={connection} disabled={disabled} onChange={event => { setConnection(event.target.value as typeof connection); setDestination(""); }}>
        {target.kind !== "agent" ? <option value="database">Use application database (IAM)</option> : null}
        {!["agent", "tool"].includes(target.role) ? <option value="userPool">Provide user-pool identifiers</option> : null}
        <option value="runsTask">Run a container task</option><option value="startsWorkflow">Start a workflow</option><option value="invokesAgent">Invoke a JSON agent</option>{target.kind === "agent" ? <option value="tool">Add an agent tool</option> : null}
        <option value="resource">Deliver input or secret</option><option value="grant">Grant AWS resource access</option>
      </select></label>
      {!simple ? <label className="resource-control"><span>Destination</span><select value={destination} disabled={disabled} onChange={event => selectDestination(event.target.value)}><option value="">Select a declared {catalog ? "resource" : "target"}…</option>{catalog ? resources.map(item => <option key={item.id} value={item.id}>{item.path.join(".")} · {item.kind}</option>) : destinations.map(item => <option key={item.ref} value={item.ref}>{item.title} · {item.ref}</option>)}</select></label> : null}
      {connection === "resource" ? <label className="resource-control"><span>Consumer environment variable</span><input value={variable} disabled={disabled} onChange={event => setVariable(event.target.value)} spellCheck={false} /></label> : null}
      {connection === "grant" ? <><label className="resource-control"><span>Permission</span><select value={selectedGrant ? grant : ""} disabled={disabled || !destination} onChange={event => setGrant(event.target.value as NativeGrantMethod)}>{!selectedGrant ? <option value="">Select a resource first…</option> : null}{options.map(option => <option key={option.method} value={option.method}>{option.label}</option>)}</select></label>{selectedGrant?.scope ? <label className="resource-control"><span>Bucket object scope</span><input value={scope} disabled={disabled} onChange={event => setScope(event.target.value)} placeholder="* (all objects)" spellCheck={false} /></label> : null}
        <p className="small muted">{selectedGrant ? `${selectedGrant.label}: ${selectedGrant.method} grants this workload's role access to the selected resource${selectedGrant.scope ? ` (${scope || "all objects"})` : ""}. CDK expands its actions and encryption permissions during synthesis.` : "Choose a resource with a discovered S3, SQS, DynamoDB, SNS or EventBridge type. Custom native grants stay in source."}</p></> : null}
      <label className="resource-control"><span>Action</span><select value={enabled ? "connect" : "disconnect"} disabled={disabled} onChange={event => setEnabled(event.target.value === "connect")}><option value="connect">Connect</option><option value="disconnect">Disconnect</option></select></label>
      <button className="quiet" disabled={disabled || !simple && !destination || connection === "grant" && !selectedGrant || connection === "resource" && !/^[A-Z][A-Z0-9_]*$/.test(variable)} onClick={() => draft.stageOperation({ kind: "connection", target: target.ref, connection, enabled, ...(!simple ? { destination } : {}), ...(connection === "resource" ? { variable } : {}), ...(connection === "grant" ? { grant, scope: selectedGrant?.scope ? scope : "" } : {}) })}>Stage connection change</button>
      <p className="small muted">Review updates declarations, framework bindings and generated artifacts. Database access uses its declared VPC and IAM. User-pool identifiers alone do not authenticate a handler; use the authenticated wrapper in source.</p>
    </> : null}
    <p><button className="quiet" disabled={disabled || draft.dirty} onClick={() => draft.stageOperation({ kind: "removeWorkload", target: target.ref })}>Review declaration removal and source archive</button></p>
    {source ? <p className="small muted">Removal refuses connected consumers and preserves implementation files in a reviewed archive. Existing AWS resources, data and charges remain until a separate deployed-resource removal review. Custom code and unsupported bindings stay source-owned. <a href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a>.</p> : null}
  </InspectorDisclosure>;
}
