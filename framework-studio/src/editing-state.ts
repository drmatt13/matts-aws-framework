import type { ModeModel } from "../shared/model";
import type { DraftState, InspectorDraft } from "./draft";
import type { LiveState } from "./snapshot";

interface SourceEditState {
  readonly draftState: Pick<DraftState, "busy">;
  readonly draft: Pick<InspectorDraft, "conflict">;
  readonly model: Pick<ModeModel, "stale">;
  readonly live: Pick<LiveState, "evaluating">;
}

/** Common source-edit gate. Feature-specific restrictions remain with the control. */
export function sourceEditBlocked({ draftState, draft, model, live }: SourceEditState): boolean {
  return !!draftState.busy || draft.conflict || !!model.stale || live.evaluating;
}
