import { useStudio } from "../studio";
import type { Mode } from "../../shared/model";

/** Source projections are distinct from named AWS deployment targets. */
export function SourceEnvironment() {
  const { mode, setMode, snapshot } = useStudio();
  return <div className="source-environment" role="group" aria-label="Source environment" title="Declaration mode. AWS deployment targets are selected separately.">
    <span className="context-label">Source</span>
    <span className="segmented">{(Object.keys(snapshot.models) as Mode[]).map(candidate => <button key={candidate} aria-pressed={mode === candidate} onClick={() => setMode(candidate)}>{candidate === "dev" ? "Development" : "Production"}</button>)}</span>
  </div>;
}
