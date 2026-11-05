import { useStudio } from "../studio";
import type { Mode } from "../../shared/model";
import { AwsProfileMenu } from "./AwsProfileMenu";
import { useId, useState } from "react";
import { useDeploymentObservation } from "../deploy/observations";
import { deploymentPresence } from "../deploy/presence";
import { cx } from "../ui/classes";

/** Source modes carry a profile association; named deployment targets remain separate. */
export function SourceEnvironment() {
  const { mode, setMode, snapshot } = useStudio();
  const profileId = useId();
  const [profileOpen, setProfileOpen] = useState(false);
  const dev = useDeploymentObservation("dev"), prod = useDeploymentObservation("prod");
  const presence = { dev, prod };
  return <div className="flex min-w-0 flex-none items-center gap-2 vp-560:col-span-full vp-560:row-start-2 vp-560:justify-self-end" role="group" aria-label="Source environment" title="Declaration mode. AWS deployment targets are selected separately.">
    <span className="text-caption font-normal text-graphite">Source</span>
    <span className="inline-flex shrink-0 gap-0.5 rounded-md border border-rule-strong p-0.5">{(Object.keys(snapshot.models) as Mode[]).map(candidate => {
      const observation = presence[candidate];
      const indicator = deploymentPresence({ ...observation, fetching: observation.statusQuery.isFetching });
      const descriptionId = `${profileId}-${candidate}-deployment`;
      return <span key={candidate} className="inline-flex"><button className="inline-flex min-h-[26px] cursor-pointer items-center gap-1.5 rounded-sm border border-transparent bg-transparent px-2 py-0.5 font-sans text-label font-medium leading-[1.5] text-graphite not-aria-pressed:hover:bg-wash not-aria-pressed:hover:text-ink aria-pressed:border-rule-strong aria-pressed:bg-wash aria-pressed:text-ink" aria-pressed={mode === candidate}
      aria-describedby={descriptionId} title={indicator.description}
      // While open, native show-only invokers keep mode clicks inside the popover's dismissal boundary.
      popoverTarget={profileOpen ? profileId : undefined} popoverTargetAction="show"
      onClick={() => setMode(candidate)}><span className={cx("size-1.5 shrink-0 rounded-full", indicator.state === "deployed" ? "bg-accept" : indicator.state === "absent" ? "bg-refuse" : indicator.state === "attention" ? "bg-local" : "bg-faint", indicator.state === "pending" && "animate-deploy-pulse motion-reduce:animate-none")} data-deployment-state={indicator.state} aria-hidden="true" />{candidate === "dev" ? "Development" : "Production"}</button><span id={descriptionId} className="sr-only">{indicator.description}</span></span>;
    })}</span>
    <AwsProfileMenu id={profileId} open={profileOpen} onOpenChange={setProfileOpen} />
  </div>;
}
