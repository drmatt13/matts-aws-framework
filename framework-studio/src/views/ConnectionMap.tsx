import {
  inspectorSectionClasses,
  inspectorTitleClasses,
  inspectorHeaderClasses,
} from "../inspector-ui";

import { X } from "lucide-react";
import { cx } from "../ui/classes";
import { InspectorKind, InspectorSummary } from "./InspectorUI";
import { IssueNotice } from "./IssueNotice";

import type { ConnectionGroup } from "../connections";
import type { Mode } from "../../shared/model";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { ConnectionDetails, ConnectionEndpoints } from "./InputRequirement";
import {
  connectionIssues,
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
        <IssueNotice issues={connectionIssues(connection, model.mode, index)} />
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
            // The header's notice names the problem; a collapsed row still shows which members have it.
            const missing = member.models[model.mode]?.inputRequirement?.status === "missing";
            const versions = member.sourceIds
              ? (["dev", "prod"] as const).flatMap(mode => member.models[mode] ? [{ mode, edge: member.models[mode]! }] : [])
              : [{ mode: undefined as Mode | undefined, edge }];
            return (
              <details
                key={member.sourceIds?.[0] ?? edge.id}
                className="border-rule not-first:border-t"
                data-slot="connection-map-member"
              >
                <InspectorSummary
                  className={`flex items-center gap-2 cursor-pointer text-caption list-none pb-3 [details:last-child:not([open])>&]:pb-0 [&>svg:first-child]:mr-0 ${position === 0 && connection.availability[model.mode] ? "pt-0" : "pt-3"}`}
                >
                  <span
                    className={cx(
                      "flex items-center gap-1.5 min-w-0 flex-1 wrap-anywhere",
                      missing && "text-refuse",
                    )}
                    data-slot="connection-map-label"
                  >
                    {missing ? <X size={14} aria-hidden className="flex-none" /> : null}
                    {shared ? relationship.value : relationship.title}
                    {missing ? <span className="sr-only">, required value missing</span> : null}
                  </span>
                  {rowPills ? (
                    <EnvironmentPills
                      availability={member.availability}
                      {...(member.sourceIds
                        ? { descriptions: { dev: "supplied in development", prod: "supplied in production" }, unavailableDescription: "not supplied in this environment" }
                        : {})}
                    />
                  ) : null}
                </InspectorSummary>
                <div className="pb-3 text-caption" data-slot="connection-map-detail">
                  {versions.map(version => (
                    <div key={version.mode ?? version.edge.id} data-slot="connection-source-environment">
                      {version.mode ? <h3 className="mt-3 mb-2 text-label font-semibold">{version.mode === "dev" ? "Development" : "Production"}</h3> : null}
                      <ConnectionEndpoints
                        compact
                        from={version.edge.from}
                        to={version.edge.to}
                        except={{ from: connection.from, to: connection.to }}
                      />
                      <ConnectionDetails compact edge={version.edge} onlyIn={version.mode ? undefined : onlyIn} contextMode={version.mode} />
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </>
  );
}
