import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { SnapshotResponse } from "../shared/api";
import type { Mode, ModeModel, Snapshot } from "../shared/model";
import { api, useLiveUpdates, type LiveState } from "./api";
import { InspectorDraft, protectBeforeUnload, type DraftState } from "./draft";
import { indexModel, type ModelIndex } from "./lookup";

export interface Toast { readonly id: number; readonly text: string; readonly tone: "plain" | "refuse" }
interface StudioContextValue {
  readonly response: SnapshotResponse;
  readonly snapshot: Snapshot;
  readonly mode: Mode;
  readonly setMode: (mode: Mode) => void;
  readonly model: ModeModel;
  readonly index: ModelIndex;
  readonly selected: string | undefined;
  readonly select: (id: string | undefined) => void;
  readonly live: LiveState;
  readonly toast: (text: string, tone?: Toast["tone"]) => void;
  readonly toasts: readonly Toast[];
  readonly draft: InspectorDraft;
  readonly draftState: DraftState;
  readonly applyDraft: () => Promise<void>;
}
const StudioContext = createContext<StudioContextValue | undefined>(undefined);
export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio outside StudioProvider");
  return value;
}

export function StudioProvider(props: { readonly response: SnapshotResponse; readonly selected: string | undefined; readonly select: (id: string | undefined) => void; readonly children: ReactNode }) {
  const { response } = props;
  const query = useQueryClient();
  const [mode, setMode] = useState<Mode>(response.snapshot.currentMode);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);
  const toast = useCallback((text: string, tone: Toast["tone"] = "plain") => {
    const id = nextToast.current++;
    setToasts((current) => [...current.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), tone === "refuse" ? 9000 : 6000);
  }, []);
  const [draft] = useState(() => new InspectorDraft(response.snapshot, props.selected, mode, {
    planBatch: api.planBatch, resourcePlan: api.resourcePlan, applyBatch: api.applyBatch, resourceApply: api.resourceApply,
    snapshot: async () => { const next = await api.snapshot(); query.setQueryData(["snapshot"], next); return next.snapshot; },
  }));
  const draftState = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useLayoutEffect(() => draft.sync(response.snapshot, props.selected, mode), [draft, response.snapshot, props.selected, mode]);
  const live = useLiveUpdates((files) => toast(`${files.join(", ")} changed outside the studio. ${draft.dirty ? "Your draft is preserved; review the source conflict before applying." : "The view has been refreshed."}`));

  // Covers selection search params, view links, browser back/forward and programmatic
  // router navigation. The same session guard handles graph-mode changes below.
  const shouldBlockFn = useCallback(({ current, next }: { current: { pathname: string; search: unknown }; next: { pathname: string; search: unknown } }) => {
      if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search)) return false;
      return new Promise<boolean>((resolve) => draft.requestNavigation(() => resolve(false), () => resolve(true)));
  }, [draft]);
  useBlocker({ shouldBlockFn, enableBeforeUnload: false });
  useEffect(() => {
    if (!draft.dirty) return;
    const onExit = (event: BeforeUnloadEvent) => protectBeforeUnload(event, draft.dirty);
    window.addEventListener("beforeunload", onExit);
    return () => window.removeEventListener("beforeunload", onExit);
  }, [draft, draftState.entries]);

  const applyDraft = async () => {
    const result = await draft.apply();
    if (!result) return;
    toast(result.message);
    if ("resource" in result && result.resource !== draftState.selected) props.select(result.resource);
  };
  const snapshot = draftState.baseline;
  const model = snapshot.models[draftState.mode];
  const index = useMemo(() => indexModel(model), [model]);
  return <StudioContext.Provider value={{ response, snapshot, mode: draftState.mode,
    setMode: (next) => { if (next !== draftState.mode) draft.requestNavigation(() => setMode(next)); },
    model, index, selected: draftState.selected, select: props.select, live, toast, toasts, draft, draftState, applyDraft,
  }}>{props.children}</StudioContext.Provider>;
}
