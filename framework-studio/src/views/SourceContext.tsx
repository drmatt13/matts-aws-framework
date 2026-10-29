import { useStudio } from "../studio";
import type { Mode } from "../../shared/model";

/** Source projections are distinct from named AWS deployment targets. */
export function SourceEnvironment() {
  const { mode, setMode, snapshot } = useStudio();
  return <div className="flex min-w-0 flex-none items-center gap-2 vp-560:col-span-full vp-560:row-start-2 vp-560:justify-self-end" role="group" aria-label="Source environment" title="Declaration mode. AWS deployment targets are selected separately.">
    <span className="text-caption font-normal text-graphite">Source</span>
    <span className="inline-flex shrink-0 gap-0.5 rounded-md border border-rule-strong p-0.5">{(Object.keys(snapshot.models) as Mode[]).map(candidate => <button key={candidate} className="min-h-[26px] cursor-pointer rounded-sm border-0 bg-transparent px-2 py-0.5 font-sans text-label font-medium leading-[1.5] text-graphite not-aria-pressed:hover:bg-wash not-aria-pressed:hover:text-ink aria-pressed:bg-ink aria-pressed:text-sheet" aria-pressed={mode === candidate} onClick={() => setMode(candidate)}>{candidate === "dev" ? "Development" : "Production"}</button>)}</span>
  </div>;
}
