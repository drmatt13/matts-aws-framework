import { ChevronDown, ChevronRight, Laptop } from "lucide-react";
import { useState } from "react";
import type { DiscoveredDeploymentView, LocalRunView, TargetView } from "../../../shared/deploy";
import { DeploymentBadge } from "../DeploymentBadge";
import { STATE_LABEL } from "./format";

export interface RailRow {
  readonly name: string;
  readonly mode: "dev" | "prod";
  readonly section: "repository" | "discovered";
  readonly target?: Omit<TargetView, "status" | "detail">;
  readonly match?: TargetView;
  readonly deployment?: DiscoveredDeploymentView;
}

function statusOf(row: RailRow, known: boolean): { label: string; tone: string } {
  if (!known) return { label: "—", tone: "unknown" };
  if (row.match?.status === "conflict" || row.deployment?.state.kind === "conflict") return { label: "Conflict", tone: "bad" };
  if (row.match?.status === "elsewhere") return { label: "Elsewhere", tone: "unknown" };
  const kind = row.deployment?.state.kind ?? "absent";
  const reviewOnly = kind === "in-progress" && row.deployment!.stacks.filter((stack) => stack.health !== "complete").every((stack) => stack.health === "review");
  if (reviewOnly) return { label: row.deployment!.stacks.some((stack) => stack.health === "complete") ? "Plan waiting" : "Not deployed · plan waiting", tone: "none" };
  const tone = kind === "ready" ? "ok" : kind === "in-progress" ? "busy" : kind === "absent" ? "none" : kind === "rolled-back" ? "warn" : "bad";
  return { label: STATE_LABEL[kind] ?? kind, tone };
}

/**
 * Every deployment in view: the ones this repository intends, the others the
 * account holds (read-only), and stacks nobody's records claim.
 */
export function Rail(props: {
  readonly rows: readonly RailRow[];
  readonly unrecognized: readonly { readonly name: string; readonly status: string; readonly reason: string }[];
  readonly selected: string | undefined;
  readonly onSelect: (name: string) => void;
  readonly known: boolean;
  readonly local: LocalRunView | undefined;
}) {
  const [showUnrecognized, setShowUnrecognized] = useState(false);
  const repository = props.rows.filter((row) => row.section === "repository");
  const discovered = props.rows.filter((row) => row.section === "discovered");
  const attached = props.local?.exported.deployment;
  const localRunning = props.local && props.local.startedBy !== "none";

  const item = (row: RailRow) => {
    const status = statusOf(row, props.known);
    return (
      <li key={row.name}>
        <button className={`rail-item ${props.selected === row.name ? "selected" : ""} ${row.mode}`} aria-current={props.selected === row.name ? "true" : undefined} onClick={() => props.onSelect(row.name)}>
          <span className="rail-name">
            <span className={`status-dot ${status.tone}`} aria-hidden />
            <strong>{row.name}</strong>
          </span>
          <span className="rail-meta">
            <DeploymentBadge kind={row.mode} />
            <span className={`rail-status ${status.tone}`}>{status.label}</span>
            {attached === row.name && localRunning ? <span className="local-tag" title="Local development runs against this deployment"><Laptop size={11} aria-hidden /> Local</span> : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav className="deploy-rail" aria-label="Deployments">
      <h2 className="rail-heading">In this repository</h2>
      <ul className="rail-list">{repository.map(item)}</ul>
      {discovered.length ? (
        <>
          <h2 className="rail-heading">Also in this account <span className="muted">read-only</span></h2>
          <ul className="rail-list">{discovered.map(item)}</ul>
        </>
      ) : null}
      {props.unrecognized.length ? (
        <div className="rail-unrecognized">
          <button className="rail-heading toggle" aria-expanded={showUnrecognized} onClick={() => setShowUnrecognized(!showUnrecognized)}>
            {showUnrecognized ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Unrecognized stacks ({props.unrecognized.length})
          </button>
          {showUnrecognized ? (
            <ul className="unrecognized-list">
              {props.unrecognized.map((stack) => (
                <li key={stack.name}>
                  <code>{stack.name}</code>
                  <span className="small muted">{stack.status} · {stack.reason}</span>
                </li>
              ))}
              <li className="small muted">Named like a deployment but carrying no framework records. Studio never changes them.</li>
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="rail-local" aria-label="Local development">
        <Laptop size={14} aria-hidden />
        <span>
          <span className="small muted">This machine</span>
          <br />
          {attached ? <>Settings for <strong>{attached}</strong>{localRunning ? <span className="local-running"> · running</span> : null}</> : <span className="muted">No exported settings</span>}
        </span>
      </div>
    </nav>
  );
}
