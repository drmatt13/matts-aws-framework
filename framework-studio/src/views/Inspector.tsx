import { X } from "lucide-react";
import type { ModelEdge, ModelResource, ModelRoute, ModelTarget, ModelWorkflow, Placement } from "../../shared/model";
import { RELATION_LABEL, ROLE_LABEL, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { resourceIcon, routeIcon, targetIcon } from "../icons";
import { developmentLocation, deploymentSummary, environments } from "../deployment";
import { Code2, Diamond } from "lucide-react";
import type { LocalDatabase } from "../../shared/database";
import { SchemaDetails, SchemaLink } from "./Database";
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

function LaneLines(props: { readonly target: ModelTarget }) {
  const { lanes } = props.target;
  const availability = environments(lanes);
  const line = (lane: "dev" | "prod", on: boolean, name: string, location: string) => (
    <div className={`lane-line ${lane} ${on ? "" : "off"}`}>
      <span className="environment-name">{lane === "dev" ? <Code2 size={14} aria-hidden /> : <Diamond size={14} aria-hidden />}{name}</span>
      <strong>{on ? "Enabled" : "Not enabled"}</strong>
      {on ? <span className="small muted">{location}</span> : null}
    </div>
  );
  return (
    <section>
      <h3>Where it runs</h3>
      <div className="lane-lines">
        {line("dev", availability.dev, "Development", developmentLocation(lanes))}
        {line("prod", availability.prod, "Production", "In AWS")}
      </div>
      <p className="small">
        {deploymentSummary(lanes)}
      </p>
    </section>
  );
}

function PlacementText(props: { readonly placement: Placement }) {
  const { placement } = props;
  if (placement.kind !== "vpc") return <p>{placement.reason}</p>;
  const out = [placement.egress.ipv4 ? "IPv4" : null, placement.egress.ipv6 ? "IPv6" : null].filter(Boolean);
  return (
    <>
      <p>
        The {placement.subnet} subnet. {placement.reason}
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
  return <section className="api-auth"><BooleanField target={target} fact={fact} editability={snapshot.source.editability[target.ref]?.[fact.field]} /><p className="small muted">Uses the API's Cognito user pool to admit signed-in callers. Handler-side token checks still apply.</p></section>;
}

function LocalReplayControl({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "events.localReplay");
  if (!fact) return null;
  return <section className="api-auth"><BooleanField target={target} fact={fact} editability={snapshot.source.editability[target.ref]?.[fact.field]} /><p className="small muted">Captures AWS invocations in development through DevLambdaReplayStack and replays them against the local handler. Production runs the handler in AWS. Review Changes updates the config and handler wrapper together.</p></section>;
}

function Relations(props: { readonly id: string }) {
  const { index, select } = useStudio();
  const stack = index.resources.get(props.id)?.kind === "stack";
  const owns = (id: string) => id === props.id || (stack && id.startsWith(`${props.id}.`));
  const edges = [...new Map([...index.edges.entries()].filter(([id]) => owns(id)).flatMap(([, edges]) => edges).map((edge) => [edge.id, edge])).values()];
  if (edges.length === 0) return null;
  const outgoing = edges.filter((edge) => owns(edge.from));
  const incoming = edges.filter((edge) => owns(edge.to) && !owns(edge.from));
  const row = (edge: ModelEdge, other: string, verb: string) => (
    <li key={`${edge.id}:${verb}`}>
      <span>
        <span className="muted small">{verb} </span>
        <button className="linkish" onClick={() => select(other)}>
          {titleOf(index, other)}
        </button>
        {edge.provenance === "derived" ? <span className="muted small"> (derived)</span> : null}
        {edge.provenance === "source" ? <span className="muted small"> ({edge.relation === "supplies" ? "input file" : "CDK source"})</span> : null}
        {edge.detail && !edge.source ? (
          <>
            <br />
            <span className="small muted code">{edge.detail}</span>
          </>
        ) : null}
        {edge.source ? <Written location={edge.source} label={edge.relation === "supplies" ? "Authored in" : "Inferred from"} /> : null}
      </span>
      <button className="linkish small code" onClick={() => select(edge.id)}>{edge.label}</button>
    </li>
  );
  return (
    <section>
      <h3>Relations</h3>
      {edges.some((edge) => edge.relation === "cdk" && edge.provenance === "source") ? <p className="small muted">CDK links are inferred from direct source references. Helpers and conditional wiring may add connections this view cannot resolve.</p> : null}
      <ul className="relations">
        {outgoing.map((edge) => row(edge, edge.to, RELATION_LABEL[edge.relation]))}
          {incoming.map((edge) => row(edge, edge.from, edge.relation === "contains" ? "Contained by" : edge.relation === "cdk" ? "CDK link from" : edge.relation === "supplies" ? "Supplied by" : `${RELATION_LABEL[edge.relation]} from`))}
      </ul>
    </section>
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
  const { snapshot, model } = useStudio();
  const { target } = props;
  const facts = model.fields[target.ref] ?? [];
  const editability = snapshot.source.editability[target.ref] ?? {};
  const workflow = model.workflows.find((candidate) => candidate.ref === target.ref);
  const compute = target.compute;
  const buildFields = new Set(["lambda.architecture", "lambda.packaging", "lambda.runtime", "lambda.bundling.minify", "lambda.bundling.sourceMap"]);
  const settings = facts.filter((fact) => !buildFields.has(fact.field) && fact.field !== "http.auth" && fact.field !== "events.localReplay");
  return (
    <>
      <header>
        <span className="kind">{ROLE_LABEL[target.role]}</span>
        <h2><EntityIcon icon={targetIcon(target)} />{target.title}</h2>
        <code className="ref">{target.ref}</code>
        <Written location={snapshot.source.entities[target.ref]?.key} />
        <p className="small muted" style={{ marginTop: 6 }}>
          Deployed as <code>{target.constructId}</code>
          {target.constructIdPinned ? ", pinned by cloud.constructId. Changing it would replace the deployed resource." : ", derived from its id."}
        </p>
      </header>
      <Description entity={target.ref} />
      <ApiAuthControl target={target} />
      <LocalReplayControl target={target} />
      {target.role === "event" ? <Triggers key={target.ref} target={target} /> : null}
      <HttpRoutes target={target} />
      <LaneLines target={target} />
      {compute.kind === "lambda" ? <section>
        <h3>Build and runtime</h3>
        <dl className="lambda-build">
          <dt>Implementation</dt><dd>{compute.implementation === "container" ? "Container image" : compute.implementation === "python" ? "Python" : "TypeScript"}</dd>
          <dt>Source</dt><dd><code>{target.directory}</code></dd>
          <dt>Handler</dt><dd><code>{compute.packaging === "container" ? "Dockerfile CMD" : compute.handler}</code></dd>
          {compute.packaging === "container" ? <><dt>Runtime</dt><dd>Defined by the Dockerfile</dd></> : null}
        </dl>
        {facts.filter((fact) => buildFields.has(fact.field)).map((fact) => <FieldRow key={fact.field} target={target} fact={fact} editability={editability[fact.field]} />)}
      </section> : null}
      {settings.length > 0 ? (
        <section>
          <h3>Settings</h3>
          {settings.map((fact) => (
            <FieldRow key={fact.field} target={target} fact={fact} editability={editability[fact.field]} />
          ))}
        </section>
      ) : null}
      <section>
        <h3>Production placement</h3>
        <PlacementText placement={target.placement} />
        {compute.kind === "container" ? (
          <p className="small muted">
            {compute.cpu} CPU units, {compute.memoryMiB} MiB, {compute.architecture}
            {compute.port ? `, port ${compute.port}` : ""}.
          </p>
        ) : null}
      </section>
      {workflow ? <Steps workflow={workflow} /> : null}
      <Relations id={target.ref} />
      {target.environment.length > 0 ? (
        <section>
          <h3>Environment</h3>
          <div className="env">
            {target.environment.map((entry) => (
              <EnvRow key={entry.name} name={entry.name} value={entry.value.kind === "literal" ? JSON.stringify(entry.value.value) : entry.value.display} via={entry.via} />
            ))}
            {target.secrets.map((secret) => (
              <EnvRow key={secret.name} name={secret.name} value={`${secret.display}, at startup`} />
            ))}
          </div>
        </section>
      ) : null}
      {target.access.length > 0 ? (
        <section>
          <h3>Explicit IAM</h3>
          {target.access.map((statement, position) => (
            <p key={position} className="small">
              <code>{statement.actions.join(", ")}</code>
              <br />
              <span className="muted code">{statement.resources.join(", ")}</span>
            </p>
          ))}
        </section>
      ) : null}
    </>
  );
}

function EnvRow(props: { readonly name: string; readonly value: string; readonly via?: string }) {
  return (
    <>
      <code>{props.name}</code>
      <span>
        <code>{props.value}</code>
        {props.via ? <span className="muted"> from userPool: true</span> : null}
      </span>
    </>
  );
}

function RouteView(props: { readonly route: ModelRoute }) {
  const { snapshot, index, select } = useStudio();
  const { route } = props;
  return (
    <>
      <header>
        <span className="kind">{route.kind === "http" ? "HTTP route" : route.kind === "service" ? "Service mount" : route.kind === "webSocket" ? "WebSocket route key" : "Agent route"}</span>
        <h2><EntityIcon icon={routeIcon(route)} />{route.browserPath ?? route.path}</h2>
        <RouteStatus route={route} />
        <code className="ref">{route.origin}</code>
        <Written location={snapshot.source.entities[route.id]?.key} />
      </header>
      <Description entity={route.id} />
      <section>
        <p>
          Reaches{" "}
          <button className="linkish" onClick={() => select(route.target)}>
            {titleOf(index, route.target)}
          </button>
          .{" "}
          {route.methods ? `Answers ${route.methods === "*" ? "every method" : route.methods.join(", ")}.` : ""}
        </p>
        <p className="muted small">
          {route.auth
            ? route.kind === "webSocket"
              ? "The $connect authorizer admits the connection."
              : "The gateway admits signed-in users only. The handler still checks the user itself if it needs one."
            : "Open to any caller."}
        </p>
        <p className="muted small">The public name is separate from the target, so renaming it does not rename what is deployed.</p>
      </section>
      {(route.kind === "http" || route.kind === "service") && index.targets.get(route.target) ? <ApiAuthControl target={index.targets.get(route.target)!} /> : null}
      <Relations id={route.id} />
    </>
  );
}

function ResourceView(props: { readonly resource: ModelResource }) {
  const { snapshot, model, select } = useStudio();
  const { resource } = props;
  if (resource.clientEnvironment) return <ClientEnvironmentFileView key={resource.id} resource={resource} />;
  if (resource.deploymentFile) return <EnvironmentFileView key={resource.id} resource={resource} />;
  const members = model.resources.filter((item) => item.parent === resource.id);
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const kind =
    resource.frameworkStack ? "Framework stack" : resource.kind === "stack" ? "Stack in the catalog" : resource.kind === "member" ? "Stack member" : resource.kind === "secret" ? "Authored secret" : resource.kind === "input" ? "Authored input" : resource.kind === "group" ? "Group of inputs" : "Construct";
  const database = [snapshot.models.dev, snapshot.models.prod].some((model) => model.edges.some((edge) => edge.relation === "database" && (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`))));
  const manual = snapshot.source.cdkLinks.manualWiring.filter((item) => item.resource === resource.id || item.resource.startsWith(`${resource.id}.`) || item.resource === resource.parent);
  return (
    <>
      <header>
        <span className="kind">{kind}</span>
        <h2><EntityIcon icon={resourceIcon(resource)} />{resource.kind === "stack" ? resource.stackClass ?? resource.path.join(".") : `resources.${resource.path.join(".")}`}</h2>
        <ResourceStatus resource={resource} />
        {resource.frameworkStack ? <p className="small muted">No <code>resource.stack&lt;{resource.stackClass}&gt;()</code> entry in <code>framework-config/resources.ts</code>. Declare and link one if workloads should reference this stack's public fields.</p> : null}
        {resource.stackUsage?.status === "unreferenced" ? <p className="small muted">Declared in the catalog, with no constructor reference in the CDK app's runtime imports. Add it to the app to include it in synthesis.</p> : null}
        {resource.frameworkManaged === "database" ? <p className="small muted">The framework owns this database and its connections. Dedicated database configuration options are coming later.</p> : resource.frameworkManaged ? <p className="small muted">The framework manages this stack and its generated environment outputs.</p> : null}
        {resource.typeText ? <code className="ref">{resource.typeText}</code> : null}
        {resource.kind === "member" && resource.parent ? <button className="linkish small" onClick={() => select(resource.parent)}>Back to {model.resources.find((item) => item.id === resource.parent)?.stackClass ?? "stack"}</button> : null}
        <Written location={snapshot.source.entities[resource.id]?.key} label={resource.frameworkStack ? "Class in" : resource.kind === "member" ? "Declared on the stack in" : "Written in"} />
      </header>
      <Description entity={resource.id} />
      {resource.stackOutputs?.length ? <section className="stack-outputs"><h3>CloudFormation outputs</h3><p className="small muted">Symbolic source values mapped by the root .env exporter.</p><ul>{resource.stackOutputs.map((output) => <li key={output.name}>
        <span className="stack-output-name">{output.name}</span>
        <code className="stack-output-value"><span>$</span>{output.symbol}</code>
        <span className="small muted">Root .env · <code>{output.envName}</code></span>
      </li>)}</ul></section> : null}
      {database ? <section><SchemaLink /><p className="small muted">The application contract is shared with local PostgreSQL.</p></section> : null}
      <section>
        {resource.absent && resource.frameworkStack ? <p>Not enabled in the {model.mode === "dev" ? "development" : "production"} environment.</p> : resource.absent ? (
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
      </section>
      {resource.kind === "stack" && members.length ? <section><details className="stack-members" open><summary>Public fields <span className="muted">({members.length})</span></summary><ul className="relations">{members.map((member) => <li key={member.id}><button className="linkish" onClick={() => select(member.id)}>{member.path.at(-1)}</button><code className="small muted">{member.typeText ?? member.kind}</code></li>)}</ul><p className="small muted">Read-only. Declared by the stack class.</p></details></section> : null}
      <InputSources resource={resource} />
      {resource.kind === "member" ? <Triggers key={resource.id} resource={resource} /> : null}
      {manual.length ? <section>{manual.map((item) => <div key={`${item.source.file}:${item.source.start}`}><p className="small muted">{item.reason}</p><Written location={item.source} label="Wiring in" /></div>)}</section> : null}
      {resource.kind === "input" || resource.kind === "secret" ? <ResourceEditor key={`${resource.id}:${model.mode}`} resource={resource} /> : null}
      <Relations id={resource.id} />
    </>
  );
}

function LocalDatabaseView({ database }: { readonly database: LocalDatabase }) {
  return <>
    <header><span className="kind">Local development service</span><h2><EntityIcon icon="postgres" />{database.title}</h2><code className="ref">{database.service} · {database.image}</code><Written location={database.source} /></header>
    <Description entity={database.id} />
    <section><h3>Where it runs</h3><div className="lane-lines"><div className="lane-line dev"><span>Development</span><strong>On your machine</strong></div><div className="lane-line prod off"><span>Production</span><strong>Not enabled</strong></div></div><p className="small muted">Declared by Compose. Container health and running state are not monitored.</p></section>
    <section><SchemaLink /><p className="small muted">Shares the application contract with production RDS.</p></section>
    {database.volumes.length ? <section><h3>Persistent storage</h3>{database.volumes.map((volume) => <p key={volume}><code>{volume}</code></p>)}</section> : null}
    <Relations id={database.id} />
  </>;
}

function NetworkFixtureView({ id }: { readonly id: string }) {
  const { model } = useStudio();
  const fixture = buildScene(model).props.find((prop) => prop.id === id);
  if (!fixture) return null;
  return <>
    <header><span className="kind">Network fixture</span><h2><EntityIcon icon={fixture.icon} />{fixture.label}</h2><code className="ref">{id}</code><Written location={{ file: "framework-config/network.ts", line: 1, column: 1, start: 0, end: 0 }} /></header>
    <Description entity={id} />
    <section>{fixture.caption.map((line) => <p key={line}>{line}</p>)}<p className="small muted">{model.mode === "prod" && model.network?.builtInProd ? "Built with the production VPC." : "Blueprint: this environment does not build the VPC."}</p></section>
  </>;
}

export function Inspector() {
  const { index, snapshot, selected, select, model } = useStudio();
  if (!selected) return null;
  const target = index.targets.get(selected);
  const route = index.routes.get(selected);
  const resource = index.resources.get(selected);
  const localDatabase = index.localServices.get(selected);
  const connection = model.edges.find((edge) => edge.id === selected);
  // The map also draws the other environment's own connections, faintly marked; selecting one opens it here.
  const otherLens = connection ? undefined : ((["dev", "prod"] as const).filter((candidate) => candidate !== model.mode).map((candidate) => ({ mode: candidate, edge: snapshot.models[candidate].edges.find((edge) => edge.id === selected) })).find((entry) => entry.edge));
  const schemaEntity = snapshot.schema.tables.some((table) => table.id === selected) || snapshot.schema.relations.some((relation) => relation.id === selected);
  const island = selected.startsWith("island:");
  const fixture = networkFixtureIds(model.network).includes(selected);
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-content"><div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" }}>
        <button className="icon-button" onClick={() => select(undefined)} aria-label="Close the inspector">
          <X size={16} aria-hidden />
        </button>
      </div>
      {target ? <TargetView target={target} /> : null}
      {route ? <RouteView route={route} /> : null}
      {resource ? <ResourceView resource={resource} /> : null}
      {connection ? <ConnectionView edge={connection} /> : otherLens?.edge ? <ConnectionView edge={otherLens.edge} onlyIn={otherLens.mode} /> : null}
      {localDatabase ? <LocalDatabaseView database={localDatabase} /> : null}
      {schemaEntity ? <SchemaDetails /> : null}
      {island ? <IslandInspector id={selected} key={selected} /> : null}
      {fixture ? <NetworkFixtureView id={selected} /> : null}
      {resource?.kind === "stack" && !resource.frameworkStack ? <StackInfrastructure id={resource.id} /> : null}
      {!target && !route && !resource && !connection && !otherLens && !localDatabase && !schemaEntity && !island && !fixture ? <p className="empty">{selected} is not in this graph.</p> : null}
      </div><DraftFooter />
    </aside>
  );
}
