import type { ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";

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

export function WorkloadRemoval({ target }: { readonly target: ModelTarget }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  const source = snapshot.source.entities[target.ref]?.value;
  return <InspectorDisclosure title="Remove workload">
    <p className="small muted">Review declaration removal and archive its implementation. Connected consumers must be removed first.</p>
    <button className="quiet" disabled={!!draftState.busy || draft.conflict || model.stale || live.evaluating || draft.dirty} onClick={() => draft.stageOperation({ kind: "removeWorkload", target: target.ref })}>Review declaration removal and source archive</button>
    <p className="small muted">Deployed AWS resources remain until a separate deployment.{source ? <> <a href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a>.</> : null}</p>
  </InspectorDisclosure>;
}
