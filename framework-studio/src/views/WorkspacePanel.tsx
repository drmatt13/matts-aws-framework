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
    <aside id={props.id} className="workspace-panel" aria-label={props.label}>
      <header className="workspace-panel-header">
        <div className="workspace-panel-heading">{props.heading}</div>
        <button className="icon-button" onClick={props.onClose} aria-label="Close panel" title="Close panel">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className={`workspace-panel-body ${props.bodyClassName}`}>{props.children}</div>
    </aside>
  );
}
