import type { ConnectionGroup } from "../connections";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { ConnectionDetails, ConnectionEndpoints } from "./InputRequirement";
import { presentConnection, presentRelationship } from "../connection-presentation";

export function ConnectionMap({ connection }: { readonly connection: ConnectionGroup }) {
  const { model, index } = useStudio();
  const presentation = presentConnection(connection, model.mode, index);
  const members = connection.members.map((member) => {
    const edge = member.models[model.mode] ?? member.edge;
    return { member, edge, relationship: presentRelationship(edge, index) };
  });
  // The heading already names a shared purpose ("Reads: 2 environment values"); its rows name only what differs.
  const shared = new Set(members.map(({ relationship }) => relationship.action)).size === 1;
  return <>
    <header className="connection-header"><span className="kind">Connection</span><h2>{presentation.title}</h2><EnvironmentPills availability={connection.availability} />
      <ConnectionEndpoints from={connection.from} to={connection.to} />
    </header>
    <section aria-label="Connection details">
      {!connection.availability[model.mode] ? <div className="connection-availability" role="note" aria-label="Connection deployment status"><strong>Disabled in {model.mode === "dev" ? "Development" : "Production"}</strong><p>Both endpoints must be enabled and a relationship must exist in this environment.</p></div> : null}
      <div className="connection-map-members">
        {members.map(({ member, edge, relationship }) => {
          const onlyIn = member.models[model.mode] ? undefined : member.models.dev ? "dev" : "prod";
          return <details key={edge.id} className="connection-map-member">
            <summary>
              <span className="connection-map-label">{shared ? relationship.value : relationship.title}</span>
              <EnvironmentPills availability={member.availability} />
            </summary>
            <div className="connection-map-detail">
              <ConnectionEndpoints from={edge.from} to={edge.to} except={{ from: connection.from, to: connection.to }} />
              <ConnectionDetails edge={edge} onlyIn={onlyIn} />
            </div>
          </details>;
        })}
      </div>
    </section>
  </>;
}
