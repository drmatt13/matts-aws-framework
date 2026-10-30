import type { LocalDatabase } from "../../../shared/database";
import type { ModelResource } from "../../../shared/model";
import { resourceIcon } from "../../icons";
import { inputGroupOf } from "../../input-groups";
import { inspectorRelationListClasses } from "../../inspector-ui";
import { displayName } from "../../naming";
import { buildScene } from "../../scene/build";
import { useStudio } from "../../studio";
import { buttonClasses } from "../../ui/Button";
import { ClientEnvironmentFileView } from "../ClientEnvironment";
import { Description } from "../Description";
import { DeploymentSection, DeploymentOwnership, ResourceDeployment, resourceAvailability } from "../Deployment";
import { EnvironmentFileView, InputSources } from "../DeploymentInputs";
import { EntityIcon } from "../EntityIcon";
import { EntityName } from "../EntityName";
import { InputGroupEntries, InputGroupSources, InputGroupTags, InputGroupUse } from "../InputGroup";
import { InspectorDisclosure, InspectorKind, InspectorSection, InspectorSummary } from "../InspectorUI";
import { ResourceEditor } from "../ResourceEditor";
import { FrameworkManagedStatus, ResourceStatus } from "../ResourceStatus";
import { SchemaLink } from "../SchemaDetails";
import { Tags } from "../Tags";
import { Triggers } from "../Triggers";
import { ResourceAccess } from "../WorkloadPermissions";
import { SourceLines, Written } from "../Written";
import { Relations } from "./InspectorRelations";

export function ResourceView(props: { readonly resource: ModelResource }) {
  const { snapshot, model, select, index } = useStudio();
  const { resource } = props;
  if (resource.clientEnvironment) return <ClientEnvironmentFileView key={resource.id} resource={resource} />;
  if (resource.deploymentFile) return <EnvironmentFileView key={resource.id} resource={resource} />;
  const members = model.resources.filter((item) => item.parent === resource.id);
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const kind =
    resource.frameworkStack ? "Framework stack" : resource.kind === "stack" ? "Stack in the catalog" : resource.kind === "member" ? "Stack member" : resource.kind === "secret" ? "Authored secret" : resource.kind === "input" ? resource.fromEnv ? "Environment parameter" : "Source parameter" : resource.kind === "group" ? "Input group" : "Construct";
  const group = resource.kind === "group";
  const availability = resourceAvailability(resource, snapshot.models);
  const entity = snapshot.source.entities[resource.id];
  // An entry inside a group names it, as a stack field names its stack.
  const owningGroup = resource.kind === "input" || resource.kind === "secret" ? inputGroupOf(resource, index.resources) : undefined;
  const database = [snapshot.models.dev, snapshot.models.prod].some((model) => model.edges.some((edge) => edge.relation === "database" && (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`))));
  const manual = snapshot.source.cdkLinks.manualWiring.filter((item) => item.resource === resource.id || item.resource.startsWith(`${resource.id}.`) || item.resource === resource.parent);
  return (
    <>
      <header>
        <InspectorKind environments={group ? undefined : resource.kind === "input" || resource.kind === "secret"
          ? { availability, label: "Declaration environments", descriptions: { dev: "declared in development", prod: "declared in production" }, unavailableDescription: "not declared" }
          : { availability, descriptions: { dev: "available in development", prod: "available in production" }, unavailableDescription: "unavailable" }}>{kind}</InspectorKind>
        <EntityName entity={resource.id} fallback={(resource.kind === "stack" ? resource.stackClass ?? resource.path.join(".") : resource.path.at(-1))!} icon={<EntityIcon icon={resourceIcon(resource)} />} />
        <ResourceStatus resource={resource} />
        {resource.kind !== "stack" || !resource.frameworkStack ? <code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">resources.{resource.path.join(".")}</code> : null}
        {resource.typeText ? <code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{resource.typeText}</code> : null}
        {owningGroup ? <p className={"text-caption text-graphite"}>In input group <button className={buttonClasses({ variant: "link" })} onClick={() => select(owningGroup.id)}>{displayName(model, owningGroup.id, owningGroup.path.join("."))}</button></p> : null}
        {/* A group is declared as an object in its module and composed into the catalog by name. */}
        {group && entity?.value && entity.value.file !== entity.key.file ? <SourceLines lines={[{ location: entity.value, label: "Declared in" }, { location: entity.key, label: "Cataloged in" }]} />
          : <Written location={entity?.key} label={resource.frameworkStack ? "Class in" : "Declared in"} />}
        {/* Ownership and source explanations follow the identity lines. */}
        {resource.frameworkStack || resource.stackUsage?.status === "unreferenced" || resource.frameworkManaged ? <details className={"mt-3 text-caption text-graphite [&>summary]:cursor-pointer [&[open]>summary]:mb-2"} data-slot="header-details"><InspectorSummary>About this resource</InspectorSummary>
        {resource.frameworkStack ? <p className={"text-caption text-graphite"}>No <code>resource.stack&lt;{resource.stackClass}&gt;()</code> entry in <code>framework-config/resources.ts</code>. Declare and link one if workloads should reference this stack's public fields.</p> : null}
        {resource.stackUsage?.status === "unreferenced" ? <p className={"text-caption text-graphite"}>Declared in the catalog, with no constructor reference in the CDK app's runtime imports. Add it to the app to include it in synthesis.</p> : null}
        {resource.frameworkManaged === "database" ? <p className={"text-caption text-graphite"}>Its database declaration owns PostgreSQL policy and placement; the framework supplies IAM-only workload connections.</p> : resource.frameworkManaged ? <p className={"text-caption text-graphite"}>The framework manages this stack and its generated environment outputs.</p> : null}
        </details> : null}
      </header>
      {group ? <InputGroupTags group={resource} /> : <Tags entity={resource.id} />}
      <Description entity={resource.id} />
      <ResourceDeployment resource={resource} />
      {members.some(member => member.id === model.managedDatabase?.resource) ? <InspectorSection title="Application database"><button className={buttonClasses({ variant: "neutral" })} onClick={() => select(model.managedDatabase!.resource)}>Configure application PostgreSQL</button><p className={"text-caption text-graphite"}>One database declaration coordinates production RDS and local PostgreSQL.</p></InspectorSection> : null}
      {resource.stackOutputs?.length ? <InspectorDisclosure title="CloudFormation outputs" count={resource.stackOutputs.length} defaultOpen={!!resource.frameworkStack} className={"[&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0 [&_li]:grid [&_li]:justify-items-start [&_li]:gap-1.75 [&_li]:border-b [&_li]:border-rule [&_li]:py-3.25"} data-slot="stack-outputs"><p className={"text-caption text-graphite"}>Symbolic source values mapped by the root .env exporter.</p><ul>{resource.stackOutputs.map((output) => <li key={output.name}>
        <span className={"text-caption font-semibold wrap-anywhere"} data-slot="stack-output-name">{output.name}</span>
        <code className={"inline-flex [gap:5px] max-w-full p-[5px_8px] [border:1px_solid_color-mix(in_srgb,_var(--dev)_30%,_transparent)] rounded-[5px] [background:color-mix(in_srgb,_var(--dev)_8%,_transparent)] text-dev [font:12px_var(--mono)] wrap-anywhere [&>span]:font-bold [&>span]:opacity-[0.7]"} data-slot="stack-output-value"><span>$</span>{output.symbol}</code>
        <span className={"text-caption text-graphite"}>Root .env · <code>{output.envName}</code></span>
      </li>)}</ul></InspectorDisclosure> : null}
      {database ? <section><SchemaLink /><p className={"text-caption text-graphite"}>The application contract is shared with local PostgreSQL.</p></section> : null}
      {resource.absent || (resource.kind === "member" && resource.memberSource === "class") || (facts?.stackClass && !resource.frameworkStack) || (facts?.stackLocation && !resource.frameworkStack) || links.length ? <InspectorDisclosure title="Declaration details">
        {resource.absent && resource.frameworkStack ? <p>Not enabled in the {model.mode === "dev" ? "development" : "production"} environment.</p> : resource.absent && group ? (
          <p>Every entry in this group is declared undefined in the {model.mode === "dev" ? "development" : "production"} graph, so nothing that reads them sees a value.</p>
        ) : resource.absent && resource.modes ? (
          <p>Declared <code>.only("{model.mode === "dev" ? "prod" : "dev"}")</code>, so the {model.mode === "dev" ? "development" : "production"} graph does not hold it. Anything that reads it there never sees a value.</p>
        ) : resource.absent ? (
          <p>
            Absent in the {model.mode === "dev" ? "development" : "production"} graph
            {facts?.condition ? <>, because the catalog writes it under <code>{facts.condition}</code></> : ""}. Anything that reads it never sees the value.
          </p>
        ) : null}
        {resource.kind === "member" && resource.memberSource === "class" ? <p className={"text-graphite"}>Declared by its stack; no workload references it.</p> : null}
        {facts?.stackClass && !resource.frameworkStack ? <p>The stack class {facts.stackClass} is the declaration: each public field is an entry.</p> : null}
        {(facts?.stackLocation && !resource.frameworkStack) || links.length ? <SourceLines lines={[
          ...(facts?.stackLocation && !resource.frameworkStack ? [{ location: facts.stackLocation, label: "Class in" }] : []),
          ...links.map((link) => ({ location: link, label: "Linked in" })),
        ]} /> : null}
      </InspectorDisclosure> : null}
      {group ? <><InputGroupEntries group={resource} /><InputGroupUse group={resource} /><InputGroupSources group={resource} /></> : null}
      {resource.kind === "stack" && members.length ? <InspectorDisclosure title="Public fields" count={members.length} defaultOpen className={"[&_[data-slot=relations]>li]:grid-cols-2 [&_[data-slot=relations]>li]:gap-x-3 [&_[data-slot=relations]>li]:gap-y-2 [&_li>code]:text-right inspector-360:[&_[data-slot=relations]>li]:grid-cols-1 inspector-360:[&_li>code]:text-left"} data-slot="stack-members"><ul className={inspectorRelationListClasses} data-slot="relations">{members.map((member) => <li key={member.id}><button className={buttonClasses({ variant: "link" })} onClick={() => select(member.id)}>{member.path.at(-1)}</button><code className={"text-caption text-graphite"} title={member.typeText ?? member.kind}>{member.typeText ?? member.kind}</code></li>)}</ul><p className={"text-caption text-graphite mt-2"} data-slot="section-footnote">Declared by the stack class.</p></InspectorDisclosure> : null}
      <ResourceAccess key={`access:${resource.id}`} resource={resource} />
      {resource.kind === "member" ? <Triggers key={resource.id} resource={resource} /> : null}
      {manual.length ? <section>{manual.map((item) => <div key={`${item.source.file}:${item.source.start}`}><p className={"text-caption text-graphite"}>{item.reason}</p><Written location={item.source} label="Wiring in" /></div>)}</section> : null}
      {resource.kind === "input" || resource.kind === "secret" ? <ResourceEditor key={`${resource.id}:${model.mode}`} resource={resource} /> : null}
      <InputSources resource={resource} />
      <Relations id={resource.id} />
    </>
  );
}

export function LocalDatabaseView({ database }: { readonly database: LocalDatabase }) {
  return <>
    <header><InspectorKind environments={{ availability: { dev: database.enabled, prod: false }, descriptions: { dev: "On your machine" }, unavailableDescription: "not enabled" }}>Local development service</InspectorKind><EntityName entity={database.id} fallback={database.title} icon={<EntityIcon icon="postgres" />} /><FrameworkManagedStatus /><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{database.service} · {database.image}</code><Written location={database.source} label="Declared in" /></header>
    <Description entity={database.id} />
    <DeploymentSection availability={{ dev: database.enabled, prod: false }} locations={{ dev: "On your machine" }}><DeploymentOwnership reason="Configured in Docker Compose; start and stop this service through Deploy & Run. Container health and running state are separate from source availability." /></DeploymentSection>
    <section><SchemaLink /><p className={"text-caption text-graphite"}>Shares the application contract with production RDS.</p></section>
    {database.volumes.length ? <section><h3>Persistent storage</h3>{database.volumes.map((volume) => <p key={volume}><code>{volume}</code></p>)}</section> : null}
    <Relations id={database.id} />
  </>;
}

export function NetworkFixtureView({ id }: { readonly id: string }) {
  const { model, snapshot } = useStudio();
  const fixture = buildScene(model).props.find((prop) => prop.id === id);
  if (!fixture) return null;
  const production = snapshot.models.prod;
  const inProduction = !!production.networks?.find(network => id.startsWith(`prop:vpc:${network.id}:`))?.builtInProd && buildScene(production).props.some((prop) => prop.id === id);
  return <>
    <header><InspectorKind environments={{ availability: { dev: false, prod: inProduction }, descriptions: { prod: "In AWS" }, unavailableDescription: "not built" }}>Network fixture</InspectorKind><EntityName entity={id} fallback={fixture.label} icon={<EntityIcon icon={fixture.icon} />} /><FrameworkManagedStatus /><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{id}</code><Written location={snapshot.source.entities[`island:vpc:${model.networks?.find(network => id.startsWith(`prop:vpc:${network.id}:`))?.id}`]?.value} label="Declared in" /></header>
    <Description entity={id} />
    <DeploymentSection availability={{ dev: false, prod: inProduction }} locations={{ prod: "In AWS" }}><DeploymentOwnership reason="This component is created by its production VPC. Configure the owning network instead of deploying the component independently." owners={(model.networks ?? []).filter(network => id.startsWith(`prop:vpc:${network.id}:`)).map(network => ({ id: `island:vpc:${network.id}`, title: network.name ?? network.id }))} /></DeploymentSection>
    <section>{fixture.caption.map((line) => <p key={line}>{line}</p>)}</section>
  </>;
}

