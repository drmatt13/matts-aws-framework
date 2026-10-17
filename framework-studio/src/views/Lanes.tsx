import type { ModelTarget } from "../../shared/model";
import { ROLE_GROUPS, ROLE_LABEL } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { resourceIcon, targetIcon } from "../icons";
import { catalogAvailability } from "../deployment";
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
  const { model, snapshot, selected, select } = useStudio();
  const availability = catalogAvailability(snapshot.models);
  const databases = [
    ...(model.localServices ?? []).map((service) => ({ id: service.id, title: service.title, icon: "postgres" as const, dev: true, prod: false, location: "Compose on your machine" })),
    ...model.resources.filter((resource) => resourceIcon(resource) === "database").map((resource) => ({ id: resource.id, title: resource.path.join("."), icon: "database" as const, dev: availability[resource.id]?.dev ?? false, prod: availability[resource.id]?.prod ?? false, location: "In AWS" })),
  ];
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
      {databases.length ? <section>
        <h2 className="lane-group">Databases</h2>
        {databases.map((database) => <button key={database.id} className="station" aria-current={selected === database.id} onClick={() => select(database.id)}>
          <span className="who"><EntityIcon icon={database.icon} /><span className="label">{database.title}</span></span>
          <Track lane="dev" stops={database.dev} location={database.dev ? database.location : "Not enabled"} />
          <Track lane="prod" stops={database.prod} location={database.prod ? "In AWS" : "Not enabled"} />
          <span className="why">{database.dev ? database.prod ? "Development and production." : "Development only." : "Production only."}</span>
        </button>)}
      </section> : null}
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
