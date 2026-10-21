import { Code2, Diamond } from "lucide-react";
import type { ReactNode } from "react";
import type { Mode, ModelResource, ModelTarget } from "../../shared/model";
import { catalogAvailability, developmentLocation, environments, previewDeploymentLanes, type Availability } from "../deployment";
import { useStudio } from "../studio";
import { FieldRow } from "./FieldRow";
import { InspectorSection } from "./InspectorUI";

/** One place, order and vocabulary for deployment throughout the inspector. */
export function DeploymentSection({ availability, locations, children, catalog = false }: {
  readonly availability: Availability;
  readonly locations?: Readonly<Partial<Record<Mode, string>>>;
  readonly children?: ReactNode;
  readonly catalog?: boolean;
}) {
  return <InspectorSection title="Deployment" className="inspector-deployment">
    <div className="lane-lines" aria-live="polite" aria-atomic="true">{(["dev", "prod"] as const).map((mode) => <div key={mode} className={`lane-line ${mode}${availability[mode] ? "" : " off"}`}>
      <span className="environment-name">{mode === "dev" ? <Code2 size={14} aria-hidden /> : <Diamond size={14} aria-hidden />}{mode === "dev" ? "Development" : "Production"}</span>
      <strong>{catalog ? availability[mode] ? "Available" : "Unavailable" : availability[mode] ? "Enabled" : "Not enabled"}</strong>
      {availability[mode] && locations?.[mode] ? <span className="small muted">{locations[mode]}</span> : null}
    </div>)}</div>
    {children}
  </InspectorSection>;
}

export function TargetDeployment({ target, route = false }: { readonly target: ModelTarget; readonly route?: boolean }) {
  const { snapshot, model, draft, select } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "deploy");
  const changed = fact && draft.field(target.ref, fact);
  const lanes = (mode: Mode) => {
    const graph = snapshot.models[mode];
    const saved = graph.targets.find((item) => item.ref === target.ref);
    if (!saved) return { ...target.lanes, local: false, dev: false, prod: false };
    return changed && !changed.error && fact
      ? previewDeploymentLanes(saved, String(draft.effective(target.ref, fact)), graph.webSocketApi ?? snapshot.webSocketApi)
      : saved.lanes;
  };
  const dev = lanes("dev");
  let development = developmentLocation(dev);
  if (target.role === "event") {
    const graph = snapshot.models.dev;
    const saved = graph.targets.find((item) => item.ref === target.ref) ?? target;
    const replayFact = graph.fields[target.ref]?.find((fact) => fact.field === "events.localReplay");
    const replay = replayFact ? draft.effective(target.ref, replayFact) === true : saved.compute.kind === "lambda" && saved.compute.localReplay;
    development = replay ? "AWS first → captured → replayed on your machine" : "In AWS";
  }
  return <DeploymentSection availability={{ dev: environments(dev).dev, prod: lanes("prod").prod }} locations={{ dev: development, prod: "In AWS" }}>
    {fact ? <FieldRow target={target} fact={fact} editability={snapshot.source.editability[target.ref]?.[fact.field]} /> : null}
    {route ? <p className="deployment-note small muted">Shared with <button className="linkish" onClick={() => select(target.ref)}>{target.title}</button>.</p> : null}
    {target.role === "event" ? <p className="deployment-note small muted">AWS invokes this function in both environments.</p> : null}
    {target.role === "tool" ? <p className="deployment-note small muted">{target.lanes.derivedFrom?.length ? <>Follows {target.lanes.derivedFrom.map((ref, index) => <span key={ref}>{index ? ", " : ""}<button className="linkish" onClick={() => select(ref)}>{model.targets.find((item) => item.ref === ref)?.title ?? ref}</button></span>)}.</> : "Enable this tool by adding it to an agent."}</p> : null}
  </DeploymentSection>;
}

export function ResourceDeployment({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, model, select } = useStudio();
  const availability = catalogAvailability(snapshot.models)[resource.id] ?? { dev: false, prod: false };
  const parent = resource.kind === "member" && resource.parent ? model.resources.find((item) => item.id === resource.parent) : undefined;
  return <DeploymentSection availability={availability} catalog>
    <p className="deployment-note small muted">{parent ? <>Controlled by <button className="linkish" onClick={() => select(parent.id)}>{parent.stackClass ?? parent.path.join(".")}</button>.</> : resource.frameworkManaged ? "Availability is managed by the framework." : "Availability is configured in the catalog declaration."}</p>
  </DeploymentSection>;
}
