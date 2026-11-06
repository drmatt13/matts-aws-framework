import { lazy, Suspense } from "react";
import type { AgentChat } from "../agent-chat";
import { AgentPanel } from "../views/agent/AgentPanel";
import type { AgentView } from "../views/agent/AgentViewTabs";

const SightlineView = lazy(() => import("./SightlineView").then(module => ({ default: module.SightlineView })));
const CodingPanel = lazy(() => import("../views/agent/CodingPanel").then(module => ({ default: module.CodingPanel })));

/** Display only: the bar owns the view choice. Context subscriptions belong to the visible Sightline or Coding consumer. */
export function AgentViews({ chat, visible, view }: { chat: AgentChat; visible: boolean; view: AgentView }) {
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sheet">
    <div role="tabpanel" id="agent-conversation-view" aria-labelledby="agent-conversation-tab" hidden={view !== "conversation"} inert={view !== "conversation"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentPanel chat={chat} visible={visible && view === "conversation"} />
    </div>
    <div role="tabpanel" id="agent-sightline-view" aria-labelledby="agent-sightline-tab" hidden={view !== "sightline"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {visible && view === "sightline" ? <Suspense fallback={<p role="status" className="m-4 text-caption text-graphite">Opening Sightline…</p>}><SightlineView /></Suspense> : null}
    </div>
    <div role="tabpanel" id="agent-coding-view" aria-labelledby="agent-coding-tab" hidden={view !== "coding"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {visible && view === "coding" ? <Suspense fallback={<p role="status" className="m-4 text-caption text-graphite">Opening coding tasks…</p>}><CodingPanel visible /></Suspense> : null}
    </div>
  </div>;
}
