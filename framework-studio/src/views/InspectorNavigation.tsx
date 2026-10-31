import { ChevronLeft, PanelRight } from "lucide-react";
import type { Ref } from "react";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";

/** The same contextual trail in the map panel and the standalone inspector. */
export function InspectorNavigationControls({
  onResources,
  buttonRef,
}: {
  readonly onResources?: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { inspectorNavigation } = useStudio();
  const previous = inspectorNavigation.previous;
  if (!previous && !onResources) return <span>Inspector</span>;
  const label = previous?.label ?? "Resources";
  return (
    <>
      <button
        ref={buttonRef}
        data-ui="workspace-panel-back"
        className="-ml-2 inline-flex min-h-(--control-height-sm) min-w-0 cursor-pointer items-center gap-0.5 rounded-md border-0 bg-transparent py-0 pr-2 pl-1 font-sans text-label leading-none font-semibold text-ink hover:bg-wash coarse:min-h-11"
        onClick={previous ? inspectorNavigation.back : onResources}
        aria-label={`Back to ${label}`}
        title={`Back to ${label}`}
      >
        <ChevronLeft size={16} className="shrink-0 text-graphite" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {previous && onResources ? (
        <button
          className={buttonClasses({
            variant: "link",
            className:
              "ml-auto inline-flex min-h-(--control-height-sm) shrink-0 items-center gap-1 text-caption text-graphite coarse:min-h-11",
          })}
          onClick={onResources}
          aria-label="Back to Resources"
          title="Back to Resources"
        >
          <PanelRight size={14} aria-hidden />
          Resources
        </button>
      ) : null}
    </>
  );
}
