import { cx } from "../../ui/classes";

import { StatusDot } from "./DeployUI";

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
  if (!known) return { label: "Unverified", tone: "unknown" };
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
        <button className={cx("grid w-full cursor-pointer gap-1 rounded-md border border-l-[3px] px-3 py-2 text-left hover:bg-wash", props.selected === row.name ? row.mode === "dev" ? "border-rule border-l-dev bg-sheet" : "border-rule border-l-prod bg-sheet" : "border-transparent bg-transparent")} aria-current={props.selected === row.name ? "true" : undefined} onClick={() => props.onSelect(row.name)}>
          <span className={"flex min-w-0 items-center gap-2 [&>strong]:truncate [&>strong]:font-semibold"}>
            <StatusDot tone={status.tone} />
            <strong title={row.name}>{row.name}</strong>
          </span>
          <span className={"flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-step-minus1 text-graphite"}>
            <DeploymentBadge kind={row.mode} />
            <span className={status.tone === "bad" ? "text-refuse" : status.tone === "busy" ? "text-local" : undefined}>{status.label}</span>
            {attached === row.name && localRunning ? <span className={"inline-flex items-center gap-[3px] font-medium text-local"} title="Local development runs against this deployment"><Laptop size={11} aria-hidden /> Local</span> : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav className={"flex flex-col gap-1 overflow-auto border-r border-rule bg-[color-mix(in_srgb,var(--sheet)_55%,var(--paper))] px-3 py-5 vp-900:max-h-[40vh] vp-900:border-r-0 vp-900:border-b"} aria-label="Deployments">
      <h2 className={"mx-2 mt-0 mb-2 font-sans text-caption font-medium leading-[1.5] text-graphite [[data-ui=rail-list]+&]:mt-4"}>In this repository</h2>
      <ul data-ui="rail-list" className={"m-0 grid list-none gap-0.5 p-0"}>{repository.map(item)}</ul>
      {discovered.length ? (
        <>
          <h2 className={"mx-2 mt-0 mb-2 font-sans text-caption font-medium leading-[1.5] text-graphite [[data-ui=rail-list]+&]:mt-4"}>Also in this account <span className={"text-graphite"}>not declared here</span></h2>
          <ul data-ui="rail-list" className={"m-0 grid list-none gap-0.5 p-0"}>{discovered.map(item)}</ul>
        </>
      ) : null}
      {props.unrecognized.length ? (
        <div className={"mt-4"}>
          <button className={"mx-2 mt-0 mb-2 font-sans text-caption font-medium leading-[1.5] text-graphite [[data-ui=rail-list]+&]:mt-4 inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-left"} aria-expanded={showUnrecognized} onClick={() => setShowUnrecognized(!showUnrecognized)}>
            {showUnrecognized ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Unrecognized stacks ({props.unrecognized.length})
          </button>
          {showUnrecognized ? (
            <ul className={"mx-2 my-0 grid list-none gap-[6px] p-0 [&>li]:grid [&>li]:gap-0.5 [&>li]:wrap-anywhere"}>
              {props.unrecognized.map((stack) => (
                <li key={stack.name}>
                  <code>{stack.name}</code>
                  <span className={"text-caption text-graphite"}>{stack.status} · {stack.reason}</span>
                </li>
              ))}
              <li className={"text-caption text-graphite"}>Named like a deployment but carrying no framework records. Studio never changes them.</li>
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className={"mt-auto flex items-start gap-2 border-t border-rule px-3 pt-3 pb-1 text-step-minus1 text-ink [&>svg]:mt-0.75 [&>svg]:text-local"} aria-label="Local development">
        <Laptop size={14} aria-hidden />
        <span>
          <span className={"text-caption text-graphite"}>This machine</span>
          <br />
          {attached ? <>Settings for <strong>{attached}</strong>{localRunning ? <span className={"font-medium text-local"}> · running</span> : null}</> : <span className={"text-graphite"}>No exported settings</span>}
        </span>
      </div>
    </nav>
  );
}
