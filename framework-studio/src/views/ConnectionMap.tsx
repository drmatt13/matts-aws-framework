import {
  inspectorSectionClasses,
  inspectorTitleClasses,
  inspectorHeaderClasses,
} from "../inspector-ui";

import { InspectorKind, InspectorSummary } from "./InspectorUI";

import type { ConnectionGroup } from "../connections";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { ConnectionDetails, ConnectionEndpoints } from "./InputRequirement";
import {
  presentConnection,
  presentRelationship,
  suppliedByEnvironmentFile,
} from "../connection-presentation";

export function ConnectionMap({ connection }: { readonly connection: ConnectionGroup }) {
  const { model, index } = useStudio();
  const presentation = presentConnection(connection, model.mode, index);
  const members = connection.members.map((member) => {
    const edge = member.models[model.mode] ?? member.edge;
    return { member, edge, relationship: presentRelationship(edge, index) };
  });
  // The heading already names a shared purpose ("Reads: 2 environment values"); its rows name only what differs.
  const shared = new Set(members.map(({ relationship }) => relationship.action)).size === 1;
  // A CDK environment file's rows all share the header's pair.
  const rowPills = !suppliedByEnvironmentFile(connection, index);
  return (
    <>
      <header className={inspectorHeaderClasses} data-slot="connection-header">
        <InspectorKind environments={{ availability: connection.availability }}>
          Connection
        </InspectorKind>
        <h2 className={inspectorTitleClasses}>{presentation.title}</h2>
        <ConnectionEndpoints from={connection.from} to={connection.to} />
      </header>
      <section className={inspectorSectionClasses} aria-label="Connection details">
        {!connection.availability[model.mode] ? (
          <div
            className="[margin-top:14px] p-[10px_var(--space-3)] border border-rule [border-left:3px_solid_var(--faint)] rounded-md [background:rgba(141,159,183,.06)] text-caption"
            role="note"
            aria-label="Connection deployment status"
            data-slot="connection-availability"
          >
            <strong className="inline-block text-graphite">
              Disabled in {model.mode === "dev" ? "Development" : "Production"}
            </strong>
            <p className="my-1.5">
              Both endpoints must be enabled and a relationship must exist in this environment.
            </p>
          </div>
        ) : null}
        <div data-slot="connection-map-members">
          {members.map(({ member, edge, relationship }, position) => {
            const onlyIn = member.models[model.mode]
              ? undefined
              : member.models.dev
                ? "dev"
                : "prod";
            return (
              <details
                key={edge.id}
                className="border-rule not-first:border-t"
                data-slot="connection-map-member"
              >
                <InspectorSummary
                  className={`flex items-center gap-2 cursor-pointer text-caption list-none pb-3 [details:last-child:not([open])>&]:pb-0 [&>svg:first-child]:mr-0 ${position === 0 && connection.availability[model.mode] ? "pt-0" : "pt-3"}`}
                >
                  <span className="grid gap-0.5 min-w-0 flex-1" data-slot="connection-map-label">
                    {shared ? relationship.value : relationship.title}
                  </span>
                  {rowPills ? <EnvironmentPills availability={member.availability} /> : null}
                </InspectorSummary>
                <div className="pb-3 text-caption" data-slot="connection-map-detail">
                  <ConnectionEndpoints
                    compact
                    from={edge.from}
                    to={edge.to}
                    except={{ from: connection.from, to: connection.to }}
                  />
                  <ConnectionDetails compact edge={edge} onlyIn={onlyIn} />
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </>
  );
}
