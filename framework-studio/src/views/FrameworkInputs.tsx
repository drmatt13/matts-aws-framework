import { useEffect, useState } from "react";
import { FRAMEWORK_INPUT_GROUPS } from "../../shared/deployment-inputs";
import type { Mode, ModelResource } from "../../shared/model";
import type { ResourceDetails } from "../../shared/resources";
import { api } from "../api";
import {
  environmentCardClasses,
  inspectorHeaderClasses,
  inspectorNoteClasses,
  inspectorSectionClasses,
} from "../inspector-ui";
import { resourceIcon } from "../icons";
import { resourceIssues } from "../issues";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Description } from "./Description";
import { EntityIcon } from "./EntityIcon";
import { EntityName } from "./EntityName";
import { InputGroupEntries } from "./InputGroup";
import {
  EnvironmentName,
  InspectorKind,
  InspectorSection,
} from "./InspectorUI";
import { IssueNotice } from "./IssueNotice";
import { LocalValue } from "./LocalValue";
import { FrameworkManagedStatus } from "./ResourceStatus";

const MODES = ["dev", "prod"] as const;
const file = (mode: Mode) => `cdk-app/.env.${mode}`;
const pills = (modes: Readonly<Record<Mode, boolean>>) => ({
  availability: modes,
  descriptions: {
    dev: `read from ${file("dev")}`,
    prod: `read from ${file("prod")}`,
  },
  unavailableDescription: "not read",
});

/** Links to the inspectors that edit these values: the files themselves. */
function FileLinks({ modes }: { readonly modes: readonly Mode[] }) {
  const { select } = useStudio();
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-graphite">
      Edit values in
      {modes.map((mode) => (
        <button
          key={mode}
          className={cx(buttonClasses({ variant: "link" }), "text-caption")}
          aria-label={`Edit ${file(mode)} values`}
          onClick={() => select(`envfile:${mode}`)}
        >
          {file(mode)}
        </button>
      ))}
    </p>
  );
}

/**
 * A framework-managed input group: the variables one reader takes from the CDK inputs files. It
 * holds exactly what the framework reads, so nothing is added here; each entry's value is a file line.
 */
export function FrameworkInputGroupView({
  resource,
}: {
  readonly resource: ModelResource;
}) {
  const { model } = useStudio();
  const group = FRAMEWORK_INPUT_GROUPS[resource.frameworkInput!];
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={pills({
            dev: group.modes.includes("dev"),
            prod: group.modes.includes("prod"),
          })}
        >
          Framework input group
        </InspectorKind>
        <EntityName
          entity={resource.id}
          fallback={group.title}
          icon={<EntityIcon size={24} icon="group" />}
        />
        <FrameworkManagedStatus />
        <IssueNotice issues={resourceIssues(resource, model.resources)} />
      </header>
      <Description entity={resource.id} />
      <InspectorSection
        title="Read by"
        contentClassName="grid gap-2"
        data-slot="framework-input-reader"
      >
        <p className={inspectorNoteClasses}>
          Read by {group.reader} from {group.modes.map(file).join(" and ")};
          workloads never read them. Framework inputs take no default, so each
          file supplies its own values, and a required one it leaves unset is an
          error on its connection.
        </p>
        {group.rule ? <p className={inspectorNoteClasses}>{group.rule}</p> : null}
        <FileLinks modes={group.modes} />
      </InspectorSection>
      <InputGroupEntries group={resource} />
    </>
  );
}

/**
 * One framework-managed input. Its behavior is the framework's (which files supply it, and where
 * it is required) and takes no default, so it is shown, not edited; its value is edited in place
 * like any input's, through the file.
 */
export function FrameworkInputView({
  resource,
}: {
  readonly resource: ModelResource;
}) {
  const { model, mode, snapshot, select, draftState } = useStudio();
  const group = FRAMEWORK_INPUT_GROUPS[resource.frameworkInput!];
  const modes = {
    dev: !!resource.modes?.dev.present,
    prod: !!resource.modes?.prod.present,
  };
  const [details, setDetails] = useState<ResourceDetails>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setError(undefined);
    if (!resource.absent && !model.stale)
      void api
        .resourceDetails(resource.id, mode, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setDetails(value);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load this input.",
            );
        });
    return () => controller.abort();
  }, [resource, snapshot.revision, mode, model.stale, reload]);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind environments={pills(modes)}>
          {resource.kind === "secret" ? "Framework secret" : "Framework input"}
        </InspectorKind>
        <EntityName
          entity={resource.id}
          fallback={resource.path.at(-1)!}
          icon={<EntityIcon size={24} icon={resourceIcon(resource)} />}
        />
        {/* Ownership sits directly below the title, as in every resource family's inspector. */}
        <FrameworkManagedStatus />
        <code
          className="block text-graphite text-meta wrap-anywhere"
          data-slot="ref"
        >
          {resource.fromEnv}
        </code>
        <p className="mt-1 mb-0 text-caption text-graphite">
          In framework input group{" "}
          <button
            className={buttonClasses({ variant: "link" })}
            onClick={() => select(resource.parent!)}
          >
            {group.title}
          </button>
        </p>
        <IssueNotice issues={resourceIssues(resource, model.resources)} />
      </header>
      <Description entity={resource.id} />
      <section
        className={inspectorSectionClasses}
        aria-label="Input settings"
        data-slot="framework-input-behavior"
      >
        <h3 className="mt-0 mb-3 text-label font-semibold">Input behavior</h3>
        <div
          className="grid grid-cols-2 gap-2 inspector-360:grid-cols-1"
          data-slot="input-modes"
        >
          {MODES.map((environment) => {
            const policy = resource.modes?.[environment];
            const present = !!policy?.present;
            return (
              <div
                key={environment}
                className={environmentCardClasses({
                  mode: environment,
                  active: present,
                })}
                data-slot="input-mode"
                data-mode={environment}
              >
                <EnvironmentName mode={environment} active={present} />
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
                  <dt className="text-graphite">Available</dt>
                  <dd className="m-0">{present ? "Yes" : "No"}</dd>
                  <dt className="text-graphite">Required</dt>
                  <dd className="m-0">{policy?.required ? "Yes" : "No"}</dd>
                  <dt className="text-graphite">Default</dt>
                  <dd className="m-0">None</dd>
                </dl>
              </div>
            );
          })}
        </div>
        {resource.note ? (
          <p className="mt-3 mb-0 text-caption">{resource.note}</p>
        ) : null}
        <p className={cx(inspectorNoteClasses, "mt-2")}>
          Framework managed: {group.reader} reads it from the inputs file, so it
          takes no default and its behavior is not edited here. Set its value
          below or in the file.
        </p>
      </section>
      {resource.absent ? (
        <section className={inspectorSectionClasses} aria-label="Local value">
          <p className="m-0 text-caption text-graphite">
            Not read in {mode === "dev" ? "Development" : "Production"}.
          </p>
          <FileLinks
            modes={MODES.filter((environment) => modes[environment])}
          />
        </section>
      ) : (
        <LocalValue
          resource={resource}
          details={details}
          error={error}
          busy={!!draftState.busy}
          onRetry={() => setReload((value) => value + 1)}
        />
      )}
    </>
  );
}
