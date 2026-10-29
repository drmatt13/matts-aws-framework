import { InspectorSummary } from "./InspectorUI";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { DeployControl } from "./DeployControl";
import { Code2, Diamond } from "lucide-react";
import type { ReactNode } from "react";
import type { Mode, ModelResource, ModelTarget } from "../../shared/model";
import { catalogAvailability, developmentLocation, environments, previewDeploymentLanes, type Availability } from "../deployment";
import { useStudio } from "../studio";
import { InspectorSection } from "./InspectorUI";

/** One place, order and vocabulary for deployment throughout the inspector. */
export function DeploymentSection({ availability, locations, children, catalog = false }: {
  readonly availability: Availability;
  readonly locations?: Readonly<Partial<Record<Mode, string>>>;
  readonly children?: ReactNode;
  readonly catalog?: boolean;
}) {
  return <InspectorSection title="Deployment" className={"[&>[data-slot=section-content]]:grid [&>[data-slot=section-content]]:gap-4"} data-slot="inspector-deployment">
    <div className={"grid grid-cols-2 gap-2 m-0"} aria-live="polite" aria-atomic="true" data-slot="lane-lines">{(["dev", "prod"] as const).map((mode) => <div key={mode} className={cx("[&_strong]:text-ink [&_strong]:text-label [&_strong]:font-medium flex flex-col border border-rule rounded-md text-caption p-[var(--space-2)_var(--space-3)] gap-1 [background:color-mix(in_srgb,_currentColor_3%,_var(--sheet))]", mode === "dev" ? "text-dev" : "text-prod", availability[mode] ? "" : "[border-top-style:dotted] [&_strong]:text-faint [&_span]:text-faint")} data-slot="lane-line" data-mode={mode}>
      <span className={"flex items-center gap-[6px] text-meta font-medium text-inherit"} data-slot="environment-name">{mode === "dev" ? <Code2 size={14} aria-hidden /> : <Diamond size={14} aria-hidden />}{mode === "dev" ? "Development" : "Production"}</span>
      <strong>{catalog ? availability[mode] ? "Available" : "Unavailable" : availability[mode] ? "Enabled" : "Not enabled"}</strong>
      {availability[mode] && locations?.[mode] ? <span data-slot="execution-location" className="text-meta text-graphite">{locations[mode]}</span> : null}
    </div>)}</div>
    {children}
  </InspectorSection>;
}

export function TargetDeployment({ target, route = false }: { readonly target: ModelTarget; readonly route?: boolean }) {
  const { snapshot, model, draft, draftState, select } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "deploy");
  const changed = fact && draft.field(target.ref, fact);
  const lanes = (mode: Mode) => {
    const graph = snapshot.models[mode];
    const saved = graph.targets.find((item) => item.ref === target.ref);
    if (!saved) return { ...target.lanes, local: false, dev: false, prod: false };
    const deployment = draftState.entries.find(entry => entry.kind === "operation" && entry.operation.kind === "deploy" && entry.operation.target === target.ref);
    if (target.role === "tool" && deployment?.kind === "operation" && deployment.operation.kind === "deploy" && deployment.operation.value === "inherit") {
      const consumers = graph.targets.filter(item => item.compute.kind === "agent" && item.compute.tools.includes(target.id));
      return { ...saved.lanes, local: consumers.some(item => item.lanes.local), cloud: consumers.some(item => item.lanes.cloud), dev: consumers.some(item => item.lanes.dev), prod: consumers.some(item => item.lanes.prod) };
    }
    if (deployment?.kind === "operation" && deployment.operation.kind === "deploy" && typeof deployment.operation.value === "string") return previewDeploymentLanes(saved, deployment.operation.value === "inherit" ? "both" : deployment.operation.value, graph.deployChoices?.[target.role]);
    return changed && !changed.error && fact
      ? previewDeploymentLanes(saved, String(draft.effective(target.ref, fact)), graph.deployChoices?.[target.role])
      : saved.lanes;
  };
  const dev = lanes("dev");
  let development = developmentLocation(dev);
  if (target.role === "event") {
    const graph = snapshot.models.dev;
    const saved = graph.targets.find((item) => item.ref === target.ref) ?? target;
    const replayFact = graph.fields[target.ref]?.find((fact) => fact.field === "events.localReplay");
    const replay = replayFact ? draft.effective(target.ref, replayFact) === true : saved.compute.kind === "lambda" && saved.compute.localReplay;
    development = dev.dev ? replay && dev.local ? "AWS first → captured → replayed on your machine" : "In AWS" : dev.local ? "On your machine" : "Not enabled";
  }
  return <DeploymentSection availability={{ dev: environments(dev).dev, prod: lanes("prod").prod }} locations={{ dev: development, prod: "In AWS" }}>
    <DeployControl target={target} />
    {route ? <p className={"m-0 wrap-anywhere text-caption text-graphite"} data-slot="deployment-note">Shared with <button className={buttonClasses({ variant: "link" })} onClick={() => select(target.ref)}>{target.title}</button>.</p> : null}
    {target.role === "event" ? <p className={"m-0 wrap-anywhere text-caption text-graphite"} data-slot="deployment-note">Enabled cloud lanes include native AWS triggers. Local-only execution requires a local caller; AWS triggers are omitted.</p> : null}
    {target.role === "tool" && target.lanes.origin === "derived" ? <p className={"m-0 wrap-anywhere text-caption text-graphite"} data-slot="deployment-note">{target.lanes.derivedFrom?.length ? <>Inherits from {target.lanes.derivedFrom.map((ref, index) => <span key={ref}>{index ? ", " : ""}<button className={buttonClasses({ variant: "link" })} onClick={() => select(ref)}>{model.targets.find((item) => item.ref === ref)?.title ?? ref}</button></span>)}. Set Deploy to override.</> : "No agent lists this tool. Set Deploy to enable it independently."}</p> : null}
  </DeploymentSection>;
}

/** Child infrastructure follows its owner; never offers an ineffective flag. */
export function DeploymentOwnership({ reason, owners = [] }: { readonly reason: string; readonly owners?: readonly { readonly id: string; readonly title: string }[] }) {
  const { select } = useStudio();
  return <div className={"grid min-w-0 gap-3 [&_details>summary]:text-graphite [&_details>summary]:text-caption [&_details[open]>summary]:mb-2"} data-slot="deployment-ownership">
    <p className={"m-0 wrap-anywhere text-caption text-graphite"} data-slot="deployment-note">{reason}</p>
    {owners.length > 3 ? <details><InspectorSummary>Configure owners ({owners.length})</InspectorSummary><div className={"flex flex-wrap gap-2 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:text-left [&_button]:wrap-anywhere"} data-slot="deployment-owners">{owners.map(owner => <button key={owner.id} className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={() => select(owner.id)}>Configure {owner.title}</button>)}</div></details> : owners.length ? <div className={"flex flex-wrap gap-2 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:text-left [&_button]:wrap-anywhere"} data-slot="deployment-owners">{owners.map(owner => <button key={owner.id} className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} onClick={() => select(owner.id)}>Configure {owner.title}</button>)}</div> : null}
  </div>;
}

export function ResourceDeployment({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, model } = useStudio();
  if (resource.kind === "input" || resource.kind === "secret" || resource.kind === "group") return null;
  const availability = catalogAvailability(snapshot.models)[resource.id] ?? { dev: false, prod: false };
  const parent = resource.kind === "member" && resource.parent ? model.resources.find((item) => item.id === resource.parent) : undefined;
  const consumers = model.targets.filter(target => model.edges.some(edge => edge.from === target.ref && (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`))));
  const owners = parent ? [{ id: parent.id, title: parent.stackClass ?? parent.path.join(".") }] : consumers.map(target => ({ id: target.ref, title: target.title }));
  return <DeploymentSection availability={availability} catalog>
    <DeploymentOwnership owners={owners} reason={parent ? "This member is created with its owning stack." : resource.frameworkManaged ? "The framework owns this infrastructure. Its consumers control their own deployment; this resource has no independent workload flag." : "Native CDK controls stack construction. Catalog availability does not deploy a stack; review its owning CDK declaration before changing its lifecycle."} />
  </DeploymentSection>;
}
