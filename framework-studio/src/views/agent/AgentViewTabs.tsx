import { useRef } from "react";

export type AgentView = "conversation" | "sightline";
const views: readonly { readonly id: AgentView; readonly label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "sightline", label: "Sightline" },
];
/** A second tier beside the bordered panel modes: the selected view takes the wash alone. */
const tabClasses = "inline-flex min-h-7 flex-none cursor-pointer items-center whitespace-nowrap rounded-md border-0 bg-transparent px-2 font-sans text-label font-medium leading-[1.5] text-graphite hover:bg-wash hover:text-ink focus-visible:outline-offset-[-2px] aria-selected:bg-wash aria-selected:text-ink";

/** Stands in the bar, outside the lazily loaded panels it controls. */
export function AgentViewTabs({ view, onChange }: { readonly view: AgentView; readonly onChange: (view: AgentView) => void }) {
  const tabs = useRef<HTMLDivElement>(null);
  const select = (next: AgentView) => {
    onChange(next);
    tabs.current?.querySelector<HTMLButtonElement>(`#agent-${next}-tab`)?.focus();
  };
  return <div ref={tabs} role="tablist" aria-label="Agent view" className="flex items-center gap-1" onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    select(event.key === "Home" ? "conversation" : event.key === "End" ? "sightline" : view === "conversation" ? "sightline" : "conversation");
  }}>
    {views.map(({ id, label }) => <button key={id} type="button" role="tab" id={`agent-${id}-tab`} aria-controls={`agent-${id}-view`} aria-selected={view === id} tabIndex={view === id ? 0 : -1} className={tabClasses} onClick={() => onChange(id)}>{label}</button>)}
  </div>;
}
