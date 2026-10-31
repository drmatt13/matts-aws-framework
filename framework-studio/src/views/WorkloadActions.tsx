import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import type { ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";
import { editorLink } from "../lookup";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";
import {
  inspectorActionGroupClasses,
  inspectorIntroClasses,
  inspectorNoteClasses,
} from "../inspector-ui";

export function ImplementationStatus({ target }: { readonly target: ModelTarget }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  if (!target.directory) return null;
  const file =
    `${target.kind === "agent" ? "" : "cdk-app"}${target.directory}/${target.compute.kind === "lambda" && target.compute.implementation === "python" ? "lambda_function.py" : target.kind === "service" || target.kind === "task" ? "index.mjs" : "index.ts"}`.replace(
      /^\//,
      "",
    );
  const pending = draftState.entries.some(
    (entry) =>
      entry.kind === "operation" &&
      entry.operation.kind === "implementation" &&
      entry.operation.target === target.ref,
  );
  return (
    <InspectorSection title="Implementation" contentClassName="grid justify-items-start gap-2">
      <div className="grid min-w-0 gap-1">
        <code className="text-caption wrap-anywhere">{target.directory}</code>
        <p className={inspectorNoteClasses}>
          {target.implementation?.ready
            ? "Required source artifacts present. Runtime and deployment checks are separate."
            : "Implementation needs attention."}
        </p>
      </div>
      {target.implementation?.problems.map((problem) => (
        <p key={problem} className="m-0 text-caption text-refuse wrap-anywhere" role="status">
          {problem}
        </p>
      ))}
      <a
        className={cx(buttonClasses({ variant: "link" }), "text-caption")}
        href={editorLink(snapshot.repositoryRoot, { file, line: 1, column: 1, start: 0, end: 0 })}
      >
        Open implementation in editor
      </a>
      {!target.implementation?.ready ? (
        <div className={cx(inspectorActionGroupClasses, "mt-1")}>
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={
              pending || !!draftState.busy || draft.conflict || model.stale || live.evaluating
            }
            onClick={() => draft.stageOperation({ kind: "implementation", target: target.ref })}
          >
            {pending ? "Starter files staged" : "Create missing starter files"}
          </button>
          {pending ? (
            <p className={inspectorNoteClasses}>
              Review shows new files at this configured path. Existing files are preserved; nothing
              starts or deploys.
            </p>
          ) : null}
        </div>
      ) : null}
    </InspectorSection>
  );
}

export function WorkloadRemoval({ target }: { readonly target: ModelTarget }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  const source = snapshot.source.entities[target.ref]?.value;
  return (
    <InspectorDisclosure title="Remove workload">
      <p className={inspectorIntroClasses}>
        Review declaration removal and archive its implementation. Connected consumers must be
        removed first.
      </p>
      <div className={inspectorActionGroupClasses}>
        <button
          className={buttonClasses({ variant: "quiet" })}
          disabled={
            !!draftState.busy || draft.conflict || model.stale || live.evaluating || draft.dirty
          }
          onClick={() => draft.stageOperation({ kind: "removeWorkload", target: target.ref })}
        >
          Review declaration removal and source archive
        </button>
        <p className={inspectorNoteClasses}>
          Deployed AWS resources remain until a separate deployment.
          {source ? (
            <>
              {" "}
              <a href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a>.
            </>
          ) : null}
        </p>
      </div>
    </InspectorDisclosure>
  );
}
