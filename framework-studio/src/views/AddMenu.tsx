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
  { kind: "tool", icon: SquareFunction },
  { kind: "input", icon: Plus },
  { kind: "secret", icon: KeyRound },
] satisfies { kind: CreationKind; icon: typeof Plus }[];

/** Creation shares the Inspector's guarded draft and complete diff review. */
export function AddMenu({ presentation = "floating" }: { readonly presentation?: "floating" | "toolbar" }) {
  const { draft, draftState, live } = useStudio();
  const [choosing, setChoosing] = useState(false);
  const creation = draft.creation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();
  const unavailable = Object.values(draftState.baseline.models).some((model) => model.stale || model.status === "error");
  const disabled = unavailable || !!draftState.busy || live.evaluating;

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
    <><div className={`landscape-add ${presentation === "toolbar" ? "studio-add-toolbar" : ""}`} ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      {open ? (
        <div className="landscape-add-menu" id={id} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
          <div className="landscape-add-heading">
            <h2 id={`${id}-title`}>Add to application</h2>
            <button ref={close} className="icon-button landscape-add-close" aria-label="Close add menu" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} aria-hidden /></button>
          </div>
          <p id={`${id}-description`}>Choose what to add, configure it, then review the source changes.</p>
          {disabled ? <p className="reason" role="status">{unavailable ? "Fix the configuration errors in Configuration health before adding resources." : "Wait for the current validation to finish before adding a resource."}</p> : null}
          <div className="landscape-add-options" onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const current = items.indexOf(event.target as HTMLButtonElement);
            if (current < 0) return;
            const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 };
            const movement = moves[event.key];
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : movement === undefined ? undefined : (current + movement + items.length) % items.length;
            if (next === undefined) return;
            event.preventDefault();
            items[next]?.focus();
          }}>
            {options.map(({ kind, icon: Icon }) => (
              <button key={kind} disabled={disabled} title={CREATORS[kind].help} onClick={() => {
                const start = () => { draft.beginCreation(kind); setChoosing(false); setOpen(false); };
                if (creation?.resourceKind === kind) start(); else draft.requestNavigation(start);
              }}><Icon size={18} aria-hidden /><span>{CREATORS[kind].label}</span></button>
            ))}
          </div>
        </div>
      ) : null}
      <button ref={trigger} className={presentation === "toolbar" ? "quiet studio-add-button" : "landscape-add-trigger"} aria-label="Add to application" title="Add to application" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
        const show = () => { setChoosing(true); setOpen((value) => !value); };
        if (creation) show(); else draft.requestNavigation(show);
      }}>
        <Plus size={presentation === "toolbar" ? 16 : 20} strokeWidth={1.75} aria-hidden />
        {presentation === "toolbar" ? <span>Add to application</span> : null}
      </button>
    </div>{creation && !choosing ? <CreationWizard entry={creation} back={() => { setChoosing(true); setOpen(true); }} /> : null}</>
  );
}
