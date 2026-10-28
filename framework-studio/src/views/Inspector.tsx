import { GatewayView } from "./GatewayView";
import { drawnAs } from "../drawn-as";
import { PlacementControl } from "./NetworkControls";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelEdge, ModelResource, ModelRoute, ModelTarget, ModelWorkflow, Placement } from "../../shared/model";
import { ROLE_LABEL, endpointLabel, editorLink } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { resourceIcon, routeIcon, targetIcon } from "../icons";
import type { LocalDatabase } from "../../shared/database";
import { SchemaDetails, SchemaLink } from "./SchemaDetails";
import { ManagedDatabaseInspector } from "./ManagedDatabaseInspector";
import { ResourceEditor } from "./ResourceEditor";
import { HttpRoutes } from "./HttpRoutes";
import { IslandInspector } from "./IslandInspector";
import { BooleanField, FieldRow } from "./FieldRow";
import { DraftFooter } from "./DraftControls";
import { StackInfrastructure } from "./Infrastructure";
import { EnvironmentFileView, InputSources } from "./DeploymentInputs";
import { ClientEnvironmentFileView } from "./ClientEnvironment";
import { ConnectionView } from "./InputRequirement";
import { ResourceStatus } from "./ResourceStatus";
import { RouteStatus } from "./RouteStatus";
import { Description } from "./Description";
import { networkFixtureIds } from "../../shared/descriptions";
import { buildScene } from "../scene/build";
import { Written } from "./Written";
import { Triggers } from "./Triggers";
import { aggregateConnections, edgeAvailability } from "../connections";
import { ConnectionMap } from "./ConnectionMap";
import { EnvironmentPills } from "./DeploymentBadge";
import { InspectorDisclosure, InspectorSection } from "./InspectorUI";
import { DeploymentSection, DeploymentOwnership, ResourceDeployment, TargetDeployment } from "./Deployment";
import { Tags } from "./Tags";
import { ImplementationStatus, WorkloadRemoval } from "./WorkloadActions";
import { WorkloadPermissions, ResourceAccess } from "./WorkloadPermissions";
import { presentRelationship } from "../connection-presentation";
import { removalForConnection } from "../access";
import { inputGroupOf } from "../input-groups";
import { InputGroupEntries, InputGroupSources, InputGroupTags, InputGroupUse } from "./InputGroup";
import { catalogAvailability } from "../deployment";

function PlacementText(props: { readonly placement: Placement }) {
  const { placement } = props;
  if (placement.kind !== "vpc") return <p>{placement.reason}</p>;
  const out = [placement.egress.ipv4 ? "IPv4" : null, placement.egress.ipv6 ? "IPv6" : null].filter(Boolean);
  return (
    <>
      <p>
        VPC {placement.networkId}, {placement.subnet} subnet. {placement.reason}
      </p>
      <p className="small muted">
        {out.length > 0 ? `${out.join(" and ")} leave this subnet.` : "Nothing leaves this subnet except through the network's endpoints."}
        {placement.dualStack ? " It calls AWS's dual-stack endpoints." : ""}
      </p>
    </>
  );
}

function ApiAuthControl({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "http.auth");
  if (!fact) return null;
  return <section className="api-auth"><BooleanField target={target} fact={fact} editability={snapshot.source.editability[target.ref]?.[fact.field]} description="Uses the API's Cognito user pool to admit signed-in callers. Handler-side token checks still apply." /></section>;
}

function LocalReplayControl({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "events.localReplay");
  if (!fact) return null;
  return <section className="api-auth"><BooleanField target={target} fact={fact} editability={snapshot.source.editability[target.ref]?.[fact.field]} description="Captures AWS invocations in development through DevLambdaReplayStack and replays them against the local handler. Production runs the handler in AWS. Review Changes updates the config and handler wrapper together." /></section>;
}

function Relations(props: { readonly id: string }) {
  const { index, select, snapshot } = useStudio();
  // A stack's fields and a group's entries share their owner's building and connections.
  const owner = ["stack", "group"].includes(index.resources.get(props.id)?.kind ?? "");
  const owns = (id: string) => id === props.id || (owner && id.startsWith(`${props.id}.`));
  const edges = [...new Map([...index.edges.entries()].filter(([id]) => owns(id)).flatMap(([, edges]) => edges).map((edge) => [edge.id, edge])).values()];
  if (edges.length === 0) return null;
  const outgoing = edges.filter((edge) => owns(edge.from));
  const incoming = edges.filter((edge) => owns(edge.to) && !owns(edge.from));
  // The connection leads, as on the map; the other end is its supporting line.
  const row = (edge: ModelEdge, other: string, verb: string) => (
    <li key={`${edge.id}:${verb}`}>
      <button className="linkish relation-title" onClick={() => select(edge.id)}>{presentRelationship(edge, index).title}</button>
      <EnvironmentPills availability={edgeAvailability(edge, snapshot.models)} />
      <span className="relation-endpoint small">
        {verb}{" "}
        <button className="linkish" onClick={() => select(other)}>
          {endpointLabel(index, other)}
        </button>
        {edge.provenance === "derived" ? " (derived)" : null}
        {edge.provenance === "source" ? ` (${edge.relation === "supplies" ? "input file" : "CDK source"})` : null}
      </span>
    </li>
  );
  return (
    <InspectorDisclosure title="Connections" count={edges.length}>
      {edges.some((edge) => edge.relation === "cdk" && edge.provenance === "source") ? <p className="small muted">CDK links are inferred from direct source references. Helpers and conditional wiring may add connections this view cannot resolve.</p> : null}
      <ul className="relations connection-relations">
        {outgoing.map((edge) => row(edge, edge.to, "To"))}
        {incoming.map((edge) => row(edge, edge.from, "From"))}
      </ul>
    </InspectorDisclosure>
  );
}

interface StepNode {
  readonly kind: string;
  readonly id: string;
  readonly invokes?: string;
  readonly target?: string;
  readonly operation?: string;
  readonly completion?: string;
  readonly reference?: { readonly kind: string; readonly id: string };
  readonly steps?: readonly StepNode[];
  readonly branches?: readonly StepNode[];
  readonly names?: readonly string[];
  readonly rules?: readonly { readonly then: StepNode }[];
  readonly otherwise?: StepNode;
  readonly body?: StepNode;
  readonly handler?: StepNode;
  readonly maxConcurrency?: number;
  readonly policy?: { readonly retries: number };
  readonly error?: string;
}

function children(node: StepNode): readonly StepNode[] {
  return [
    ...(node.steps ?? []),
    ...(node.branches ?? []),
    ...(node.rules?.map((rule) => rule.then) ?? []),
    ...(node.otherwise ? [node.otherwise] : []),
    ...(node.body ? [node.body] : []),
    ...(node.handler ? [node.handler] : []),
  ];
}

function detail(node: StepNode): string {
  switch (node.kind) {
    case "invocation":
      return `${node.invokes}:${node.target}${node.completion === "callback" ? ", waits for a callback" : ""}`;
    case "integration":
      return `${node.reference?.kind}:${node.reference?.id} ${node.operation}`;
    case "map":
      return `up to ${node.maxConcurrency} at once`;
    case "parallel":
      return node.names ? node.names.join(", ") : `${node.branches?.length ?? 0} branches`;
    case "retry":
      return `${node.policy?.retries} retries`;
    case "fail":
      return node.error ?? "";
    default:
      return "";
  }
}

function Steps(props: { readonly workflow: ModelWorkflow }) {
  const rows: { depth: number; node: StepNode }[] = [];
  const visit = (node: StepNode, depth: number) => {
    rows.push({ depth, node });
    for (const child of children(node)) visit(child, depth + 1);
  };
  visit(props.workflow.root as StepNode, 0);
  return (
    <section>
      <h3>Steps</h3>
      <ul className="steps">
        {rows.map(({ depth, node }) => (
          <li key={node.id} style={{ paddingLeft: depth * 14 }}>
            <code>{props.workflow.names[node.id] ?? node.id}</code> <span className="step-kind">{detail(node)}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">State names are what the local runner's history and Step Functions call each step.</p>
    </section>
  );
}

function TargetView(props: { readonly target: ModelTarget }) {
  const { snapshot, model, select } = useStudio();
  const { target } = props;
  const facts = model.fields[target.ref] ?? [];
  const editability = snapshot.source.editability[target.ref] ?? {};
  const workflow = model.workflows.find((candidate) => candidate.ref === target.ref);
  const compute = target.compute;
  const buildFields = new Set(["lambda.architecture", "lambda.packaging", "lambda.runtime", "lambda.bundling.minify", "lambda.bundling.sourceMap"]);
  const settingOrder = ["lambda.memorySize", "lambda.timeoutSeconds", "lambda.logRetentionDays"];
  const settings = facts.filter((fact) => !buildFields.has(fact.field) && !fact.field.endsWith("subnet") && fact.field !== "deploy" && fact.field !== "http.auth" && fact.field !== "events.localReplay")
    .sort((a, b) => (settingOrder.indexOf(a.field) < 0 ? 99 : settingOrder.indexOf(a.field)) - (settingOrder.indexOf(b.field) < 0 ? 99 : settingOrder.indexOf(b.field)));
  return (
    <>
      <header>
        <span className="kind">{ROLE_LABEL[target.role]}</span>
        <h2><EntityIcon icon={targetIcon(target)} />{target.title}</h2>
        <code className="ref">{target.ref}</code>
        <Written location={snapshot.source.entities[target.ref]?.key} />
      </header>
      <Tags entity={target.ref} />
      <TargetDeployment target={target} />
      <Description entity={target.ref} />
      <ImplementationStatus target={target} />
      <WorkloadPermissions key={`permissions:${target.ref}`} target={target} />
      {settings.length > 0 ? <InspectorSection title="Settings">
        {settings.map((fact) => <FieldRow key={fact.field} target={target} fact={fact} editability={editability[fact.field]} />)}
      </InspectorSection> : null}
      <ApiAuthControl target={target} />
      <LocalReplayControl target={target} />
      {target.role === "event" ? <Triggers key={`triggers:${target.ref}`} target={target} /> : null}
      <HttpRoutes target={target} />
      {compute.kind === "lambda" ? <InspectorDisclosure title="Build and runtime">
        <dl className="lambda-build">
          <dt>Implementation</dt><dd>{compute.implementation === "container" ? "Container image" : compute.implementation === "python" ? "Python" : "TypeScript"}</dd>
          <dt>Source</dt><dd><code>{target.directory}</code></dd>
          <dt>Handler</dt><dd><code>{compute.packaging === "container" ? "Dockerfile CMD" : compute.handler}</code></dd>
          {compute.packaging === "container" ? <><dt>Runtime</dt><dd>Defined by the Dockerfile</dd></> : null}
        </dl>
        {facts.filter((fact) => buildFields.has(fact.field) && !fact.field.endsWith("subnet")).map((fact) => <FieldRow key={fact.field} target={target} fact={fact} editability={editability[fact.field]} />)}
      </InspectorDisclosure> : null}
      <InspectorDisclosure title="Production placement">
        <PlacementControl target={target} />
        <PlacementText placement={target.placement} />
        {compute.kind === "container" ? (
          <p className="small muted">
            {compute.cpu} CPU units, {compute.memoryMiB} MiB, {compute.architecture}
            {compute.port ? `, port ${compute.port}` : ""}.
          </p>
        ) : null}
      </InspectorDisclosure>
      {workflow ? <Steps workflow={workflow} /> : null}
      <Relations id={target.ref} />
      {target.environment.length + target.secrets.length > 0 ? <TargetEnvironment target={target} /> : null}
      <WorkloadRemoval target={target} />
    </>
  );
}

function EnvironmentBindingAction({ target, edge, name, grouped = false }: { readonly target: ModelTarget; readonly edge?: ModelEdge; readonly name: string; readonly grouped?: boolean }) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const remove = edge && removalForConnection(target, edge, model, snapshot.source);
  const pending = remove && draftState.entries.find(entry => entry.kind === "operation" && entry.operation.kind === "connection" && !entry.operation.enabled && entry.operation.target === target.ref && entry.operation.connection === remove.connection && entry.operation.destination === remove.destination && entry.operation.variable === remove.variable);
  const source = edge?.bindingSetting?.source ?? edge?.source ?? snapshot.source.entities[target.ref]?.value;
  const disabled = !!draftState.busy || draft.conflict || model.stale || live.evaluating;
  if (!remove) return source ? <a className="linkish small" href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a> : null;
  return <span className="access-actions">{pending ? <><span className="small muted">Removal staged</span><button className="linkish small" disabled={disabled} onClick={() => draft.discardOperation(pending.key)} aria-label={`Undo removal of ${name}`}>Undo removal</button></> : <button className="linkish small" disabled={disabled} onClick={() => draft.stageOperation(remove)} aria-label={grouped ? "Remove user-pool identifiers" : `Remove ${name} mapping`}>Remove{grouped ? " identifiers" : " mapping"}</button>}</span>;
}

function TargetEnvironment({ target }: { readonly target: ModelTarget }) {
  const { model, snapshot } = useStudio();
  const edges = model.edges.filter(edge => edge.from === target.ref);
  const pool = target.environment.filter(entry => entry.via === "userPool");
  const poolEdges = edges.filter(edge => edge.relation === "env" && pool.some(entry => entry.name === edge.label && entry.value.kind === "reference" && entry.value.resource === edge.to));
  const poolEdge = poolEdges.find(edge => removalForConnection(target, edge, model, snapshot.source)?.connection === "userPool") ?? poolEdges[0];
  return <InspectorDisclosure title="Environment" count={target.environment.length + target.secrets.length}>
    <div className="env">
      {pool.length ? <div className="env-row"><strong>User-pool identifiers</strong><div>{pool.map(entry => <div key={entry.name}><code>{entry.name}</code>{" · "}<code className="muted">{entry.value.kind === "reference" ? entry.value.display : JSON.stringify(entry.value.value)}</code></div>)}<EnvironmentBindingAction target={target} edge={poolEdge} name="User-pool identifiers" grouped /></div></div> : null}
      {target.environment.filter(entry => entry.via !== "userPool").map(entry => {
        const edge = edges.find(edge => edge.relation === "env" && edge.label === entry.name && entry.value.kind === "reference" && edge.to === entry.value.resource);
        return <EnvRow key={entry.name} name={entry.name} value={entry.value.kind === "literal" ? JSON.stringify(entry.value.value) : entry.value.display}
          action={entry.value.kind === "reference" ? <EnvironmentBindingAction target={target} edge={edge} name={entry.name} /> : undefined} />;
      })}
      {target.secrets.map(secret => <EnvRow key={secret.name} name={secret.name} value={`${secret.display}, at startup`}
        action={<EnvironmentBindingAction target={target} edge={edges.find(edge => edge.relation === "secret" && edge.label === secret.name && edge.to === secret.resource)} name={secret.name} />} />)}
    </div>
  </InspectorDisclosure>;
}

function EnvRow(props: { readonly name: string; readonly value: string; readonly action?: ReactNode }) {
  return (
    <div className="env-row">
      <code>{props.name}</code>
      <span>
        <code>{props.value}</code>
        {props.action}
      </span>
    </div>
  );
}

function RouteView(props: { readonly route: ModelRoute }) {
  const { snapshot, index, model, select } = useStudio();
  const { route } = props;
  const target = index.targets.get(route.target);
  return (
    <>
      <header>
        <span className="kind">{route.kind === "http" ? "HTTP route" : route.kind === "service" ? "Service mount" : route.kind === "webSocket" ? "WebSocket route key" : "Agent route"}</span>
        <h2><EntityIcon icon={routeIcon(route)} />{route.browserPath ?? route.path}</h2>
        <RouteStatus route={route} />
        <code className="ref">{route.origin}</code>
        <Written location={snapshot.source.entities[route.id]?.key} />
      </header>
      <Tags entity={target?.ref ?? route.id} route />
      {target ? <TargetDeployment target={target} route /> : null}
      <Description entity={route.id} />
      <section>
<p className="small muted">Served by <button className="linkish" onClick={() => select(drawnAs(model)[route.id])}>{route.kind === "agent" ? index.targets.get(route.target)?.id ?? route.target : route.kind === "webSocket" ? "WebSocket API" : "HTTP API"}</button>.</p>
        {route.methods ? <p>Answers {route.methods === "*" ? "every method" : route.methods.join(", ")}.</p> : null}
        <p className="muted small">
          {route.auth
            ? route.kind === "webSocket"
              ? "The $connect authorizer admits the connection."
              : "The gateway admits signed-in users only. The handler still checks the user itself if it needs one."
            : "Open to any caller."}
        </p>
        <p className="muted small">The public name is separate from the target, so renaming it does not rename what is deployed.</p>
      </section>
      {(route.kind === "http" || route.kind === "service") && target ? <ApiAuthControl target={target} /> : null}
      <Relations id={route.id} />
    </>
  );
}

function ResourceView(props: { readonly resource: ModelResource }) {
  const { snapshot, model, select, index } = useStudio();
  const { resource } = props;
  if (resource.clientEnvironment) return <ClientEnvironmentFileView key={resource.id} resource={resource} />;
  if (resource.deploymentFile) return <EnvironmentFileView key={resource.id} resource={resource} />;
  const members = model.resources.filter((item) => item.parent === resource.id);
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const kind =
    resource.frameworkStack ? "Framework stack" : resource.kind === "stack" ? "Stack in the catalog" : resource.kind === "member" ? "Stack member" : resource.kind === "secret" ? "Authored secret" : resource.kind === "input" ? "Authored input" : resource.kind === "group" ? "Input group" : "Construct";
  const group = resource.kind === "group";
  const entity = snapshot.source.entities[resource.id];
  // An entry inside a group names it, as a stack field names its stack.
  const owningGroup = resource.kind === "input" || resource.kind === "secret" ? inputGroupOf(resource, index.resources) : undefined;
  const database = [snapshot.models.dev, snapshot.models.prod].some((model) => model.edges.some((edge) => edge.relation === "database" && (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`))));
  const manual = snapshot.source.cdkLinks.manualWiring.filter((item) => item.resource === resource.id || item.resource.startsWith(`${resource.id}.`) || item.resource === resource.parent);
  return (
    <>
      <header>
        <span className="kind">{kind}</span>
        <h2><EntityIcon icon={resourceIcon(resource)} />{resource.kind === "stack" ? resource.stackClass ?? resource.path.join(".") : resource.path.at(-1)}</h2>
        <ResourceStatus resource={resource} />
        {resource.kind === "input" || resource.kind === "secret" ? <EnvironmentPills availability={catalogAvailability(snapshot.models)[resource.id] ?? { dev: false, prod: false }} label="Declaration environments" descriptions={{ dev: "declared in development", prod: "declared in production" }} unavailableDescription="not declared" /> : null}
        {resource.kind !== "stack" || !resource.frameworkStack ? <code className="ref">resources.{resource.path.join(".")}</code> : null}
        {resource.typeText ? <code className="ref">{resource.typeText}</code> : null}
        {owningGroup ? <p className="small muted">In input group <button className="linkish" onClick={() => select(owningGroup.id)}>{owningGroup.path.join(".")}</button></p> : null}
        {/* A group is declared as an object in its module and composed into the catalog by name. */}
        {group && entity?.value && entity.value.file !== entity.key.file ? <><Written location={entity.value} label="Declared in" /><Written location={entity.key} label="Added to the catalog in" /></>
          : <Written location={entity?.key} label={resource.frameworkStack ? "Class in" : resource.kind === "member" ? "Declared on the stack in" : "Written in"} />}
        {/* Ownership and source explanations follow the identity lines. */}
        {resource.frameworkStack || resource.stackUsage?.status === "unreferenced" || resource.frameworkManaged ? <details className="header-details"><summary>About this resource</summary>
        {resource.frameworkStack ? <p className="small muted">No <code>resource.stack&lt;{resource.stackClass}&gt;()</code> entry in <code>framework-config/resources.ts</code>. Declare and link one if workloads should reference this stack's public fields.</p> : null}
        {resource.stackUsage?.status === "unreferenced" ? <p className="small muted">Declared in the catalog, with no constructor reference in the CDK app's runtime imports. Add it to the app to include it in synthesis.</p> : null}
        {resource.frameworkManaged === "database" ? <p className="small muted">Its database declaration owns PostgreSQL policy and placement; the framework supplies IAM-only workload connections.</p> : resource.frameworkManaged ? <p className="small muted">The framework manages this stack and its generated environment outputs.</p> : null}
        </details> : null}
      </header>
      {group ? <InputGroupTags group={resource} /> : <Tags entity={resource.id} />}
      <ResourceDeployment resource={resource} />
      {members.some(member => member.id === model.managedDatabase?.resource) ? <InspectorSection title="Application database"><button className="button" onClick={() => select(model.managedDatabase!.resource)}>Configure application PostgreSQL</button><p className="small muted">One database declaration coordinates production RDS and local PostgreSQL.</p></InspectorSection> : null}
      <Description entity={resource.id} />
      {resource.stackOutputs?.length ? <InspectorDisclosure title="CloudFormation outputs" count={resource.stackOutputs.length} defaultOpen={!!resource.frameworkStack} className="stack-outputs"><p className="small muted">Symbolic source values mapped by the root .env exporter.</p><ul>{resource.stackOutputs.map((output) => <li key={output.name}>
        <span className="stack-output-name">{output.name}</span>
        <code className="stack-output-value"><span>$</span>{output.symbol}</code>
        <span className="small muted">Root .env · <code>{output.envName}</code></span>
      </li>)}</ul></InspectorDisclosure> : null}
      {database ? <section><SchemaLink /><p className="small muted">The application contract is shared with local PostgreSQL.</p></section> : null}
      {resource.absent || (resource.kind === "member" && resource.memberSource === "class") || (facts?.stackClass && !resource.frameworkStack) || (facts?.stackLocation && !resource.frameworkStack) || links.length ? <InspectorDisclosure title="Declaration details">
        {resource.absent && resource.frameworkStack ? <p>Not enabled in the {model.mode === "dev" ? "development" : "production"} environment.</p> : resource.absent && group ? (
          <p>Every entry in this group is declared undefined in the {model.mode === "dev" ? "development" : "production"} graph, so nothing that reads them sees a value.</p>
        ) : resource.absent ? (
          <p>
            Absent in the {model.mode === "dev" ? "development" : "production"} graph
            {facts?.condition ? <>, because the catalog writes it under <code>{facts.condition}</code></> : ""}. Anything that reads it never sees the value.
          </p>
        ) : null}
        {resource.kind === "member" && resource.memberSource === "class" ? <p className="muted">Declared by its stack; no workload references it.</p> : null}
        {facts?.stackClass && !resource.frameworkStack ? <p>The stack class {facts.stackClass} is the declaration: each public field is an entry.</p> : null}
        {facts?.stackLocation && !resource.frameworkStack ? <Written location={facts.stackLocation} label="Class in" /> : null}
        {links.map((link) => (
          <Written key={`${link.file}:${link.line}`} location={link} label="Linked in" />
        ))}
      </InspectorDisclosure> : null}
      {group ? <><InputGroupEntries group={resource} /><InputGroupUse group={resource} /><InputGroupSources group={resource} /></> : null}
      {resource.kind === "stack" && members.length ? <InspectorDisclosure title="Public fields" count={members.length} defaultOpen className="stack-members"><ul className="relations">{members.map((member) => <li key={member.id}><button className="linkish" onClick={() => select(member.id)}>{member.path.at(-1)}</button><code className="small muted" title={member.typeText ?? member.kind}>{member.typeText ?? member.kind}</code></li>)}</ul><p className="small muted section-footnote">Declared by the stack class.</p></InspectorDisclosure> : null}
      <ResourceAccess key={`access:${resource.id}`} resource={resource} />
      {resource.kind === "member" ? <Triggers key={resource.id} resource={resource} /> : null}
      {manual.length ? <section>{manual.map((item) => <div key={`${item.source.file}:${item.source.start}`}><p className="small muted">{item.reason}</p><Written location={item.source} label="Wiring in" /></div>)}</section> : null}
      {resource.kind === "input" || resource.kind === "secret" ? <ResourceEditor key={`${resource.id}:${model.mode}`} resource={resource} /> : null}
      <InputSources resource={resource} />
      <Relations id={resource.id} />
    </>
  );
}

function LocalDatabaseView({ database }: { readonly database: LocalDatabase }) {
  return <>
    <header><span className="kind">Local development service</span><h2><EntityIcon icon="postgres" />{database.title}</h2><code className="ref">{database.service} · {database.image}</code><Written location={database.source} /></header>
    <DeploymentSection availability={{ dev: database.enabled, prod: false }} locations={{ dev: "On your machine" }}><DeploymentOwnership reason="Configured in Docker Compose; start and stop this service through Deploy & Run. Container health and running state are separate from source availability." /></DeploymentSection>
    <Description entity={database.id} />
    <section><SchemaLink /><p className="small muted">Shares the application contract with production RDS.</p></section>
    {database.volumes.length ? <section><h3>Persistent storage</h3>{database.volumes.map((volume) => <p key={volume}><code>{volume}</code></p>)}</section> : null}
    <Relations id={database.id} />
  </>;
}

function NetworkFixtureView({ id }: { readonly id: string }) {
  const { model, snapshot } = useStudio();
  const fixture = buildScene(model).props.find((prop) => prop.id === id);
  if (!fixture) return null;
  const production = snapshot.models.prod;
  const inProduction = !!production.networks?.find(network => id.startsWith(`prop:vpc:${network.id}:`))?.builtInProd && buildScene(production).props.some((prop) => prop.id === id);
  return <>
    <header><span className="kind">Network fixture</span><h2><EntityIcon icon={fixture.icon} />{fixture.label}</h2><code className="ref">{id}</code><Written location={snapshot.source.entities[`island:vpc:${model.networks?.find(network => id.startsWith(`prop:vpc:${network.id}:`))?.id}`]?.value} /></header>
    <DeploymentSection availability={{ dev: false, prod: inProduction }} locations={{ prod: "In AWS" }}><DeploymentOwnership reason="This component is created by its production VPC. Configure the owning network instead of deploying the component independently." owners={(model.networks ?? []).filter(network => id.startsWith(`prop:vpc:${network.id}:`)).map(network => ({ id: `island:vpc:${network.id}`, title: network.name ?? network.id }))} /></DeploymentSection>
    <Description entity={id} />
    <section>{fixture.caption.map((line) => <p key={line}>{line}</p>)}</section>
  </>;
}

/** The right-hand inspector beside Database. Isometric hosts the same content in its workspace panel. */
export function Inspector() {
  const { selected, select } = useStudio();
  if (!selected) return null;
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-toolbar"><span>Inspector</span>
        <button className="icon-button" onClick={() => select(undefined)} aria-label="Close the inspector">
          <X size={16} aria-hidden />
        </button>
      </div>
      <InspectorContent selected={selected} />
    </aside>
  );
}

/** Every section, setting, action and source link for one selection, with its pending-change footer. */
export function InspectorContent({ selected }: { readonly selected: string }) {
  const { index, snapshot, model } = useStudio();
  const gateway = index.gateways.get(selected);
  const target = index.targets.get(selected);
  const route = index.routes.get(selected);
  const resource = index.resources.get(selected);
  const localDatabase = index.localServices.get(selected);
  const connection = model.edges.find((edge) => edge.id === selected);
  const groupedConnection = aggregateConnections(model, Object.values(snapshot.models)).find((group) => group.id === selected);
  // The map also draws the other environment's own connections, faintly marked; selecting one opens it here.
  const otherLens = connection ? undefined : ((["dev", "prod"] as const).filter((candidate) => candidate !== model.mode).map((candidate) => ({ mode: candidate, edge: snapshot.models[candidate].edges.find((edge) => edge.id === selected) })).find((entry) => entry.edge));
  const schemaEntity = snapshot.schema.tables.some((table) => table.id === selected) || snapshot.schema.relations.some((relation) => relation.id === selected);
  const island = selected.startsWith("island:");
  const fixture = (model.networks ?? []).flatMap(networkFixtureIds).includes(selected);
  return (
    <>
      <div className="inspector-content" key={selected}>
      {gateway ? <GatewayView gateway={gateway} /> : null}
      {target ? <TargetView target={target} /> : null}
      {route ? <RouteView route={route} /> : null}
      {resource ? resource.id === model.managedDatabase?.resource ? <ManagedDatabaseInspector resource={resource} /> : <ResourceView resource={resource} /> : null}
      {groupedConnection && groupedConnection.members.length > 1 ? <ConnectionMap connection={groupedConnection} /> : connection ? <ConnectionView edge={connection} availability={groupedConnection?.availability} /> : otherLens?.edge ? <ConnectionView edge={otherLens.edge} onlyIn={otherLens.mode} availability={groupedConnection?.availability} /> : null}
      {localDatabase ? model.managedDatabase ? <ManagedDatabaseInspector local={localDatabase} /> : <LocalDatabaseView database={localDatabase} /> : null}
      {schemaEntity ? <SchemaDetails /> : null}
      {island ? <IslandInspector id={selected} key={selected} /> : null}
      {fixture ? <NetworkFixtureView id={selected} /> : null}
      {resource?.kind === "stack" && !resource.frameworkStack ? <StackInfrastructure id={resource.id} /> : null}
      {!gateway && !target && !route && !resource && !connection && !groupedConnection && !otherLens && !localDatabase && !schemaEntity && !island && !fixture ? <p className="empty">{selected} is not in this graph.</p> : null}
      </div><DraftFooter />
    </>
  );
}
