import type { InputRequirement } from "../../shared/deployment-inputs";
import type { Mode, ModelEdge } from "../../shared/model";
import { editorLink, endpointLabel, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { Written } from "./Written";
import { connectionDisabledEndpoints, type Availability } from "../deployment";
import { EnvironmentPills } from "./DeploymentBadge";
import { edgeAvailability } from "../connections";
import { connectionDescriptionId } from "../../shared/descriptions";
import { Description } from "./Description";
import { connectionTitle, presentRelationship } from "../connection-presentation";
import { AuthorizationDetails } from "./Authorization";

export function RequirementNotice({ requirement }: { requirement?: InputRequirement }) {
  if (!requirement?.required) return null;
  const missing = requirement.status === "missing";
  return <div className={`input-requirement ${missing ? "missing" : ""}`} role={missing ? "alert" : "note"}>
    <strong>{missing ? "Required value missing" : "Required input"}</strong>
    <p><code>{requirement.name}</code> is required for {requirement.mode === "dev" ? "Development" : "Production"}.
      {missing ? " No non-blank environment value or declaration default supplies it." : requirement.status === "default" ? " A declaration default currently supplies it." : requirement.status === "unknown" ? " Its value could not be checked. Fix the configuration or file read error first." : ` Supplied by ${requirement.file}.`}</p>
    {requirement.reasons.map((reason) => <p className="small muted" key={reason}>{reason}</p>)}
  </div>;
}

/** From and To, omitting an end the surrounding heading already names (a bundle member's shared endpoint). */
export function ConnectionEndpoints({ from, to, except }: { readonly from: string; readonly to: string; readonly except?: { readonly from: string; readonly to: string } }) {
  const { index, select } = useStudio();
  const rows = ([["From", from], ["To", to]] as const).filter(([direction, id]) => except?.[direction === "From" ? "from" : "to"] !== id);
  if (!rows.length) return null;
  return <dl className="connection-endpoints">
    {rows.map(([direction, id]) => <div key={direction}><dt>{direction}</dt><dd><button className="linkish" onClick={() => select(id)}>{endpointLabel(index, id)}</button></dd></div>)}
  </dl>;
}

export function ConnectionView({ edge, onlyIn, availability }: { edge: ModelEdge; onlyIn?: Mode; availability?: Availability }) {
  const { snapshot, index } = useStudio();
  return <>
    <header className="connection-header"><span className="kind">{edge.inputRequirement ? "Input connection" : "Connection"}</span><h2>{connectionTitle(edge, index)}</h2>
      <EnvironmentPills availability={availability ?? edgeAvailability(edge, snapshot.models)} />
      <ConnectionEndpoints from={edge.from} to={edge.to} />
    </header>
    <section><ConnectionDetails edge={edge} onlyIn={onlyIn} /></section>
  </>;
}

export function ConnectionDetails({ edge, onlyIn }: { edge: ModelEdge; onlyIn?: Mode }) {
  const { index, select, snapshot, mode, setMode, draft } = useStudio();
  const descriptionId = connectionDescriptionId(edge);
  const requirement = edge.inputRequirement;
  const resource = requirement ? snapshot.models[requirement.mode].resources.find((item) => item.id === requirement.resource) : undefined;
  const disabledEndpoints = connectionDisabledEndpoints(index, mode, edge);
  const disabled = onlyIn !== undefined || disabledEndpoints.length > 0;
  const environment = mode === "dev" ? "Development" : "Production";
  const presentation = presentRelationship(edge, index);
  return <div className="connection-details">
      {disabled ? <div className="connection-availability" role="note" aria-label="Connection deployment status">
        <strong>Disabled in {environment}</strong>
        {onlyIn ? <p>This connection exists only in {onlyIn === "dev" ? "Development" : "Production"}.</p> : null}
        {disabledEndpoints.length ? <><p>Both endpoints must be enabled in this environment.</p><ul>{disabledEndpoints.map((id) => <li key={id}><button className="linkish" onClick={() => select(id)}>{titleOf(index, id)}</button> is not enabled in {environment}.</li>)}</ul></> : null}
      </div> : null}
      <RequirementNotice requirement={requirement} />
      {presentation.lines.filter(line => !requirement || line !== "Required value missing.").map(line => <p className="small" key={line}>{line}</p>)}
      {edge.authorization ? <details className="connection-authorization"><summary>Permissions</summary><AuthorizationDetails authorization={edge.authorization} /></details> : null}
      {requirement && !requirement.required ? <p className="small muted">Optional in this environment.{requirement.status === "default" ? " A parameter default supplies it." : requirement.status === "configured" ? " An environment value is configured." : ""}</p> : null}
      {requirement ? <>
        <h3>{requirement.status === "missing" ? "Resolve this requirement" : "Manage this input"}</h3>
        <p>Set a non-blank value in <code>{requirement.file}</code>{resource?.kind === "secret" ? ". Secret values stay in the local environment file and never belong in a source-code default." : ", or define a default on the parameter."}</p>
        <div className="resource-actions"><button onClick={() => select(`envfile:${requirement.mode}`)}>Edit .env.{requirement.mode}</button>
          <button onClick={() => { if (mode !== requirement.mode) setMode(requirement.mode); select(requirement.resource); }}>{resource?.kind === "secret" ? "Open secret settings" : "Set a parameter default"}</button></div>
        <p className="small muted">Review and apply your draft to update this connection. Saving does not deploy infrastructure or upload a secret.</p>
      </> : null}
      <details className="connection-description" key={descriptionId}>
        <summary>{draft.description(descriptionId).trim() ? "Description" : "Add description"}</summary>
        <Description entity={descriptionId} connection />
      </details>
      {edge.detail?.trim() || edge.evidence?.length || edge.source ? <details className="connection-configuration">
        <summary>Configuration</summary>
        {edge.detail?.trim() ? <p>{edge.detail}</p> : null}
        {edge.provenance === "derived" ? <p className="small muted">Derived from the linked declaration.</p> : null}
        {edge.provenance === "source" ? <p className="small muted">Inferred from source; deployment and runtime behavior are not verified.</p> : null}
        {edge.evidence?.length ? <div className="connection-evidence">{edge.evidence.map((item) => <div key={`${item.role}:${item.location.file}:${item.location.start}`}>
          <Written location={item.location} label={item.role === "derived" ? "Derived from" : item.role} />
          {item.excerpt ? <a className="evidence-line" href={editorLink(snapshot.repositoryRoot, item.location)}><code><span className="muted">{item.location.line}</span> {item.excerpt}</code></a> : null}
        </div>)}</div> : edge.source ? <Written location={edge.source} /> : null}
      </details> : null}
  </div>;
}
