import { Redo2, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError } from "../api";
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

/** Reused beside source controls; never confused with operation history. */
export function SourceHistory() {
  const { response, draft, draftState, live, toast } = useStudio();
  const [pending, setPending] = useState<"undo" | "redo" | null>(null);
  const inFlight = useRef(false);
  const blocked = draft.dirty || !!draftState.busy || live.evaluating || live.running !== null;
  const history = async (direction: "undo" | "redo") => {
    if (inFlight.current || blocked || !response.history[direction]) return;
    inFlight.current = true;
    setPending(direction);
    try {
      const outcome = await (direction === "undo" ? api.undo() : api.redo());
      toast(outcome.message, outcome.status === "applied" ? "plain" : "refuse");
    } catch (error) { toast(error instanceof ApiError ? error.message : String(error), "refuse"); }
    finally { inFlight.current = false; setPending(null); }
  };
  return <span className="history-actions" role="group" aria-label="Source edit history">
    <button className="icon-button" aria-label="Undo" onClick={() => void history("undo")} disabled={!response.history.undo || blocked || pending !== null} title={response.history.undo ? `Undo ${response.history.undo}` : "No source edit to undo"}><Undo2 size={16} aria-hidden /></button>
    <button className="icon-button" aria-label="Redo" onClick={() => void history("redo")} disabled={!response.history.redo || blocked || pending !== null} title={response.history.redo ? `Redo ${response.history.redo}` : "No source edit to redo"}><Redo2 size={16} aria-hidden /></button>
    <span className="sr-only" role="status">{pending === "undo" ? "Undoing source edit…" : pending === "redo" ? "Redoing source edit…" : ""}</span>
  </span>;
}
