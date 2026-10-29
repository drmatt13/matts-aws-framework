import { InspectorKind, InspectorSummary } from "./InspectorUI";

import type { ConnectionGroup } from "../connections";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { ConnectionDetails, ConnectionEndpoints } from "./InputRequirement";
import { presentConnection, presentRelationship, suppliedByEnvironmentFile } from "../connection-presentation";

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
  return <>
    <header data-slot="connection-header"><InspectorKind environments={{ availability: connection.availability }}>Connection</InspectorKind><h2>{presentation.title}</h2>
      <ConnectionEndpoints from={connection.from} to={connection.to} />
    </header>
    <section aria-label="Connection details">
      {!connection.availability[model.mode] ? <div className={"[margin-top:14px] p-[10px_var(--space-3)] border border-rule [border-left:3px_solid_var(--faint)] rounded-md [background:rgba(141,159,183,.06)] text-caption [&>strong]:inline-block [&>strong]:text-graphite [&_p]:m-[6px_0] [&_ul]:m-[6px_0_0] [&_ul]:pl-4.5"} role="note" aria-label="Connection deployment status" data-slot="connection-availability"><strong>Disabled in {model.mode === "dev" ? "Development" : "Production"}</strong><p>Both endpoints must be enabled and a relationship must exist in this environment.</p></div> : null}
      <div data-slot="connection-map-members" className="[&>details+details]:border-t [&>details+details]:border-rule [&:first-child>details:first-child>summary]:pt-0">
        {members.map(({ member, edge, relationship }) => {
          const onlyIn = member.models[model.mode] ? undefined : member.models.dev ? "dev" : "prod";
          return <details key={edge.id} className={"[&:last-child:not([open])>summary]:pb-0 [&>summary>svg:first-child]:mr-0 [&>summary]:flex [&>summary]:gap-2 [&>summary]:items-center [&>summary]:cursor-pointer [&>summary]:text-caption [&>summary]:list-none [&>summary]:p-[var(--space-3)_0]"} data-slot="connection-map-member">
            <InspectorSummary>
              <span className={"grid [gap:2px] min-w-0 flex-1 [&_code]:wrap-anywhere [&_code]:text-caption"} data-slot="connection-map-label">{shared ? relationship.value : relationship.title}</span>
              {rowPills ? <EnvironmentPills availability={member.availability} /> : null}
            </InspectorSummary>
            <div className={"pb-3 text-caption [&>[data-slot=connection-endpoints]]:mt-0 [&>[data-slot=connection-endpoints]]:mb-2 [&_[data-slot=connection-description]]:mt-0 [&_[data-slot=connection-availability]]:mt-0"} data-slot="connection-map-detail">
              <ConnectionEndpoints from={edge.from} to={edge.to} except={{ from: connection.from, to: connection.to }} />
              <ConnectionDetails edge={edge} onlyIn={onlyIn} />
            </div>
          </details>;
        })}
      </div>
    </section>
  </>;
}
