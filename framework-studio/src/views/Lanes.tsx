import type { Lanes as LaneFacts, ModelTarget } from "../../shared/model";
import { ROLE_GROUPS, ROLE_LABEL } from "../lookup";
import { useStudio } from "../studio";

/**
 * Where everything runs, drawn as a line diagram.
 *
 * Each lane is a line and each target a station on all three; a stop means the
 * framework would run it there. The right-hand column says why, in the
 * framework's own terms, because a lane is rarely just the deploy token: tools
 * follow their agents, events have no toggle, and a development deployment
 * builds only what AWS invokes.
 */

const ORIGIN_TEXT: Readonly<Record<LaneFacts["origin"], string>> = {
  declared: "declared",
  default: "the default",
  derived: "derived",
  "aws-invoked": "AWS-invoked",
};

function Track(props: { readonly lane: "local" | "dev" | "prod"; readonly stops: boolean }) {
  return (
    <span className={`track ${props.lane}`}>
      <span className={`stop ${props.stops ? "" : "skip"}`} />
    </span>
  );
}

function Station(props: { readonly target: ModelTarget }) {
  const { selected, select } = useStudio();
  const { target } = props;
  const lanes = target.lanes;
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
        <span className="label">{target.title}</span>
        <span className="sub">
          {ROLE_LABEL[target.role]}
          {target.title !== target.id ? `, ${target.id}` : ""}
        </span>
      </span>
      <Track lane="local" stops={lanes.local} />
      <Track lane="dev" stops={lanes.dev} />
      <Track lane="prod" stops={lanes.prod} />
      <span className="why">
        <strong>{lanes.deploy}</strong>, {ORIGIN_TEXT[lanes.origin]}
        {lanes.note ? `. ${lanes.note}` : "."}
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
          A stop means it runs there. {model.mode === "dev" ? "Development" : "Production"} graph shown.
        </span>
        <span className="lane-name local">Local</span>
        <span className="lane-name dev">Dev AWS</span>
        <span className="lane-name prod">Prod AWS</span>
        <span className="muted small">Deploy setting, and why</span>
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
