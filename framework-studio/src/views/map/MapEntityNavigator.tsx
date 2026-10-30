import type { FocusEventHandler, KeyboardEventHandler, PointerEventHandler } from "react";
import { missingConnectionInput } from "../../connections";
import { presentConnection } from "../../connection-presentation";
import { endpointLabel, type ModelIndex } from "../../lookup";
import type { Scene } from "../../scene/types";

interface MapEntityNavigatorProps {
  readonly scene: Scene;
  readonly index: ModelIndex;
  readonly selected: string | undefined;
  readonly onInspect: (id: string) => void;
  readonly onPointerDownCapture: PointerEventHandler<HTMLUListElement>;
  readonly onFocusCapture: FocusEventHandler<HTMLUListElement>;
  readonly onBlurCapture: FocusEventHandler<HTMLUListElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLUListElement>;
}

/** The keyboard view of the scene. Isometric owns focus, previews and memoization. */
export function MapEntityNavigator({ scene, index, selected, onInspect, onPointerDownCapture, onFocusCapture, onBlurCapture, onKeyDown }: MapEntityNavigatorProps) {
  return (
    <ul data-ui="landscape-entity-list" className="-m-px h-px w-px overflow-hidden border-0 p-0 whitespace-nowrap [clip:rect(0,0,0,0)] absolute list-none focus-within:bottom-16 focus-within:left-4 focus-within:z-6 focus-within:m-0 focus-within:h-auto focus-within:max-h-[min(420px,55%)] focus-within:w-[min(360px,calc(100%-32px))] focus-within:overflow-auto focus-within:overscroll-contain focus-within:rounded-lg focus-within:border focus-within:border-map-rule focus-within:bg-map-panel focus-within:p-3 focus-within:whitespace-normal focus-within:text-map-ink focus-within:shadow-popover focus-within:[clip:auto] [&_li]:m-0 [&_button]:block [&_button]:min-h-(--control-height) [&_button]:w-full [&_button]:cursor-pointer [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:p-2 [&_button]:text-left [&_button]:text-caption [&_button]:text-inherit [&_button]:wrap-anywhere [&_button:hover]:bg-map-row [&_button[aria-current=true]]:bg-map-row [&_button:focus-visible]:outline-map-focus [&_button:focus-visible]:-outline-offset-2" aria-label="Entities in the landscape"
    onPointerDownCapture={onPointerDownCapture}
    onFocusCapture={onFocusCapture}
    onBlurCapture={onBlurCapture}
    onKeyDown={onKeyDown}>
      <li data-ui="landscape-entity-help" className="mb-2 grid gap-1 p-2 text-caption text-[#a3b1c4] [&_strong]:text-map-ink"><strong>Map resources and connections</strong><span>Use arrow keys or Tab to browse, Enter to inspect, Escape to return to the map.</span></li>
      {scene.edges.map((connection) => <li key={connection.id}><button data-hover-kind="edge" data-hover-id={connection.id} onClick={() => onInspect(connection.id)} aria-current={selected === connection.id}>
        {missingConnectionInput(connection) ? "Missing required value: " : "Connection: "}{endpointLabel(index, connection.from)} to {endpointLabel(index, connection.to)}, {presentConnection(connection, scene.mode, index).title}
      </button></li>)}
      {scene.islands.map((island) => <li key={island.id}><button data-hover-kind="island" data-hover-id={island.id} onClick={() => onInspect(island.id)} aria-current={selected === island.id}>{island.title} island settings</button></li>)}
      {scene.props.map((prop) => <li key={prop.id}><button data-hover-kind="prop" data-hover-id={prop.id} data-entity-id={prop.id} aria-description={prop.id} onClick={() => onInspect(prop.id)} aria-current={selected === prop.id}>{prop.label}</button></li>)}
      {scene.nodes.map((node) => <li key={node.id}><button data-hover-kind="node" data-hover-id={node.id} onClick={() => onInspect(node.id)} aria-current={selected === node.id}>
        {node.label}, {node.kindLabel}. {node.presenceText}{node.sourceProblems?.length ? ". Implementation needs attention" : ""}
      </button></li>)}
    </ul>
  );
}
