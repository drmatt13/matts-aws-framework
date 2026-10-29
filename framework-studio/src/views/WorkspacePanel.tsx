import { iconButtonClasses } from "../ui/IconButton";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The map's one contextual panel. It sits below the workspace toolbar at a fixed width and
 * hosts one view at a time; each view owns its content and scrolling, while the shell owns
 * the landmark, the header row and the close control. Changing views keeps this element,
 * so the map beside it does not resize.
 */
export function WorkspacePanel(props: {
  readonly id: string;
  /** Names the landmark after the view it shows. */
  readonly label: string;
  /** The view's title, or its way back. */
  readonly heading: ReactNode;
  readonly bodyClassName: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <aside id={props.id} data-ui="workspace-panel" className="flex min-h-0 min-w-0 w-(--inspector) flex-[0_0_var(--inspector)] flex-col border-l border-rule bg-sheet text-ink vp-800:min-h-65 vp-800:w-auto vp-800:flex-[0_1_55%] vp-800:border-t vp-800:border-l-0" aria-label={props.label}>
      <header data-ui="workspace-panel-header" className="flex min-h-[44px] flex-none items-center gap-2 border-b border-rule py-1 pr-3 pl-(--panel-padding)">
        <div data-ui="workspace-panel-heading" className="flex min-w-0 flex-1 items-center gap-2">{props.heading}</div>
        <button className={iconButtonClasses({ variant: "quiet", className: "text-graphite" })} onClick={props.onClose} aria-label="Close panel" title="Close panel">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div data-inspector-context={props.label === "Inspector" || undefined} data-ui="workspace-panel-body" className={`flex min-h-0 flex-1 flex-col ${props.bodyClassName}`}>{props.children}</div>
    </aside>
  );
}
