import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Editability, FieldFact, ModelEdge, ModelResource, ModelRoute, ModelTarget, ModelWorkflow, Placement, SourceLocation } from "../../shared/model";
import { describeValue, editorLink, RELATION_LABEL, ROLE_LABEL, titleOf } from "../lookup";
import { useStudio } from "../studio";

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
  const line = (lane: "local" | "dev" | "prod", on: boolean, name: string) => (
    <div className={`lane-line ${lane} ${on ? "" : "off"}`}>
      <span>{name}</span>
      <br />
      <span className="small">{on ? "runs here" : "not here"}</span>
    </div>
  );
  return (
    <section>
      <h3>Where it runs</h3>
      <div className="lane-lines">
        {line("local", lanes.local, "Local")}
        {line("dev", lanes.dev, "Dev AWS")}
        {line("prod", lanes.prod, "Prod AWS")}
      </div>
      <p className="small">
        Deploy <code>{lanes.deploy}</code>
        {lanes.origin === "declared" ? ", declared on the entry." : lanes.origin === "default" ? ", the framework's default." : "."}
        {lanes.note ? ` ${lanes.note}` : ""}
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

function lockedReason(editability: Editability | undefined, fact: FieldFact): string | undefined {
  if (fact.blocked) return fact.blocked;
  if (!editability) return "The source index has no answer for this field.";
  switch (editability.kind) {
    case "literal":
    case "absent":
      return undefined;
    case "computed":
      return `Computed by ${editability.text}. Change it in your editor.`;
    case "spread":
      return `It may come from ${editability.text}. Change it in your editor.`;
    case "unsupported":
      return editability.reason;
  }
}

const INHERIT = "\u0000inherit";

function FieldRow(props: { readonly target: ModelTarget; readonly fact: FieldFact; readonly editability: Editability | undefined }) {
  const { preview, live, model } = useStudio();
  const { target, fact, editability } = props;
  const locked = model.stale ? "Editing is paused until the configuration loads again." : lockedReason(editability, fact);
  const current = fact.authored === undefined ? INHERIT : String(fact.authored);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const changed = draft !== current;
  const unit = fact.domain.kind === "number" ? ` ${fact.domain.unit}` : "";
  const inheritLabel = fact.inherited ? `Inherit (${fact.inherited.value}${unit} from ${fact.inherited.from})` : "Inherit";

  const submit = () => {
    if (draft === INHERIT) void preview({ target: target.ref, field: fact.field, inherit: true });
    else void preview({ target: target.ref, field: fact.field, value: fact.domain.kind === "number" ? Number(draft) : draft });
  };

  return (
    <div className="field">
      <span className="name">{fact.label}</span>
      <span className="control">
        {locked ? (
          <code>{String(fact.effective)}{unit}</code>
        ) : fact.domain.kind === "enum" ? (
          <select value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={fact.label}>
            {fact.domain.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
            <option value={INHERIT}>{inheritLabel}</option>
          </select>
        ) : (
          <>
            <input
              type="number"
              min={fact.domain.min}
              max={fact.domain.max}
              value={draft === INHERIT ? "" : draft}
              placeholder={fact.inherited ? String(fact.inherited.value) : ""}
              onChange={(event) => setDraft(event.target.value === "" ? INHERIT : event.target.value)}
              aria-label={`${fact.label} in ${fact.domain.unit}`}
            />
            <span className="muted small">{fact.domain.unit}</span>
          </>
        )}
        {changed && !locked ? (
          <button className="primary" onClick={submit} disabled={live.evaluating}>
            Preview change
          </button>
        ) : null}
      </span>
      {locked ? (
        <span className="locked">{locked}</span>
      ) : (
        <span className="note">
          {fact.authored === undefined
            ? `Not written here. Resolves to ${String(fact.effective)}${unit} from ${fact.provenance}.`
            : `Written as ${describeValue(fact.authored)}.`}
        </span>
      )}
    </div>
  );
}

function Relations(props: { readonly id: string }) {
  const { index, select } = useStudio();
  const edges = index.edges.get(props.id) ?? [];
  if (edges.length === 0) return null;
  const outgoing = edges.filter((edge) => edge.from === props.id);
  const incoming = edges.filter((edge) => edge.to === props.id && edge.from !== props.id);
  const row = (edge: ModelEdge, other: string, verb: string) => (
    <li key={`${edge.id}:${verb}`}>
      <span>
        <span className="muted small">{verb} </span>
        <button className="linkish" onClick={() => select(other)}>
          {titleOf(index, other)}
        </button>
        {edge.provenance === "derived" ? <span className="muted small"> (derived)</span> : null}
        {edge.detail ? (
          <>
            <br />
            <span className="small muted code">{edge.detail}</span>
          </>
        ) : null}
      </span>
      <code className="small">{edge.label}</code>
    </li>
  );
  return (
    <section>
      <h3>Relations</h3>
      <ul className="relations">
        {outgoing.map((edge) => row(edge, edge.to, RELATION_LABEL[edge.relation]))}
        {incoming.map((edge) => row(edge, edge.from, `${RELATION_LABEL[edge.relation]} from`))}
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
  return (
    <>
      <header>
        <span className="kind">{ROLE_LABEL[target.role]}</span>
        <h2>{target.title}</h2>
        <code className="ref">{target.ref}</code>
        <Written location={snapshot.source.entities[target.ref]?.key} />
        <p className="small muted" style={{ marginTop: 6 }}>
          Deployed as <code>{target.constructId}</code>
          {target.constructIdPinned ? ", pinned by cloud.constructId. Changing it would replace the deployed resource." : ", derived from its id."}
        </p>
      </header>
      <LaneLines target={target} />
      {facts.length > 0 ? (
        <section>
          <h3>Settings</h3>
          {facts.map((fact) => (
            <FieldRow key={fact.field} target={target} fact={fact} editability={editability[fact.field]} />
          ))}
        </section>
      ) : null}
      <section>
        <h3>Production placement</h3>
        <PlacementText placement={target.placement} />
        {compute.kind === "lambda" ? (
          <p className="small muted">
            {compute.packaging === "zip" ? compute.runtime : "Container image"}, {compute.architecture}, {compute.memorySize} MB, {compute.timeoutSeconds}s timeout.
          </p>
        ) : compute.kind === "container" ? (
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
        <h2>{route.browserPath ?? route.path}</h2>
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
      <Relations id={route.id} />
    </>
  );
}

function ResourceView(props: { readonly resource: ModelResource }) {
  const { snapshot, model } = useStudio();
  const { resource } = props;
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const kind =
    resource.kind === "stack" ? "Stack in the catalog" : resource.kind === "member" ? "Stack member" : resource.kind === "secret" ? "Authored secret" : resource.kind === "input" ? "Authored input" : resource.kind === "group" ? "Group of inputs" : "Construct";
  return (
    <>
      <header>
        <span className="kind">{kind}</span>
        <h2>resources.{resource.path.join(".")}</h2>
        {resource.typeText ? <code className="ref">{resource.typeText}</code> : null}
        <Written location={snapshot.source.entities[resource.id]?.key} label={resource.kind === "member" ? "Declared on the stack in" : "Written in"} />
      </header>
      <section>
        {resource.absent ? (
          <p>
            Absent in the {model.mode === "dev" ? "development" : "production"} graph
            {facts?.condition ? <>, because the catalog writes it under <code>{facts.condition}</code></> : ""}. Anything that reads it never sees the value.
          </p>
        ) : null}
        {resource.kind === "input" || resource.kind === "secret" ? (
          <p>
            Read from <code>{resource.fromEnv}</code> in cdk-app/.env
            {resource.default !== undefined ? <>, falling back to <code>{JSON.stringify(resource.default)}</code></> : ""}
            {resource.values ? <>, one of {resource.values.map((value) => <code key={value}>{value} </code>)}</> : ""}.
            {resource.kind === "secret" ? " Its value is uploaded to Secrets Manager and never appears here." : ""}
          </p>
        ) : null}
        {resource.kind === "member" && resource.memberSource === "class" ? <p className="muted">Public on the stack, and nothing reads it yet.</p> : null}
        {facts?.stackClass ? <p>The stack class {facts.stackClass} is the declaration: each public field is an entry.</p> : null}
        {facts?.stackLocation ? <Written location={facts.stackLocation} label="Class in" /> : null}
        {links.map((link) => (
          <Written key={`${link.file}:${link.line}`} location={link} label="Linked in" />
        ))}
      </section>
      <Relations id={resource.id} />
    </>
  );
}

export function Inspector() {
  const { index, selected, select } = useStudio();
  if (!selected) return null;
  const target = index.targets.get(selected);
  const route = index.routes.get(selected);
  const resource = index.resources.get(selected);
  return (
    <aside className="inspector" aria-label="Inspector">
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" }}>
        <button className="icon-button" onClick={() => select(undefined)} aria-label="Close the inspector">
          <X size={16} aria-hidden />
        </button>
      </div>
      {target ? <TargetView target={target} /> : null}
      {route ? <RouteView route={route} /> : null}
      {resource ? <ResourceView resource={resource} /> : null}
      {!target && !route && !resource ? <p className="empty">{selected} is not in this graph.</p> : null}
    </aside>
  );
}
