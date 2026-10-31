import {
  inspectorSectionClasses,
  inspectorTitleClasses,
  inspectorHeaderClasses,
} from "../inspector-ui";

import { InspectorKind, InspectorSummary } from "./InspectorUI";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import type { InputRequirement } from "../../shared/deployment-inputs";
import type { Mode, ModelEdge } from "../../shared/model";
import { editorLink, endpointLabel, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { Written } from "./Written";
import { connectionDisabledEndpoints, type Availability } from "../deployment";
import { edgeAvailability } from "../connections";
import { connectionDescriptionId } from "../../shared/descriptions";
import { Description } from "./Description";
import { connectionTitle, presentRelationship } from "../connection-presentation";
import { AuthorizationDetails } from "./Authorization";

export function RequirementNotice({ requirement }: { requirement?: InputRequirement }) {
  if (!requirement?.required) return null;
  const missing = requirement.status === "missing";
  return (
    <div
      className={cx(
        "my-[10px] rounded-md border-l-[3px] px-3 py-[10px] text-caption",
        missing ? "border-refuse bg-refuse-wash" : "border-graphite bg-[rgba(141,159,183,.06)]",
      )}
      role={missing ? "alert" : "note"}
      data-slot="input-requirement"
    >
      <strong className={missing ? "text-refuse" : ""}>
        {missing ? "Required value missing" : "Required input"}
      </strong>
      <p className="my-1.25">
        <code>{requirement.name}</code> is required for{" "}
        {requirement.mode === "dev" ? "Development" : "Production"}.
        {missing
          ? " No non-blank environment value or declaration default supplies it."
          : requirement.status === "default"
            ? " A declaration default currently supplies it."
            : requirement.status === "unknown"
              ? " Its value could not be checked. Fix the configuration or file read error first."
              : ` Supplied by ${requirement.file}.`}
      </p>
      {requirement.reasons.map((reason) => (
        <p className="my-1.25 text-caption text-graphite" key={reason}>
          {reason}
        </p>
      ))}
    </div>
  );
}

/** From and To, omitting an end the surrounding heading already names (a bundle member's shared endpoint). */
export function ConnectionEndpoints({
  from,
  to,
  except,
  compact = false,
}: {
  readonly from: string;
  readonly to: string;
  readonly compact?: boolean;
  readonly except?: { readonly from: string; readonly to: string };
}) {
  const { index, select } = useStudio();
  const rows = (
    [
      ["From", from],
      ["To", to],
    ] as const
  ).filter(([direction, id]) => except?.[direction === "From" ? "from" : "to"] !== id);
  if (!rows.length) return null;
  return (
    <dl
      className={cx(
        "mx-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.75 text-caption",
        compact ? "mt-0 mb-2" : "mt-1 mb-0",
      )}
      data-slot="connection-endpoints"
    >
      {rows.map(([direction, id]) => (
        <div className="col-span-2 grid grid-cols-subgrid items-baseline" key={direction}>
          <dt className="text-graphite">{direction}</dt>
          <dd className="m-0 min-w-0 wrap-anywhere">
            <button className={buttonClasses({ variant: "link" })} onClick={() => select(id)}>
              {endpointLabel(index, id)}
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ConnectionView({
  edge,
  onlyIn,
  availability,
}: {
  edge: ModelEdge;
  onlyIn?: Mode;
  availability?: Availability;
}) {
  const { snapshot, index } = useStudio();
  return (
    <>
      <header className={inspectorHeaderClasses} data-slot="connection-header">
        <InspectorKind
          environments={{ availability: availability ?? edgeAvailability(edge, snapshot.models) }}
        >
          {edge.inputRequirement ? "Input connection" : "Connection"}
        </InspectorKind>
        <h2 className={inspectorTitleClasses}>{connectionTitle(edge, index)}</h2>
        <ConnectionEndpoints from={edge.from} to={edge.to} />
      </header>
      <Description entity={connectionDescriptionId(edge)} connection />
      <section
        className={cx(
          inspectorSectionClasses,
          "has-[>[data-slot=connection-details]:empty]:hidden",
        )}
      >
        <ConnectionDetails edge={edge} onlyIn={onlyIn} description={false} />
      </section>
    </>
  );
}

/** A bundled connection row leads with its own description; a lone connection's sits under the header instead. */
export function ConnectionDetails({
  edge,
  onlyIn,
  description = true,
  compact = false,
}: {
  edge: ModelEdge;
  onlyIn?: Mode;
  description?: boolean;
  compact?: boolean;
}) {
  const { index, select, snapshot, mode, setMode, draft } = useStudio();
  const descriptionId = connectionDescriptionId(edge);
  const requirement = edge.inputRequirement;
  const resource = requirement
    ? snapshot.models[requirement.mode].resources.find((item) => item.id === requirement.resource)
    : undefined;
  const disabledEndpoints = connectionDisabledEndpoints(index, mode, edge);
  const disabled = onlyIn !== undefined || disabledEndpoints.length > 0;
  const environment = mode === "dev" ? "Development" : "Production";
  const presentation = presentRelationship(edge, index);
  return (
    <div data-slot="connection-details">
      {description ? (
        <details
          className={cx("mb-2.5", compact ? "mt-0" : "mt-2.5 first:mt-0")}
          key={descriptionId}
          data-slot="connection-description"
        >
          <InspectorSummary className="cursor-pointer text-caption text-graphite">
            {draft.description(descriptionId).trim() ? "Description" : "Add description"}
          </InspectorSummary>
          <Description entity={descriptionId} connection inline />
        </details>
      ) : null}
      {disabled ? (
        <div
          className={cx(
            "px-3 py-2.5 border border-rule border-l-[3px] border-l-faint rounded-md bg-[rgba(141,159,183,.06)] text-caption",
            compact ? "mt-0" : "mt-3.5 first:mt-0",
          )}
          role="note"
          aria-label="Connection deployment status"
          data-slot="connection-availability"
        >
          <strong className="inline-block text-graphite">Disabled in {environment}</strong>
          {onlyIn ? (
            <p className="my-1.5">
              This connection exists only in {onlyIn === "dev" ? "Development" : "Production"}.
            </p>
          ) : null}
          {disabledEndpoints.length ? (
            <>
              <p className="my-1.5">Both endpoints must be enabled in this environment.</p>
              <ul className="mt-1.5 mb-0 pl-4.5">
                {disabledEndpoints.map((id) => (
                  <li key={id}>
                    <button
                      className={buttonClasses({ variant: "link" })}
                      onClick={() => select(id)}
                    >
                      {titleOf(index, id)}
                    </button>{" "}
                    is not enabled in {environment}.
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      <RequirementNotice requirement={requirement} />
      {presentation.lines
        .filter((line) => !requirement || line !== "Required value missing.")
        .map((line) => (
          <p className="mt-0 mb-2 text-caption" key={line}>
            {line}
          </p>
        ))}
      {edge.authorization ? (
        <details className="my-2.5 first:mt-0" data-slot="connection-authorization">
          <InspectorSummary className="cursor-pointer text-caption text-graphite">
            Permissions
          </InspectorSummary>
          <AuthorizationDetails authorization={edge.authorization} />
        </details>
      ) : null}
      {requirement && !requirement.required ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          Optional in this environment.
          {requirement.status === "default"
            ? " A parameter default supplies it."
            : requirement.status === "configured"
              ? " An environment value is configured."
              : ""}
        </p>
      ) : null}
      {requirement ? (
        <>
          <h3 className="text-label font-semibold text-balance mt-4 mb-2">
            {requirement.status === "missing" ? "Resolve this requirement" : "Manage this input"}
          </h3>
          <p className="mt-0 mb-2 text-caption">
            Set a non-blank value in <code>{requirement.file}</code>
            {resource?.kind === "secret"
              ? ". Secret values stay in the local environment file and never belong in a source-code default."
              : ", or define a default on the parameter."}
          </p>
          <div
            className="empty:hidden flex flex-wrap gap-2 my-3 items-center"
            data-slot="resource-actions"
          >
            <button
              className={buttonClasses({ variant: "quiet" })}
              onClick={() => select(`envfile:${requirement.mode}`)}
            >
              Edit .env.{requirement.mode}
            </button>
            <button
              className={buttonClasses({ variant: "quiet" })}
              onClick={() => {
                if (mode !== requirement.mode) setMode(requirement.mode);
                select(requirement.resource);
              }}
            >
              {resource?.kind === "secret" ? "Open secret settings" : "Set a parameter default"}
            </button>
          </div>
          <p className="mt-0 mb-2 text-caption text-graphite">
            Review and apply your draft to update this connection. Saving does not deploy
            infrastructure or upload a secret.
          </p>
        </>
      ) : null}
      {edge.detail?.trim() || edge.evidence?.length || edge.source ? (
        <details
          className="my-2.5 first:mt-0 group/configuration"
          data-slot="connection-configuration"
        >
          <InspectorSummary className="cursor-pointer text-caption text-graphite group-open/configuration:mb-2.5">
            Configuration
          </InspectorSummary>
          {edge.detail?.trim() ? <p className="mt-0 mb-2">{edge.detail}</p> : null}
          {edge.provenance === "derived" ? (
            <p className="mt-0 mb-2 text-caption text-graphite">
              Derived from the linked declaration.
            </p>
          ) : null}
          {edge.provenance === "source" ? (
            <p className="mt-0 mb-2 text-caption text-graphite">
              Inferred from source; deployment and runtime behavior are not verified.
            </p>
          ) : null}
          {edge.evidence?.length ? (
            <div className="mt-4 grid gap-3" data-slot="connection-evidence">
              {edge.evidence.map((item) => (
                <div key={`${item.role}:${item.location.file}:${item.location.start}`}>
                  <Written
                    placement="evidence"
                    location={item.location}
                    label={item.role === "derived" ? "Derived from" : item.role}
                  />
                  {item.excerpt ? (
                    <a
                      className="block text-meta wrap-anywhere text-graphite no-underline hover:text-ink hover:underline"
                      href={editorLink(snapshot.repositoryRoot, item.location)}
                      data-slot="evidence-line"
                    >
                      <code>
                        <span className="text-graphite">{item.location.line}</span> {item.excerpt}
                      </code>
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : edge.source ? (
            <Written location={edge.source} />
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
