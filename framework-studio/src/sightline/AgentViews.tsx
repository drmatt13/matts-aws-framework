import { lazy, Suspense, useRef, useState } from "react";
import type { AgentChat } from "../agent-chat";
import { AgentPanel } from "../views/agent/AgentPanel";
import { navigationItemClasses } from "../views/NavigationStrip";

const SightlineView = lazy(() => import("./SightlineView").then(module => ({ default: module.SightlineView })));

/** Display state only. Route and Studio subscriptions belong to the visible Sightline. */
export function AgentViews({ chat, visible, onConversationVisibilityChange }: { chat: AgentChat; visible: boolean; onConversationVisibilityChange: (visible: boolean) => void }) {
  const [view, setView] = useState<"conversation" | "sightline">("conversation");
  const selectView = (next: typeof view) => {
    setView(next);
    onConversationVisibilityChange(next === "conversation");
  };
  const conversation = useRef<HTMLButtonElement>(null);
  const sightline = useRef<HTMLButtonElement>(null);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sheet">
    <div role="tablist" aria-label="Agent view" className="flex flex-none gap-1 border-b border-rule px-3 py-1" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? "conversation" : event.key === "End" ? "sightline" : view === "conversation" ? "sightline" : "conversation";
      selectView(next);
      (next === "conversation" ? conversation : sightline).current?.focus();
    }}>
      <button ref={conversation} type="button" role="tab" id="agent-conversation-tab" aria-controls="agent-conversation-view" aria-selected={view === "conversation"} tabIndex={view === "conversation" ? 0 : -1} data-status={view === "conversation" ? "active" : undefined} className={navigationItemClasses} onClick={() => selectView("conversation")}>Conversation</button>
      <button ref={sightline} type="button" role="tab" id="agent-sightline-tab" aria-controls="agent-sightline-view" aria-selected={view === "sightline"} tabIndex={view === "sightline" ? 0 : -1} data-status={view === "sightline" ? "active" : undefined} className={navigationItemClasses} onClick={() => selectView("sightline")}>Sightline</button>
    </div>
    <div role="tabpanel" id="agent-conversation-view" aria-labelledby="agent-conversation-tab" hidden={view !== "conversation"} inert={view !== "conversation"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentPanel chat={chat} visible={visible && view === "conversation"} />
    </div>
    <div role="tabpanel" id="agent-sightline-view" aria-labelledby="agent-sightline-tab" hidden={view !== "sightline"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {visible && view === "sightline" ? <Suspense fallback={<p role="status" className="m-4 text-caption text-graphite">Opening Sightline…</p>}><SightlineView /></Suspense> : null}
    </div>
  </div>;
}
