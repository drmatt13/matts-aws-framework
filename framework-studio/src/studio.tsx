import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditIntent, PlanResponse, SnapshotResponse } from "../shared/api";
import type { Mode, ModeModel, Snapshot } from "../shared/model";
import { api, ApiError, useLiveUpdates, type LiveState } from "./api";
import { indexModel, type ModelIndex } from "./lookup";

/**
 * What every view reads: the snapshot, the graph being looked at, the
 * selection, and the two ways the studio talks back — a toast, and the edit
 * preview.
 */

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: "plain" | "refuse";
}

export interface StudioContextValue {
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
  readonly plan: PlanResponse | undefined;
  readonly preview: (intent: EditIntent) => Promise<void>;
  readonly previewRoute: (id: string, path: string) => Promise<void>;
  readonly closePreview: () => void;
  /** Close the preview because its edit was written; `landing` holds it until the next snapshot. */
  readonly landPreview: () => void;
  /** A written edit whose snapshot has not arrived yet, so a control can keep showing where it is going. */
  readonly landing: { readonly target: string; readonly field: string } | undefined;
}

/** How long a written edit may wait for its snapshot before controls show the last one again. */
const LANDING_TIMEOUT = 20_000;

const StudioContext = createContext<StudioContextValue | undefined>(undefined);

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio outside StudioProvider");
  return value;
}

export function StudioProvider(props: {
  readonly response: SnapshotResponse;
  readonly selected: string | undefined;
  readonly select: (id: string | undefined) => void;
  readonly children: ReactNode;
}) {
  const { response } = props;
  const snapshot = response.snapshot;
  const [mode, setMode] = useState<Mode>(snapshot.currentMode);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [plan, setPlan] = useState<PlanResponse | undefined>();
  const [landing, setLanding] = useState<StudioContextValue["landing"]>();
  const nextToast = useRef(1);

  const toast = useCallback((text: string, tone: Toast["tone"] = "plain") => {
    const id = nextToast.current++;
    setToasts((current) => [...current.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), tone === "refuse" ? 9000 : 6000);
  }, []);

  const live = useLiveUpdates((files) => {
    toast(`${files.join(", ")} changed outside the studio. The view has been refreshed.`);
  });

  // A refresh expires an open preview on the server; close it here too. It also
  // carries any written edit, so nothing is landing any more.
  const revision = snapshot.revision;
  useEffect(() => {
    setPlan((current) => (current ? undefined : current));
    setLanding(undefined);
  }, [revision]);
  useEffect(() => {
    if (!landing) return;
    const timer = window.setTimeout(() => setLanding(undefined), LANDING_TIMEOUT);
    return () => window.clearTimeout(timer);
  }, [landing]);

  const preview = useCallback(
    async (intent: EditIntent) => {
      try {
        setPlan(await api.plan(intent, snapshot.revision));
      } catch (error) {
        toast(error instanceof ApiError ? error.message : String(error), "refuse");
      }
    },
    [snapshot.revision, toast],
  );

  const previewRoute = useCallback(async (id: string, path: string) => {
    try { setPlan(await api.planRoute(id, path, snapshot.revision)); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), "refuse"); }
  }, [snapshot.revision, toast]);

  const model = snapshot.models[mode];
  const index = useMemo(() => indexModel(model), [model]);
  const value: StudioContextValue = {
    response,
    snapshot,
    mode,
    setMode,
    model,
    index,
    selected: props.selected,
    select: props.select,
    live,
    toast,
    toasts,
    plan,
    preview,
    previewRoute,
    closePreview: () => setPlan(undefined),
    landPreview: () => {
      if (plan) setLanding({ target: plan.target, field: plan.field });
      setPlan(undefined);
    },
    landing,
  };
  return <StudioContext.Provider value={value}>{props.children}</StudioContext.Provider>;
}
