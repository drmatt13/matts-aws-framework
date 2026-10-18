import { ExternalLink, X } from "lucide-react";
import type { ModelEdge, ModelResource, ModelRoute, ModelTarget, ModelWorkflow, Placement, SourceLocation } from "../../shared/model";
import { editorLink, RELATION_LABEL, ROLE_LABEL, titleOf } from "../lookup";
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
import { EntityInfrastructure } from "./Infrastructure";
import { EnvironmentFileView, InputSources } from "./DeploymentInputs";
import { ConnectionView } from "./InputRequirement";

function Written(props: { readonly location: SourceLocation | undefined; readonly label?: string }) {
  const { snapshot } = useStudio();
  if (!props.location) return <p className="small muted">Its declaration could not be located in source.</p>;
  const { location } = props;
  return (
    <div className="written">
      <span>
        {props.label ?? "Written in"} <code>{location.file}:{location.line}</code>
      </span>
      <a href={editorLink(snapshot.repositoryRoot, location)} className="small">
        Open in VS Code <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}

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
      <code className="small">{edge.label}</code>
    </li>
  );
  return (
    <section>
      <h3>Relations</h3>
      {edges.some((edge) => edge.relation === "cdk" && edge.provenance === "source") ? <p className="small muted">CDK links are inferred from direct source references. Helpers and conditional wiring may add connections this view cannot resolve.</p> : null}
      <ul className="relations">
        {outgoing.map((edge) => row(edge, edge.to, RELATION_LABEL[edge.relation]))}
        {incoming.map((edge) => row(edge, edge.from, edge.relation === "cdk" ? "CDK link from" : edge.relation === "supplies" ? "Supplied by" : `${RELATION_LABEL[edge.relation]} from`))}
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
  const settings = facts.filter((fact) => !buildFields.has(fact.field) && fact.field !== "http.auth");
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
      <ApiAuthControl target={target} />
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
        <code className="ref">{route.origin}</code>
        <Written location={snapshot.source.entities[route.id]?.key} />
      </header>
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
  if (resource.deploymentFile) return <EnvironmentFileView key={resource.id} resource={resource} />;
  const members = model.resources.filter((item) => item.parent === resource.id);
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const kind =
    resource.kind === "stack" ? "Stack in the catalog" : resource.kind === "member" ? "Stack member" : resource.kind === "secret" ? "Authored secret" : resource.kind === "input" ? "Authored input" : resource.kind === "group" ? "Group of inputs" : "Construct";
  const database = [snapshot.models.dev, snapshot.models.prod].some((model) => model.edges.some((edge) => edge.relation === "database" && (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`))));
  return (
    <>
      <header>
        <span className="kind">{kind}</span>
        <h2><EntityIcon icon={resourceIcon(resource)} />{resource.kind === "stack" ? resource.stackClass ?? resource.path.join(".") : `resources.${resource.path.join(".")}`}</h2>
        {resource.typeText ? <code className="ref">{resource.typeText}</code> : null}
        {resource.kind === "member" && resource.parent ? <button className="linkish small" onClick={() => select(resource.parent)}>Back to {model.resources.find((item) => item.id === resource.parent)?.stackClass ?? "stack"}</button> : null}
        <Written location={snapshot.source.entities[resource.id]?.key} label={resource.kind === "member" ? "Declared on the stack in" : "Written in"} />
      </header>
      {database ? <section><SchemaLink /><p className="small muted">The application contract is shared with local PostgreSQL.</p></section> : null}
      <section>
        {resource.absent ? (
          <p>
            Absent in the {model.mode === "dev" ? "development" : "production"} graph
            {facts?.condition ? <>, because the catalog writes it under <code>{facts.condition}</code></> : ""}. Anything that reads it never sees the value.
          </p>
        ) : null}
        {resource.kind === "member" && resource.memberSource === "class" ? <p className="muted">Declared by its stack; no workload references it.</p> : null}
        {facts?.stackClass ? <p>The stack class {facts.stackClass} is the declaration: each public field is an entry.</p> : null}
        {facts?.stackLocation ? <Written location={facts.stackLocation} label="Class in" /> : null}
        {links.map((link) => (
          <Written key={`${link.file}:${link.line}`} location={link} label="Linked in" />
        ))}
      </section>
      {resource.kind === "stack" ? <section><details className="stack-members" open><summary>Public fields <span className="muted">({members.length})</span></summary><ul className="relations">{members.map((member) => <li key={member.id}><button className="linkish" onClick={() => select(member.id)}>{member.path.at(-1)}</button><code className="small muted">{member.typeText ?? member.kind}</code></li>)}</ul><p className="small muted">Read-only. Declared by the stack class.</p></details></section> : null}
      <InputSources resource={resource} />
      {resource.kind === "input" || resource.kind === "secret" ? <ResourceEditor key={`${resource.id}:${model.mode}`} resource={resource} /> : null}
      <Relations id={resource.id} />
    </>
  );
}

function LocalDatabaseView({ database }: { readonly database: LocalDatabase }) {
  return <>
    <header><span className="kind">Local development service</span><h2><EntityIcon icon="postgres" />{database.title}</h2><code className="ref">{database.service} · {database.image}</code><Written location={database.source} /></header>
    <section><h3>Where it runs</h3><div className="lane-lines"><div className="lane-line dev"><span>Development</span><strong>On your machine</strong></div><div className="lane-line prod off"><span>Production</span><strong>Not enabled</strong></div></div><p className="small muted">Declared by Compose. Container health and running state are not monitored.</p></section>
    <section><SchemaLink /><p className="small muted">Shares the application contract with production RDS.</p></section>
    {database.volumes.length ? <section><h3>Persistent storage</h3>{database.volumes.map((volume) => <p key={volume}><code>{volume}</code></p>)}</section> : null}
    <Relations id={database.id} />
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
  const schemaEntity = snapshot.schema.tables.some((table) => table.id === selected) || snapshot.schema.relations.some((relation) => relation.id === selected);
  const island = selected.startsWith("island:");
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
      {connection ? <ConnectionView edge={connection} /> : null}
      {localDatabase ? <LocalDatabaseView database={localDatabase} /> : null}
      {schemaEntity ? <SchemaDetails /> : null}
      {island ? <IslandInspector id={selected} key={selected} /> : null}
      {target || (resource && !resource.deploymentFile) || route || (island && selected !== "island:environment") ? <EntityInfrastructure id={route?.target ?? selected} /> : null}
      {!target && !route && !resource && !connection && !localDatabase && !schemaEntity && !island ? <p className="empty">{selected} is not in this graph.</p> : null}
      </div><DraftFooter />
    </aside>
  );
}
