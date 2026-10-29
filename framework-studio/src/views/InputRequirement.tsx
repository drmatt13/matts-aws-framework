import { InspectorSummary } from "./InspectorUI";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
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
  return <div className={cx("my-[10px] rounded-md border-l-[3px] px-3 py-[10px] text-caption [&_p]:my-1.25", missing ? "border-refuse bg-refuse-wash [&>strong]:text-refuse" : "border-graphite bg-[rgba(141,159,183,.06)]")} role={missing ? "alert" : "note"} data-slot="input-requirement">
    <strong>{missing ? "Required value missing" : "Required input"}</strong>
    <p><code>{requirement.name}</code> is required for {requirement.mode === "dev" ? "Development" : "Production"}.
      {missing ? " No non-blank environment value or declaration default supplies it." : requirement.status === "default" ? " A declaration default currently supplies it." : requirement.status === "unknown" ? " Its value could not be checked. Fix the configuration or file read error first." : ` Supplied by ${requirement.file}.`}</p>
    {requirement.reasons.map((reason) => <p className={"text-caption text-graphite"} key={reason}>{reason}</p>)}
  </div>;
}

/** From and To, omitting an end the surrounding heading already names (a bundle member's shared endpoint). */
export function ConnectionEndpoints({ from, to, except }: { readonly from: string; readonly to: string; readonly except?: { readonly from: string; readonly to: string } }) {
  const { index, select } = useStudio();
  const rows = ([["From", from], ["To", to]] as const).filter(([direction, id]) => except?.[direction === "From" ? "from" : "to"] !== id);
  if (!rows.length) return null;
  return <dl className={"grid [gap:3px] m-[var(--space-1)_0_0] text-caption [&>div]:grid [&>div]:grid-cols-[34px_minmax(0,1fr)] [&>div]:gap-1.5 [&_dt]:text-graphite [&_dd]:m-0 [&_dd]:wrap-anywhere"} data-slot="connection-endpoints">
    {rows.map(([direction, id]) => <div key={direction}><dt>{direction}</dt><dd><button className={buttonClasses({ variant: "link" })} onClick={() => select(id)}>{endpointLabel(index, id)}</button></dd></div>)}
  </dl>;
}

export function ConnectionView({ edge, onlyIn, availability }: { edge: ModelEdge; onlyIn?: Mode; availability?: Availability }) {
  const { snapshot, index } = useStudio();
  return <>
    <header data-slot="connection-header"><span className={"text-graphite text-meta font-medium tracking-[.03em]"}>{edge.inputRequirement ? "Input connection" : "Connection"}</span><h2>{connectionTitle(edge, index)}</h2>
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
  return <div data-slot="connection-details">
      {disabled ? <div className={"[margin-top:14px] p-[10px_var(--space-3)] border border-rule [border-left:3px_solid_var(--faint)] rounded-md [background:rgba(141,159,183,.06)] text-caption [&>strong]:inline-block [&>strong]:text-graphite [&_p]:m-[6px_0] [&_ul]:m-[6px_0_0] [&_ul]:pl-4.5"} role="note" aria-label="Connection deployment status" data-slot="connection-availability">
        <strong>Disabled in {environment}</strong>
        {onlyIn ? <p>This connection exists only in {onlyIn === "dev" ? "Development" : "Production"}.</p> : null}
        {disabledEndpoints.length ? <><p>Both endpoints must be enabled in this environment.</p><ul>{disabledEndpoints.map((id) => <li key={id}><button className={buttonClasses({ variant: "link" })} onClick={() => select(id)}>{titleOf(index, id)}</button> is not enabled in {environment}.</li>)}</ul></> : null}
      </div> : null}
      <RequirementNotice requirement={requirement} />
      {presentation.lines.filter(line => !requirement || line !== "Required value missing.").map(line => <p className={"text-caption"} key={line}>{line}</p>)}
      {edge.authorization ? <details className={"m-[10px_0] [&>summary]:cursor-pointer [&>summary]:text-caption [&>summary]:text-graphite"} data-slot="connection-authorization"><InspectorSummary>Permissions</InspectorSummary><AuthorizationDetails authorization={edge.authorization} /></details> : null}
      {requirement && !requirement.required ? <p className={"text-caption text-graphite"}>Optional in this environment.{requirement.status === "default" ? " A parameter default supplies it." : requirement.status === "configured" ? " An environment value is configured." : ""}</p> : null}
      {requirement ? <>
        <h3>{requirement.status === "missing" ? "Resolve this requirement" : "Manage this input"}</h3>
        <p>Set a non-blank value in <code>{requirement.file}</code>{resource?.kind === "secret" ? ". Secret values stay in the local environment file and never belong in a source-code default." : ", or define a default on the parameter."}</p>
        <div className={"empty:hidden flex flex-wrap gap-2 mt-3 items-center"} data-slot="resource-actions"><button onClick={() => select(`envfile:${requirement.mode}`)}>Edit .env.{requirement.mode}</button>
          <button onClick={() => { if (mode !== requirement.mode) setMode(requirement.mode); select(requirement.resource); }}>{resource?.kind === "secret" ? "Open secret settings" : "Set a parameter default"}</button></div>
        <p className={"text-caption text-graphite"}>Review and apply your draft to update this connection. Saving does not deploy infrastructure or upload a secret.</p>
      </> : null}
      <details className={"m-[10px_0] [&>summary]:cursor-pointer [&>summary]:text-caption [&>summary]:text-graphite [&>[data-slot=node-description]]:border-0 [&>[data-slot=node-description]]:px-0 [&>[data-slot=node-description]]:pt-2 [&>[data-slot=node-description]]:pb-0"} key={descriptionId} data-slot="connection-description">
        <InspectorSummary>{draft.description(descriptionId).trim() ? "Description" : "Add description"}</InspectorSummary>
        <Description entity={descriptionId} connection />
      </details>
      {edge.detail?.trim() || edge.evidence?.length || edge.source ? <details className={"m-[10px_0] [&>summary]:cursor-pointer [&>summary]:text-caption [&>summary]:text-graphite [&[open]>summary]:mb-2.5"} data-slot="connection-configuration">
        <InspectorSummary>Configuration</InspectorSummary>
        {edge.detail?.trim() ? <p>{edge.detail}</p> : null}
        {edge.provenance === "derived" ? <p className={"text-caption text-graphite"}>Derived from the linked declaration.</p> : null}
        {edge.provenance === "source" ? <p className={"text-caption text-graphite"}>Inferred from source; deployment and runtime behavior are not verified.</p> : null}
        {edge.evidence?.length ? <div className="mt-4 grid gap-3 [&>div>[data-ui=written]:first-child]:mt-0 [&_[data-ui=written]]:mb-0.75" data-slot="connection-evidence">{edge.evidence.map((item) => <div key={`${item.role}:${item.location.file}:${item.location.start}`}>
          <Written location={item.location} label={item.role === "derived" ? "Derived from" : item.role} />
          {item.excerpt ? <a className={"block text-meta wrap-anywhere text-graphite no-underline hover:text-ink hover:underline"} href={editorLink(snapshot.repositoryRoot, item.location)} data-slot="evidence-line"><code><span className={"text-graphite"}>{item.location.line}</span> {item.excerpt}</code></a> : null}
        </div>)}</div> : edge.source ? <Written location={edge.source} /> : null}
      </details> : null}
  </div>;
}
