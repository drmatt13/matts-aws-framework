import { Bot, Container, KeyRound, Layers3, Network, Plus, Route, SquareFunction, Workflow, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

const options = [
  { label: "Function", icon: SquareFunction },
  { label: "Stack", icon: Layers3 },
  { label: "VPC", icon: Network },
  { label: "Workflow", icon: Workflow },
  { label: "Container service", icon: Container },
  { label: "Container task", icon: Container },
  { label: "API route", icon: Route },
  { label: "Agent", icon: Bot },
  { label: "Input parameter", icon: Plus },
  { label: "Secret", icon: KeyRound },
];

/** A placeholder for creating declarations from the isometric map. */
export function AddMenu() {
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
    <div className="landscape-add" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      {open ? (
        <div className="landscape-add-menu" id={id} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
          <div className="landscape-add-heading">
            <h2 id={`${id}-title`}>Add to application</h2>
            <button ref={close} className="landscape-add-close" aria-label="Close add menu" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} aria-hidden /></button>
          </div>
          <p id={`${id}-description`}>Choose what to add. Creation tools are coming soon.</p>
          <div className="landscape-add-options">
            {options.map(({ label, icon: Icon }) => (
              <button key={label} disabled><Icon size={18} aria-hidden /><span>{label}</span></button>
            ))}
          </div>
        </div>
      ) : null}
      <button ref={trigger} className="landscape-add-trigger" aria-label="Add to application" title="Add to application" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
        <Plus size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
