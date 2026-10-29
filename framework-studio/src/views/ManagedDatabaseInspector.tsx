import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import type { ModelResource } from "../../shared/model";
import type { LocalDatabase } from "../../shared/database";
import { databaseConsumers } from "../../shared/managed-database";
import { useStudio } from "../studio";
import { InspectorDisclosure, InspectorKind, InspectorSection } from "./InspectorUI";
import { EntityIcon } from "./EntityIcon";
import { Description } from "./Description";
import { Written } from "./Written";
import { SchemaLink } from "./SchemaDetails";
import { ManagedDatabaseControls } from "./ManagedDatabaseControls";
import { DatabasePlacement } from "./DatabasePlacement";
import { Tags } from "./Tags";
import { DeploymentSection, DeploymentOwnership } from "./Deployment";

/** One application database, presented through its local and AWS implementations. */
export function ManagedDatabaseInspector({ resource, local }: { readonly resource?: ModelResource; readonly local?: LocalDatabase }) {
  const { snapshot, model, select, mode } = useStudio();
  const database = model.managedDatabase!;
  const postgres = local ?? snapshot.models.dev.localServices?.[0];
  const consumers = databaseConsumers(Object.values(snapshot.models), database.id);
  const rds = snapshot.models.prod.resources.find(item => item.id === database.resource);
  const owner = rds?.parent ?? snapshot.models.prod.resources.find(item => item.kind === "stack" && database.resource.startsWith(`${item.id}.`))?.id;
  const source = snapshot.source.entities[`database:${database.id}`]?.value;
  const availability = { dev: !!postgres?.enabled, prod: !!rds && !rds.absent };
  const locations = { dev: "On your machine", prod: "In AWS" };
  return <>
    <header><InspectorKind environments={{ availability, descriptions: locations, unavailableDescription: "not enabled" }}>Framework-managed database</InspectorKind><h2><EntityIcon icon={local ? "postgres" : "database"} />Application PostgreSQL</h2><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{database.databaseName} · {database.id}</code><Written location={source} label="Declared in" /></header>
    <Tags entity={`database:${database.id}`} />
    <Description entity={local?.id ?? resource?.id ?? database.resource} />
    <DeploymentSection availability={availability} locations={locations}><DeploymentOwnership reason="The local database follows Compose; production RDS follows its owning stack. Consumer Deploy controls do not delete database storage." owners={owner ? [{ id: owner, title: "database stack" }] : []} /></DeploymentSection>
    <InspectorSection title="Environments" description="One application schema. Independent data in development and production.">
      <div className={"grid gap-2"} data-slot="database-environments">
        <div className={cx("flex items-center gap-3 min-w-0 p-3 border border-rule-strong rounded-md bg-paper [&>[data-entity-icon]]:size-8 [&>[data-entity-icon]]:flex-none [&>span:first-of-type]:grid [&>span:first-of-type]:gap-0.5 [&>span:first-of-type]:flex-1 [&>span:first-of-type]:min-w-0 [&_strong]:text-label [&_strong]:font-semibold [&_strong]:wrap-anywhere [&_code]:text-graphite [&_code]:text-meta [&_code]:wrap-anywhere [&>span:last-child]:flex-none", mode === "dev" ? "[&]:border-[color-mix(in_srgb,var(--dev)_65%,var(--rule-strong))]" : "")} data-slot="database-environment"><EntityIcon icon="postgres" /><span><strong>Development</strong><span>Local PostgreSQL</span><code>{postgres?.image ?? "Not configured"}</code></span><span className={"text-caption text-graphite"}>Compose</span></div>
        <div className={cx("flex items-center gap-3 min-w-0 p-3 border border-rule-strong rounded-md bg-paper [&>[data-entity-icon]]:size-8 [&>[data-entity-icon]]:flex-none [&>span:first-of-type]:grid [&>span:first-of-type]:gap-0.5 [&>span:first-of-type]:flex-1 [&>span:first-of-type]:min-w-0 [&_strong]:text-label [&_strong]:font-semibold [&_strong]:wrap-anywhere [&_code]:text-graphite [&_code]:text-meta [&_code]:wrap-anywhere [&>span:last-child]:flex-none", mode === "prod" ? "[&]:border-[color-mix(in_srgb,var(--prod)_65%,var(--rule-strong))]" : "")} data-slot="database-environment"><EntityIcon icon="database" /><span><strong>Production</strong><span>Amazon RDS</span><span className={"text-caption text-graphite"}>Private network · IAM authentication</span></span><span className={"text-caption text-graphite"}>{rds && !rds.absent ? "Declared" : "Not declared"}</span></div>
      </div>
      <p className={"text-caption text-graphite"}>Writer and reader calls share the local instance during development. Replicas and Proxy are production features; data is not synchronized between environments.</p>
      <SchemaLink />
    </InspectorSection>
    <DatabasePlacement />
    <ManagedDatabaseControls />
    <InspectorDisclosure title="Connected workloads" count={consumers.length}>
      <p className={"text-caption text-graphite"}>Declared database consumers, including workloads disabled in the selected environment. Access is granted only through their database declarations.</p>
      <ul className={"list-none p-0 m-0 [&_li]:flex [&_li]:justify-between [&_li]:items-start [&_li]:gap-3 [&_li]:py-3 [&_li]:border-t [&_li]:border-rule [&_li:first-child]:[border-top:0] [&_code]:text-micro [&_code]:text-graphite [&_code]:wrap-anywhere [&_li>span]:text-right [&_li>span]:flex-none [&_button]:flex [&_button]:items-start [&_button]:gap-2 [&_button]:min-w-0 [&_button]:text-left [&_button>span]:grid [&_button>span]:min-w-0 [&_[data-entity-icon]]:size-5.5 [&_[data-entity-icon]]:flex-none vp-420:[&_li]:flex-wrap vp-420:[&_li>span]:text-left vp-420:[&_li>span]:pl-7.5 inspector-420:[&_li]:flex-wrap inspector-420:[&_li>span]:text-left inspector-420:[&_li>span]:pl-7.5"} data-slot="database-consumers">{consumers.map(consumer => {
        const target = model.targets.find(item => item.ref === consumer.target) ?? snapshot.models.prod.targets.find(item => item.ref === consumer.target);
        return <li key={consumer.target}><button className={buttonClasses({ variant: "link" })} onClick={() => select(consumer.target)}><EntityIcon icon={target?.kind ?? "lambda"} /><span>{consumer.title}<code>{consumer.target}</code></span></button><span className={"text-caption text-graphite"}>{consumer.connection === "direct" ? "Direct writer" : "Application writer"}{consumer.readers ? " + readers" : ""}<br />Pool: {consumer.maxConnections} / process</span></li>;
      })}</ul>
    </InspectorDisclosure>
    <InspectorDisclosure title="Local persistence">
      <p className={"text-caption text-graphite"}>Configured by Docker Compose; local passwords and connection values stay outside the map.</p>
      {postgres ? <><Written location={postgres.source} label="Compose service" /><p className={"text-caption"}><code>{postgres.service}</code> · <code>{postgres.image}</code></p>{postgres.volumes.map(volume => <p className={"text-caption"} key={volume}><code>{volume}</code></p>)}</> : <p className={"text-caption text-graphite"}>No local PostgreSQL service was discovered in Compose.</p>}
    </InspectorDisclosure>
    <InspectorDisclosure title="CDK ownership">
      <p className={"text-caption text-graphite"}>The framework coordinates the IAM login, writer, optional Proxy and readers. Native CDK owns their construct identities and bootstrap lifecycle.</p>
      <code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{database.resource.replace(/^resource:/, "resources.")}</code>
      {owner ? <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={() => select(owner)}>Inspect database stack</button> : null}
      <Written location={snapshot.source.entities[database.resource]?.key} label="Native resource" />
    </InspectorDisclosure>
  </>;
}
