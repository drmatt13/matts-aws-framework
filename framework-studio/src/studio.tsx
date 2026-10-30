import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker, useLocation, useNavigate } from "@tanstack/react-router";
import type { SnapshotResponse } from "../shared/api";
import type { Mode, ModeModel, Snapshot } from "../shared/model";
import { api } from "./api";
import { useLiveUpdates, snapshotQueryKey, type LiveState } from "./snapshot";
import { InspectorDraft, protectBeforeUnload, type DraftState } from "./draft";
import { NamingHistory, presentedSnapshot, type DisplayNames } from "./naming";
import { remapEntity } from "../shared/naming";
import { indexModel, titleOf, type ModelIndex } from "./lookup";
import { useInspectorNavigation, type InspectorNavigation } from "./inspector-navigation";

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
  readonly inspect: (id: string, focus?: boolean) => void;
  readonly inspectorNavigation: InspectorNavigation;
  readonly live: LiveState;
  readonly toast: (text: string, tone?: Toast["tone"]) => void;
  readonly toasts: readonly Toast[];
  readonly draft: InspectorDraft;
  readonly draftState: DraftState;
  readonly entityAliases: DisplayNames;
  readonly namingRevision?: string;
  readonly created?: { readonly id: string; readonly revision: string };
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
  const navigate = useNavigate();
  const location = useLocation();
  const lastRemap = useRef<DisplayNames>({});
  const acceptedWrite = useRef<DraftState["applied"]>(undefined);
  const historySelections = useRef(new NamingHistory());
  const historyKey = String(location.state.__TSR_key ?? location.state.key ?? location.state.__TSR_index);
  // Read the key and its selection from one location. Router search subscriptions
  // may render a turn later during Back/Forward; mixing them corrupts that visit.
  const routedSelection = (location.search as { select?: string }).select;
  const query = useQueryClient();
  const [created, setCreated] = useState<{ id: string; revision: string }>();
  const [mode, setMode] = useState<Mode>("dev");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);
  const toast = useCallback((text: string, tone: Toast["tone"] = "plain") => {
    const id = nextToast.current++;
    setToasts((current) => [...current.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), tone === "refuse" ? 9000 : 6000);
  }, []);
  const [draft] = useState(() => new InspectorDraft(response.snapshot, props.selected, mode, {
    planBatch: api.planBatch, applyBatch: api.applyBatch,
    inputPlan: api.inputPlan, inputApply: api.inputApply,
    snapshot: async () => { const next = await api.snapshot(); query.setQueryData(snapshotQueryKey, next); return next.snapshot; },
    refreshSource: async () => { await api.refreshSource(); const next = await api.snapshot(); query.setQueryData(snapshotQueryKey, next); return next.snapshot; },
  }));
  const draftState = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  // Identity, source model and layout continuity become visible in one accepted write.
  if (draftState.applied && acceptedWrite.current !== draftState.applied) {
    if (draftState.applied.entityRemap) {
      historySelections.current.accept(draftState.applied.entityRemap);
      lastRemap.current = draftState.applied.entityRemap;
    }
    acceptedWrite.current = draftState.applied;
  }
  const entityAliases = lastRemap.current;
  const namingRevision = draftState.applied?.names ? draftState.applied.revision : undefined;
  const selected = historySelections.current.selection(historyKey, routedSelection);
  useLayoutEffect(() => {
    if (selected !== routedSelection) void navigate({ to: ".", search: (previous: Record<string, unknown>) => ({ ...previous, select: selected }), replace: true });
  }, [selected, routedSelection, navigate]);
  useLayoutEffect(() => draft.sync(response.snapshot, selected, mode), [draft, response.snapshot, selected, mode]);
  const snapshot = useMemo(() => presentedSnapshot(draftState.baseline), [draftState.baseline]);
  const model = snapshot.models[draftState.mode];
  const index = useMemo(() => indexModel(model), [model]);
  const inspection = useInspectorNavigation({ selected, ready: selected === draftState.selected, aliases: entityAliases,
    mode: draftState.mode, select: props.select, requestNavigation: proceed => draft.requestNavigation(proceed),
    label: id => index.displayNames[id] ?? index.resources.get(id)?.path.at(-1) ?? titleOf(index, id) });
  const live = useLiveUpdates((files) => toast(`${files.join(", ")} changed outside the studio. ${draft.dirty ? "Your draft is preserved; review the source conflict before applying." : "The view has been refreshed."}`));

  // Covers selection search params, view links, browser back/forward and programmatic
  // router navigation. The same session guard handles graph-mode changes below.
  const shouldBlockFn = useCallback(({ current, next }: { current: { pathname: string; search: unknown }; next: { pathname: string; search: unknown } }) => {
      if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search)) return false;
      // Authentication panels share one mounted workspace and source draft. A
      // subsection change does not leave that editing session or change target.
      const inAuthentication = (path: string) => path === "/cognito" || path.startsWith("/cognito/");
      if (inAuthentication(current.pathname) && inAuthentication(next.pathname) && JSON.stringify(current.search) === JSON.stringify(next.search)) return false;
      return new Promise<boolean>((resolve) => draft.requestNavigation(() => resolve(false), () => { inspection.cancel(); resolve(true); }));
  }, [draft, inspection.cancel]);
  useBlocker({ shouldBlockFn, enableBeforeUnload: false });
  useEffect(() => {
    if (!draft.dirty) return;
    const onExit = (event: BeforeUnloadEvent) => protectBeforeUnload(event, draft.dirty);
    window.addEventListener("beforeunload", onExit);
    return () => window.removeEventListener("beforeunload", onExit);
  }, [draft, draftState.entries]);

  const applyDraft = async () => {
    const authenticationProvider = draft.creation()?.resourceKind === "auth-provider";
    const result = await draft.apply();
    if (!result) return;
    toast(result.message);
    if (draft.getSnapshot().applied?.names) setCreated(undefined);
    if (result.entityRemap && Object.keys(result.entityRemap).length) {
      const remap = result.entityRemap;
      const next = selected ? remapEntity(selected, remap) : undefined;
      if (next !== routedSelection) await navigate({ to: ".", search: (previous: Record<string, unknown>) => ({ ...previous, select: next }), replace: true });
      return;
    }
    // Federation creation can return its new secret as the generic source target.
    // Keep this workflow in place without opening an inspector that reads values.
    if (authenticationProvider && result.status === "applied") { setCreated(undefined); props.select(undefined); return; }
    if (result.select) { setCreated({ id: result.select, revision: result.revision }); props.select(result.select); }
  };
  return <StudioContext.Provider value={{ response, snapshot, mode: draftState.mode,
    setMode: (next) => { if (next !== draftState.mode) draft.requestNavigation(() => setMode(next)); },
    model, index, selected: draftState.selected, select: inspection.select, inspect: inspection.inspect,
    inspectorNavigation: inspection.navigation, live, toast, toasts, draft, draftState, applyDraft, created: draftState.applied?.names ? undefined : created, entityAliases, namingRevision,
  }}>{props.children}</StudioContext.Provider>;
}
