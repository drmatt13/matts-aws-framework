import type { ModelResource } from "../../shared/model";
import type { LocalDatabase } from "../../shared/database";
import { databaseConsumers } from "../../shared/managed-database";
import { useStudio } from "../studio";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";
import { EntityIcon } from "./EntityIcon";
import { Description } from "./Description";
import { Written } from "./Written";
import { SchemaLink } from "./SchemaDetails";
import { ManagedDatabaseControls } from "./ManagedDatabaseControls";
import { DatabasePlacement } from "./DatabasePlacement";
import { Tags } from "./Tags";

/** One application database, presented through its local and AWS implementations. */
export function ManagedDatabaseInspector({ resource, local }: { readonly resource?: ModelResource; readonly local?: LocalDatabase }) {
  const { snapshot, model, select, mode } = useStudio();
  const database = model.managedDatabase!;
  const postgres = local ?? snapshot.models.dev.localServices?.[0];
  const consumers = databaseConsumers(Object.values(snapshot.models), database.id);
  const rds = snapshot.models.prod.resources.find(item => item.id === database.resource);
  const owner = rds?.parent ?? snapshot.models.prod.resources.find(item => item.kind === "stack" && database.resource.startsWith(`${item.id}.`))?.id;
  const source = snapshot.source.entities[`database:${database.id}`]?.value;
  return <>
    <header><span className="kind">Framework-managed database</span><h2><EntityIcon icon={local ? "postgres" : "database"} />Application PostgreSQL</h2><code className="ref">{database.databaseName} · {database.id}</code><Written location={source} label="Declared in" /></header>
    <Tags entity={`database:${database.id}`} />
    <InspectorSection title="Environments" description="One application schema. Independent data in development and production.">
      <div className="database-environments">
        <div className={`database-environment dev${mode === "dev" ? " selected" : ""}`}><EntityIcon icon="postgres" /><span><strong>Development</strong><span>Local PostgreSQL</span><code>{postgres?.image ?? "Not configured"}</code></span><span className="small muted">Compose</span></div>
        <div className={`database-environment prod${mode === "prod" ? " selected" : ""}`}><EntityIcon icon="database" /><span><strong>Production</strong><span>Amazon RDS</span><span className="small muted">Private network · IAM authentication</span></span><span className="small muted">{rds && !rds.absent ? "Declared" : "Not declared"}</span></div>
      </div>
      <p className="small muted">Writer and reader calls share the local instance during development. Replicas and Proxy are production features; data is not synchronized between environments.</p>
      <SchemaLink />
    </InspectorSection>
    <DatabasePlacement />
    <Description entity={local?.id ?? resource?.id ?? database.resource} />
    <ManagedDatabaseControls />
    <InspectorDisclosure title="Connected workloads" count={consumers.length}>
      <p className="small muted">Declared database consumers, including workloads disabled in the selected environment. Access is granted only through their database declarations.</p>
      <ul className="database-consumers">{consumers.map(consumer => {
        const target = model.targets.find(item => item.ref === consumer.target) ?? snapshot.models.prod.targets.find(item => item.ref === consumer.target);
        return <li key={consumer.target}><button className="linkish" onClick={() => select(consumer.target)}><EntityIcon icon={target?.kind ?? "lambda"} /><span>{consumer.title}<code>{consumer.target}</code></span></button><span className="small muted">{consumer.connection === "direct" ? "Direct writer" : "Application writer"}{consumer.readers ? " + readers" : ""}<br />Pool: {consumer.maxConnections} / process</span></li>;
      })}</ul>
    </InspectorDisclosure>
    <InspectorDisclosure title="Local persistence">
      <p className="small muted">Configured by Docker Compose; local passwords and connection values stay outside the map.</p>
      {postgres ? <><Written location={postgres.source} label="Compose service" /><p className="small"><code>{postgres.service}</code> · <code>{postgres.image}</code></p>{postgres.volumes.map(volume => <p className="small" key={volume}><code>{volume}</code></p>)}</> : <p className="small muted">No local PostgreSQL service was discovered in Compose.</p>}
    </InspectorDisclosure>
    <InspectorDisclosure title="CDK ownership">
      <p className="small muted">The framework coordinates the IAM login, writer, optional Proxy and readers. Native CDK owns their construct identities and bootstrap lifecycle.</p>
      <code className="ref">{database.resource.replace(/^resource:/, "resources.")}</code>
      {owner ? <button className="quiet small" onClick={() => select(owner)}>Inspect database stack</button> : null}
      <Written location={snapshot.source.entities[database.resource]?.key} label="Native resource" />
    </InspectorDisclosure>
  </>;
}
