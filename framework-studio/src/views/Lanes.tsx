import type { ModelTarget } from "../../shared/model";
import { ROLE_GROUPS, ROLE_LABEL } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { targetIcon } from "../icons";
import { developmentLocation, deploymentSummary, environments } from "../deployment";

/**
 * Where everything runs, drawn as a line diagram.
 *
 * Each environment is a line and each target a station on both; a stop means the
 * framework would run it there. The right-hand column says why, in the
 * framework's own terms, because a lane is rarely just the deploy token: tools
 * follow their agents, events have no toggle, and a development deployment
 * builds only what AWS invokes.
 */

function Track(props: { readonly lane: "dev" | "prod"; readonly stops: boolean; readonly location: string }) {
  return (
    <span className={`track ${props.lane}`} role="img" aria-label={`${props.lane === "dev" ? "Development" : "Production"}: ${props.location}`} title={props.location}>
      <span className={`stop ${props.stops ? "" : "skip"}`} />
      <span className="track-detail" aria-hidden>{props.location}</span>
    </span>
  );
}

function Station(props: { readonly target: ModelTarget }) {
  const { selected, select } = useStudio();
  const { target } = props;
  const lanes = target.lanes;
  const availability = environments(lanes);
  return (
    <div
      className="station"
      role="button"
      tabIndex={0}
      aria-current={selected === target.ref}
      onClick={() => select(selected === target.ref ? undefined : target.ref)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(target.ref);
        }
      }}
    >
      <span className="who">
        <EntityIcon icon={targetIcon(target)} />
        <span className="label">{target.title}</span>
        <span className="sub">
          {ROLE_LABEL[target.role]}
          {target.title !== target.id ? `, ${target.id}` : ""}
        </span>
      </span>
      <Track lane="dev" stops={availability.dev} location={developmentLocation(lanes)} />
      <Track lane="prod" stops={availability.prod} location={lanes.prod ? "In AWS" : "Not enabled"} />
      <span className="why">
        {deploymentSummary(lanes)}
        {lanes.origin === "derived" ? " Follows its agents." : null}
      </span>
    </div>
  );
}

export function Lanes() {
  const { model } = useStudio();
  return (
    <div className="lanes">
      <div className="lanes-head">
        <span className="muted small">
          Two environments. A stop means it runs there.
        </span>
        <span className="lane-name dev">Development</span>
        <span className="lane-name prod">Production</span>
        <span className="muted small">Execution</span>
      </div>
      {ROLE_GROUPS.map((group) => {
        const targets = model.targets.filter((target) => group.roles.includes(target.role));
        if (targets.length === 0) return null;
        return (
          <section key={group.title}>
            <h2 className="lane-group">{group.title}</h2>
            {targets.map((target) => (
              <Station key={target.ref} target={target} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
