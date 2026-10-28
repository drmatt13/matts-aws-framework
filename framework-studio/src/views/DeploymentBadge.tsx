import { DEPLOYMENT_BADGES, type Availability, type DeploymentBadgeKind } from "../deployment";
import type { Mode } from "../../shared/model";

/** Keep both environment names visible in hover cards and connection inspectors. */
export function EnvironmentPills({ availability, descriptions, unavailableDescription = "not deployed", onToggle, disabled, label = "Deployment environments" }: {
  readonly availability: Availability;
  readonly descriptions?: Readonly<Partial<Record<Mode, string>>>;
  readonly unavailableDescription?: string;
  readonly onToggle?: (mode: Mode) => void;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  return <span className="environment-pills" role={onToggle ? "group" : undefined} aria-label={label}>
    {(["dev", "prod"] as const).map((mode) => onToggle ? <button key={mode} type="button" className={`hover-tag ${availability[mode] ? mode : "off"}`} disabled={disabled} aria-pressed={availability[mode]} aria-label={`${label} in ${mode === "dev" ? "Development" : "Production"}`} title={`${availability[mode] ? "Included" : "Omitted"} in ${mode === "dev" ? "Development" : "Production"} · click to toggle`} onClick={() => onToggle(mode)}>{mode === "dev" ? "Dev" : "Prod"}</button> : <span key={mode} className={`hover-tag ${availability[mode] ? mode : "off"}`}>
      {mode === "dev" ? "Dev" : "Prod"}<span className="sr-only">: {availability[mode] ? descriptions?.[mode] ?? "Connection enabled" : unavailableDescription}</span>
    </span>)}
  </span>;
}

export function DeploymentBadge({ kind }: { readonly kind: DeploymentBadgeKind | undefined }) {
  if (!kind) return null;
  const badge = DEPLOYMENT_BADGES[kind];
  return (
    <span className={`deployment-badge ${kind}`} title={badge.description} aria-label={badge.description} style={{ color: badge.color, backgroundColor: badge.background }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {badge.paths.map((d) => <path key={d} d={d} />)}
      </svg>
      <span>{badge.label}</span>
    </span>
  );
}

export function DeploymentLegend() {
  return <span className="deployment-legend"><span>Unmarked · Dev + Prod</span><DeploymentBadge kind="dev" /><DeploymentBadge kind="prod" /></span>;
}
