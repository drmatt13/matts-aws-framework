import { Bot, Container, KeyRound, Layers3, Network, Plus, Route, SquareFunction, Workflow, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { CREATORS, type CreationKind } from "../../shared/creation";
import { useStudio } from "../studio";
import { CreationWizard } from "./CreationWizard";

const options = [
  { kind: "function", icon: SquareFunction },
  { kind: "stack", icon: Layers3 },
  { kind: "vpc", icon: Network },
  { kind: "workflow", icon: Workflow },
  { kind: "service", icon: Container },
  { kind: "task", icon: Container },
  { kind: "route", icon: Route },
  { kind: "agent", icon: Bot },
  { kind: "input", icon: Plus },
  { kind: "secret", icon: KeyRound },
] satisfies { kind: CreationKind; icon: typeof Plus }[];

/** Creation shares the Inspector's guarded draft and complete diff review. */
export function AddMenu() {
  const { draft, draftState } = useStudio();
  const [choosing, setChoosing] = useState(false);
  const creation = draft.creation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <><div className="landscape-add" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      {open ? (
        <div className="landscape-add-menu" id={id} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
          <div className="landscape-add-heading">
            <h2 id={`${id}-title`}>Add to application</h2>
            <button ref={close} className="landscape-add-close" aria-label="Close add menu" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} aria-hidden /></button>
          </div>
          <p id={`${id}-description`}>Choose what to add, configure it, then review the source changes.</p>
          <div className="landscape-add-options">
            {options.map(({ kind, icon: Icon }) => (
              <button key={kind} disabled={Object.values(draftState.baseline.models).some((model) => model.stale || model.status === "error")} title={Object.values(draftState.baseline.models).some((model) => model.stale || model.status === "error") ? "Fix the configuration errors before creating resources." : CREATORS[kind].help} onClick={() => {
                const start = () => { draft.beginCreation(kind); setChoosing(false); setOpen(false); };
                if (creation?.resourceKind === kind) start(); else draft.requestNavigation(start);
              }}><Icon size={18} aria-hidden /><span>{CREATORS[kind].label}</span></button>
            ))}
          </div>
        </div>
      ) : null}
      <button ref={trigger} className="landscape-add-trigger" aria-label="Add to application" title="Add to application" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
        const show = () => { setChoosing(true); setOpen((value) => !value); };
        if (creation) show(); else draft.requestNavigation(show);
      }}>
        <Plus size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </div>{creation && !choosing ? <CreationWizard entry={creation} back={() => { setChoosing(true); setOpen(true); }} /> : null}</>
  );
}
