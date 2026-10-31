import { inspectorHeaderClasses } from "../inspector-ui";
import {
  databaseCardClasses,
  databaseCardIdentityClasses,
  databaseCardTitleClasses,
  databaseCardReferenceClasses,
} from "./inspector/database-styles";
import { EntityName } from "./EntityName";
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
import { FrameworkManagedStatus } from "./ResourceStatus";

/** One application database, presented through its local and AWS implementations. */
export function ManagedDatabaseInspector({
  resource,
  local,
}: {
  readonly resource?: ModelResource;
  readonly local?: LocalDatabase;
}) {
  const { snapshot, model, select, mode } = useStudio();
  const database = model.managedDatabase!;
  const postgres = local ?? snapshot.models.dev.localServices?.[0];
  const consumers = databaseConsumers(Object.values(snapshot.models), database.id);
  const rds = snapshot.models.prod.resources.find((item) => item.id === database.resource);
  const owner =
    rds?.parent ??
    snapshot.models.prod.resources.find(
      (item) => item.kind === "stack" && database.resource.startsWith(`${item.id}.`),
    )?.id;
  const source = snapshot.source.entities[`database:${database.id}`]?.value;
  const availability = { dev: !!postgres?.enabled, prod: !!rds && !rds.absent };
  const locations = { dev: "On your machine", prod: "In AWS" };
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={{
            availability,
            descriptions: locations,
            unavailableDescription: "not enabled",
          }}
        >
          PostgreSQL database
        </InspectorKind>
        <EntityName
          entity={local?.id ?? resource?.id ?? database.resource}
          fallback="Application PostgreSQL"
          icon={<EntityIcon size={24} icon={local ? "postgres" : "database"} />}
        />
        <FrameworkManagedStatus />
        <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
          {database.databaseName} · {database.id}
        </code>
        <Written placement="header" location={source} label="Declared in" />
      </header>
      <Tags entity={`database:${database.id}`} />
      <Description entity={local?.id ?? resource?.id ?? database.resource} />
      <DeploymentSection availability={availability} locations={locations}>
        <DeploymentOwnership
          reason="The local database follows Compose; production RDS follows its owning stack. Consumer Deploy controls do not delete database storage."
          owners={owner ? [{ id: owner, title: "database stack" }] : []}
        />
      </DeploymentSection>
      <InspectorSection
        title="Environments"
        description="One application schema. Independent data in development and production."
      >
        <div className="grid gap-2" data-slot="database-environments">
          <div
            className={cx(
              databaseCardClasses,
              mode === "dev"
                ? "border-[color-mix(in_srgb,var(--dev)_65%,var(--rule-strong))]"
                : "border-rule-strong",
            )}
            data-slot="database-environment"
          >
            <EntityIcon icon="postgres" size={32} />
            <span className={databaseCardIdentityClasses}>
              <strong className={databaseCardTitleClasses}>Development</strong>
              <span>Local PostgreSQL</span>
              <code className={databaseCardReferenceClasses}>
                {postgres?.image ?? "Not configured"}
              </code>
            </span>
            <span className="flex-none text-caption text-graphite">Compose</span>
          </div>
          <div
            className={cx(
              databaseCardClasses,
              mode === "prod"
                ? "border-[color-mix(in_srgb,var(--prod)_65%,var(--rule-strong))]"
                : "border-rule-strong",
            )}
            data-slot="database-environment"
          >
            <EntityIcon icon="database" size={32} />
            <span className={databaseCardIdentityClasses}>
              <strong className={databaseCardTitleClasses}>Production</strong>
              <span>Amazon RDS</span>
              <span className="text-caption text-graphite">
                Private network · IAM authentication
              </span>
            </span>
            <span className="flex-none text-caption text-graphite">
              {rds && !rds.absent ? "Declared" : "Not declared"}
            </span>
          </div>
        </div>
        <p className="mb-2 mt-2 text-caption text-graphite">
          Writer and reader calls share the local instance during development. Replicas and Proxy
          are production features; data is not synchronized between environments.
        </p>
        <SchemaLink />
      </InspectorSection>
      <DatabasePlacement />
      <ManagedDatabaseControls />
      <InspectorDisclosure title="Connected workloads" count={consumers.length}>
        <p className="mt-0 mb-2 text-caption text-graphite">
          Declared database consumers, including workloads disabled in the selected environment.
          Access is granted only through their database declarations.
        </p>
        <ul className="m-0 list-none p-0" data-slot="database-consumers">
          {consumers.map((consumer) => {
            const target =
              model.targets.find((item) => item.ref === consumer.target) ??
              snapshot.models.prod.targets.find((item) => item.ref === consumer.target);
            return (
              <li
                className="flex items-start justify-between gap-3 border-t border-rule py-3 first:border-t-0 vp-420:flex-wrap inspector-420:flex-wrap"
                key={consumer.target}
              >
                <button
                  className={cx(
                    buttonClasses({ variant: "link" }),
                    "flex min-w-0 items-start gap-2 text-left",
                  )}
                  onClick={() => select(consumer.target)}
                >
                  <EntityIcon icon={target?.kind ?? "lambda"} size={22} />
                  <span className="grid min-w-0">
                    {consumer.title}
                    <code className="text-micro text-graphite wrap-anywhere">
                      {consumer.target}
                    </code>
                  </span>
                </button>
                <span className="flex-none text-right text-caption text-graphite vp-420:pl-7.5 vp-420:text-left inspector-420:pl-7.5 inspector-420:text-left">
                  {consumer.connection === "direct" ? "Direct writer" : "Application writer"}
                  {consumer.readers ? " + readers" : ""}
                  <br />
                  Pool: {consumer.maxConnections} / process
                </span>
              </li>
            );
          })}
        </ul>
      </InspectorDisclosure>
      <InspectorDisclosure title="Local persistence">
        <p className="mt-0 mb-2 text-caption text-graphite">
          Configured by Docker Compose; local passwords and connection values stay outside the map.
        </p>
        {postgres ? (
          <>
            <Written location={postgres.source} label="Compose service" />
            <p className="mt-0 mb-2 text-caption">
              <code>{postgres.service}</code> · <code>{postgres.image}</code>
            </p>
            {postgres.volumes.map((volume) => (
              <p className="mt-0 mb-2 text-caption" key={volume}>
                <code>{volume}</code>
              </p>
            ))}
          </>
        ) : (
          <p className="mt-0 mb-2 text-caption text-graphite">
            No local PostgreSQL service was discovered in Compose.
          </p>
        )}
      </InspectorDisclosure>
      <InspectorDisclosure title="CDK ownership">
        <p className="mt-0 mb-2 text-caption text-graphite">
          The framework coordinates the IAM login, writer, optional Proxy and readers. Native CDK
          owns their construct identities and bootstrap lifecycle.
        </p>
        <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
          {database.resource.replace(/^resource:/, "resources.")}
        </code>
        {owner ? (
          <button
            className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
            onClick={() => select(owner)}
          >
            Inspect database stack
          </button>
        ) : null}
        <Written
          location={snapshot.source.entities[database.resource]?.key}
          label="Native resource"
        />
      </InspectorDisclosure>
    </>
  );
}
