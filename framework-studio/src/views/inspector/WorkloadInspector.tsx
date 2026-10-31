import {
  inspectorHeaderClasses,
  inspectorNoteClasses,
  inspectorSectionClasses,
} from "../../inspector-ui";

import type { ReactNode } from "react";
import type {
  ModelEdge,
  ModelRoute,
  ModelTarget,
  ModelWorkflow,
  Placement,
} from "../../../shared/model";
import { removalForConnection } from "../../access";
import { drawnAs } from "../../drawn-as";
import { sourceEditBlocked } from "../../editing-state";
import { routeIcon, targetIcon } from "../../icons";
import { ROLE_LABEL, editorLink } from "../../lookup";
import { useStudio } from "../../studio";
import { buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { Description } from "../Description";
import { TargetDeployment, TargetKind } from "../Deployment";
import { EntityIcon } from "../EntityIcon";
import { EntityName } from "../EntityName";
import { BooleanField, FieldRow } from "../FieldRow";
import { HttpRoutes } from "../HttpRoutes";
import { DottedName, InspectorDisclosure, InspectorKind, InspectorSection } from "../InspectorUI";
import { PlacementControl, placementEditable } from "../NetworkControls";
import { RouteStatus } from "../RouteStatus";
import { Tags } from "../Tags";
import { Triggers } from "../Triggers";
import { ImplementationStatus, WorkloadRemoval } from "../WorkloadActions";
import { WorkloadPermissions } from "../WorkloadPermissions";
import { Written } from "../Written";
import { Relations } from "./InspectorRelations";

/**
 * What a placement means for egress. Beside its own selects the VPC and subnet are already in
 * view, so they are restated only for a read-only placement or, as the saved placement, while a
 * different one is staged.
 */
function PlacementNotes({
  placement,
  restate,
}: {
  readonly placement: Placement;
  readonly restate: "never" | "plain" | "saved";
}) {
  const prefix = restate === "saved" ? "Saved placement: " : "";
  if (placement.kind !== "vpc")
    return (
      <p className={inspectorNoteClasses}>
        {prefix}
        {placement.reason}
      </p>
    );
  const out = [placement.egress.ipv4 ? "IPv4" : null, placement.egress.ipv6 ? "IPv6" : null].filter(
    Boolean,
  );
  return (
    <>
      <p className={inspectorNoteClasses}>
        {restate === "never"
          ? placement.reason
          : `${prefix}VPC ${placement.networkId}, ${placement.subnet} subnet. ${placement.reason}`}
      </p>
      <p className={inspectorNoteClasses}>
        {out.length > 0
          ? `${out.join(" and ")} leave this subnet.`
          : "Nothing leaves this subnet except through the network's endpoints."}
        {placement.dualStack ? " It calls AWS's dual-stack endpoints." : ""}
      </p>
    </>
  );
}

function ProductionPlacement({ target }: { readonly target: ModelTarget }) {
  const { draft } = useStudio();
  const compute = target.compute;
  return (
    <InspectorDisclosure title="Production placement">
      {placementEditable(target) ? (
        <PlacementControl
          target={target}
          help={
            <PlacementNotes
              placement={target.placement}
              restate={draft.placement(target.ref) ? "saved" : "never"}
            />
          }
        />
      ) : (
        <div className="grid gap-1">
          <PlacementNotes placement={target.placement} restate="plain" />
        </div>
      )}
      {compute.kind === "container" ? (
        <p className={cx(inspectorNoteClasses, "mt-3")}>
          {compute.cpu} CPU units, {compute.memoryMiB} MiB, {compute.architecture}
          {compute.port ? `, port ${compute.port}` : ""}.
        </p>
      ) : null}
    </InspectorDisclosure>
  );
}

function ApiAuthControl({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "http.auth");
  if (!fact) return null;
  return (
    <section className={inspectorSectionClasses} data-slot="api-auth">
      <BooleanField
        flush
        target={target}
        fact={fact}
        editability={snapshot.source.editability[target.ref]?.[fact.field]}
        description="Uses the API's Cognito user pool to admit signed-in callers. Handler-side token checks still apply."
      />
    </section>
  );
}

function LocalReplayControl({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "events.localReplay");
  if (!fact) return null;
  return (
    <section className={inspectorSectionClasses} data-slot="api-auth">
      <BooleanField
        flush
        target={target}
        fact={fact}
        editability={snapshot.source.editability[target.ref]?.[fact.field]}
        description="Captures AWS invocations in development through DevLambdaReplayStack and replays them against the local handler. Production runs the handler in AWS. Review Changes updates the config and handler wrapper together."
      />
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
    <section className={inspectorSectionClasses}>
      <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Steps</h3>
      <ul className="list-none m-0 p-0 text-caption" data-slot="steps">
        {rows.map(({ depth, node }) => (
          <li className="py-0.5 px-0" key={node.id} style={{ paddingLeft: depth * 14 }}>
            <code>{props.workflow.names[node.id] ?? node.id}</code>{" "}
            <span className="text-graphite" data-slot="step-kind">
              {detail(node)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-0 mb-2 text-caption text-graphite">
        State names are what the local runner's history and Step Functions call each step.
      </p>
    </section>
  );
}

export function TargetView(props: { readonly target: ModelTarget }) {
  const { snapshot, model, select } = useStudio();
  const { target } = props;
  const facts = model.fields[target.ref] ?? [];
  const editability = snapshot.source.editability[target.ref] ?? {};
  const workflow = model.workflows.find((candidate) => candidate.ref === target.ref);
  const compute = target.compute;
  const buildFields = new Set([
    "lambda.architecture",
    "lambda.packaging",
    "lambda.runtime",
    "lambda.bundling.minify",
    "lambda.bundling.sourceMap",
  ]);
  const settingOrder = ["lambda.memorySize", "lambda.timeoutSeconds", "lambda.logRetentionDays"];
  const settings = facts
    .filter(
      (fact) =>
        !buildFields.has(fact.field) &&
        !fact.field.endsWith("subnet") &&
        fact.field !== "deploy" &&
        fact.field !== "http.auth" &&
        fact.field !== "events.localReplay",
    )
    .sort(
      (a, b) =>
        (settingOrder.indexOf(a.field) < 0 ? 99 : settingOrder.indexOf(a.field)) -
        (settingOrder.indexOf(b.field) < 0 ? 99 : settingOrder.indexOf(b.field)),
    );
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <TargetKind target={target}>{ROLE_LABEL[target.role]}</TargetKind>
        <EntityName
          entity={target.ref}
          fallback={target.title}
          icon={<EntityIcon size={24} icon={targetIcon(target)} />}
        />
        <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
          {target.ref}
        </code>
        <Written
          placement="header"
          location={snapshot.source.entities[target.ref]?.key}
          label="Declared in"
        />
      </header>
      <Tags entity={target.ref} />
      <Description entity={target.ref} />
      <TargetDeployment target={target} />
      <ImplementationStatus target={target} />
      <WorkloadPermissions key={`permissions:${target.ref}`} target={target} />
      {settings.length > 0 ? (
        <InspectorSection title="Settings">
          {settings.map((fact) => (
            <FieldRow
              key={fact.field}
              target={target}
              fact={fact}
              editability={editability[fact.field]}
            />
          ))}
        </InspectorSection>
      ) : null}
      <ApiAuthControl target={target} />
      <LocalReplayControl target={target} />
      {target.role === "event" ? <Triggers key={`triggers:${target.ref}`} target={target} /> : null}
      <HttpRoutes target={target} />
      {compute.kind === "lambda" ? (
        <InspectorDisclosure title="Build and runtime">
          <dl
            className="mt-0 mb-4 grid grid-cols-[var(--field-label-width)_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption inspector-420:grid-cols-1 inspector-420:gap-y-0"
            data-slot="lambda-build"
          >
            <dt className="text-graphite">Implementation</dt>
            <dd className={buildValueClasses}>
              {compute.implementation === "container"
                ? "Container image"
                : compute.implementation === "python"
                  ? "Python"
                  : "TypeScript"}
            </dd>
            <dt className="text-graphite">Source</dt>
            <dd className={buildValueClasses}>
              <code>{target.directory}</code>
            </dd>
            <dt className="text-graphite">Handler</dt>
            <dd className={buildValueClasses}>
              <code>{compute.packaging === "container" ? "Dockerfile CMD" : compute.handler}</code>
            </dd>
            {compute.packaging === "container" ? (
              <>
                <dt className="text-graphite">Runtime</dt>
                <dd className={buildValueClasses}>Defined by the Dockerfile</dd>
              </>
            ) : null}
          </dl>
          {facts
            .filter((fact) => buildFields.has(fact.field) && !fact.field.endsWith("subnet"))
            .map((fact) => (
              <FieldRow
                key={fact.field}
                target={target}
                fact={fact}
                editability={editability[fact.field]}
              />
            ))}
        </InspectorDisclosure>
      ) : null}
      <ProductionPlacement target={target} />
      {workflow ? <Steps workflow={workflow} /> : null}
      <Relations id={target.ref} />
      {target.environment.length + target.secrets.length > 0 ? (
        <TargetEnvironment target={target} />
      ) : null}
      <WorkloadRemoval target={target} />
    </>
  );
}

function EnvironmentBindingAction({
  target,
  edge,
  name,
  grouped = false,
}: {
  readonly target: ModelTarget;
  readonly edge?: ModelEdge;
  readonly name: string;
  readonly grouped?: boolean;
}) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const remove = edge && removalForConnection(target, edge, model, snapshot.source);
  const pending =
    remove &&
    draftState.entries.find(
      (entry) =>
        entry.kind === "operation" &&
        entry.operation.kind === "connection" &&
        !entry.operation.enabled &&
        entry.operation.target === target.ref &&
        entry.operation.connection === remove.connection &&
        entry.operation.destination === remove.destination &&
        entry.operation.variable === remove.variable,
    );
  const source =
    edge?.bindingSetting?.source ?? edge?.source ?? snapshot.source.entities[target.ref]?.value;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  if (!remove)
    return source ? (
      <a
        className={cx(buttonClasses({ variant: "link" }), "text-caption")}
        href={editorLink(snapshot.repositoryRoot, source)}
      >
        Open declaration
      </a>
    ) : null;
  return (
    <span className="flex flex-wrap items-center gap-3" data-slot="access-actions">
      {pending ? (
        <>
          <span className="text-caption text-graphite">Removal staged</span>
          <button
            className={cx(buttonClasses({ variant: "link" }), "text-caption")}
            disabled={disabled}
            onClick={() => draft.discardOperation(pending.key)}
            aria-label={`Undo removal of ${name}`}
          >
            Undo removal
          </button>
        </>
      ) : (
        <button
          className={cx(buttonClasses({ variant: "link" }), "text-caption")}
          disabled={disabled}
          onClick={() => draft.stageOperation(remove)}
          aria-label={grouped ? "Remove user-pool identifiers" : `Remove ${name} mapping`}
        >
          Remove{grouped ? " identifiers" : " mapping"}
        </button>
      )}
    </span>
  );
}

function TargetEnvironment({ target }: { readonly target: ModelTarget }) {
  const { model, snapshot } = useStudio();
  const edges = model.edges.filter((edge) => edge.from === target.ref);
  const pool = target.environment.filter((entry) => entry.via === "userPool");
  const poolEdges = edges.filter(
    (edge) =>
      edge.relation === "env" &&
      pool.some(
        (entry) =>
          entry.name === edge.label &&
          entry.value.kind === "reference" &&
          entry.value.resource === edge.to,
      ),
  );
  const poolEdge =
    poolEdges.find(
      (edge) =>
        removalForConnection(target, edge, model, snapshot.source)?.connection === "userPool",
    ) ?? poolEdges[0];
  return (
    <InspectorDisclosure
      title="Environment"
      count={target.environment.length + target.secrets.length}
    >
      <div className="text-caption grid grid-cols-[minmax(0,1fr)] gap-0" data-slot="env">
        {pool.length ? (
          <div className={envRowClasses} data-slot="env-row">
            <strong className="font-medium">User-pool identifiers</strong>
            {pool.map((entry) => (
              <div key={entry.name} className="grid min-w-0 gap-0.5">
                <code className="wrap-anywhere">{entry.name}</code>
                <code className="text-graphite wrap-anywhere">
                  <DottedName>
                    {entry.value.kind === "reference"
                      ? entry.value.display
                      : JSON.stringify(entry.value.value)}
                  </DottedName>
                </code>
              </div>
            ))}
            <EnvironmentBindingAction
              target={target}
              edge={poolEdge}
              name="User-pool identifiers"
              grouped
            />
          </div>
        ) : null}
        {target.environment
          .filter((entry) => entry.via !== "userPool")
          .map((entry) => {
            const edge = edges.find(
              (edge) =>
                edge.relation === "env" &&
                edge.label === entry.name &&
                entry.value.kind === "reference" &&
                edge.to === entry.value.resource,
            );
            return (
              <EnvRow
                key={entry.name}
                name={entry.name}
                value={
                  entry.value.kind === "literal"
                    ? JSON.stringify(entry.value.value)
                    : entry.value.display
                }
                action={
                  entry.value.kind === "reference" ? (
                    <EnvironmentBindingAction target={target} edge={edge} name={entry.name} />
                  ) : undefined
                }
              />
            );
          })}
        {target.secrets.map((secret) => (
          <EnvRow
            key={secret.name}
            name={secret.name}
            value={`${secret.display}, at startup`}
            action={
              <EnvironmentBindingAction
                target={target}
                edge={edges.find(
                  (edge) =>
                    edge.relation === "secret" &&
                    edge.label === secret.name &&
                    edge.to === secret.resource,
                )}
                name={secret.name}
              />
            }
          />
        ))}
      </div>
    </InspectorDisclosure>
  );
}

/** Stacked in a narrow panel, each value stays with its label and pairs separate by 8 px. */
const buildValueClasses = "m-0 wrap-anywhere inspector-420:mb-2 inspector-420:last:mb-0";

const envRowClasses =
  "grid min-w-0 justify-items-start gap-1 border-b border-rule py-2.5 first:pt-0 last:border-b-0 last:pb-0";

function EnvRow(props: {
  readonly name: string;
  readonly value: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className={envRowClasses} data-slot="env-row">
      <code className="font-medium wrap-anywhere">{props.name}</code>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-graphite">
        <code className="min-w-0 wrap-anywhere">
          <DottedName>{props.value}</DottedName>
        </code>
        {props.action}
      </span>
    </div>
  );
}

const routeKind = (route: ModelRoute) =>
  route.kind === "http"
    ? "HTTP route"
    : route.kind === "service"
      ? "Service mount"
      : route.kind === "webSocket"
        ? "WebSocket route key"
        : "Agent route";

export function RouteView(props: { readonly route: ModelRoute }) {
  const { snapshot, index, model, select } = useStudio();
  const { route } = props;
  const target = index.targets.get(route.target);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        {target ? (
          <TargetKind target={target}>{routeKind(route)}</TargetKind>
        ) : (
          <InspectorKind>{routeKind(route)}</InspectorKind>
        )}
        <EntityName
          entity={route.id}
          fallback={route.browserPath ?? route.path}
          icon={<EntityIcon size={24} icon={routeIcon(route)} />}
        />
        <RouteStatus route={route} />
        <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
          {route.origin}
        </code>
        <Written
          placement="header"
          location={snapshot.source.entities[route.id]?.key}
          label="Declared in"
        />
      </header>
      <Tags entity={target?.ref ?? route.id} route />
      <Description entity={route.id} />
      {target ? <TargetDeployment target={target} route /> : null}
      <section className={inspectorSectionClasses}>
        <p className="mt-0 mb-2 text-caption text-graphite">
          Served by{" "}
          <button
            className={buttonClasses({ variant: "link" })}
            onClick={() => select(drawnAs(model)[route.id])}
          >
            {route.kind === "agent"
              ? (index.targets.get(route.target)?.id ?? route.target)
              : route.kind === "webSocket"
                ? "WebSocket API"
                : "HTTP API"}
          </button>
          .
        </p>
        {route.methods ? (
          <p className="mt-0 mb-2">
            Answers {route.methods === "*" ? "every method" : route.methods.join(", ")}.
          </p>
        ) : null}
        <p className="mt-0 mb-2 text-graphite text-caption">
          {route.auth
            ? route.kind === "webSocket"
              ? "The $connect authorizer admits the connection."
              : "The gateway admits signed-in users only. The handler still checks the user itself if it needs one."
            : "Open to any caller."}
        </p>
        <p className="mt-0 mb-2 text-graphite text-caption">
          The public path keeps its existing deployment target. Update application call sites and
          external callers that use the old path separately.
        </p>
      </section>
      {(route.kind === "http" || route.kind === "service") && target ? (
        <ApiAuthControl target={target} />
      ) : null}
      <Relations id={route.id} />
    </>
  );
}
