import { useId, useState } from "react";
import { cx } from "../../ui/classes";

/** A visual prototype only. It deliberately has no runtime API or persisted state. */
export function ComposePreview({ motion }: { readonly motion: boolean }) {
  const [on, setOn] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const descriptionId = useId();

  return (
    <div className="pointer-events-auto max-w-full">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Docker Compose"
        aria-describedby={descriptionId}
        title="Visual preview only · no containers are started or stopped"
        data-ui="compose-preview"
        onClick={() => {
          setInteracted(true);
          setOn((current) => !current);
        }}
        className={cx(
          "group relative flex min-h-16 w-60 max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-3 py-2 text-left font-sans backdrop-blur-[12px] transition-[border-color,background-color,box-shadow] duration-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-map-focus forced-colors:border-[ButtonText]",
          on
            ? "border-map-compose/50 bg-map-panel/95 shadow-[0_0_28px_#f26b7814,inset_0_1px_0_#ffffff08] hover:border-map-compose/75"
            : "border-map-rule/80 bg-map-surface/95 shadow-[0_4px_16px_#0003,inset_0_1px_0_#ffffff06] hover:border-map-muted/70 hover:bg-map-panel/95",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "relative flex h-11 w-11 shrink-0 items-center justify-center transition-colors duration-300",
            on ? "text-map-compose" : "text-map-muted group-hover:text-map-text",
          )}
        >
          <span
            className={cx(
              "absolute inset-0 rounded-full bg-map-compose/10 blur-md transition-opacity duration-500",
              on ? "opacity-100" : "opacity-0",
            )}
          />
          <svg viewBox="0 0 64 48" fill="none" className="relative h-10 w-12 overflow-visible">
            <g className={cx(on && motion && "animate-compose-float motion-reduce:animate-none")}>
              <g
                className={cx(
                  "origin-center",
                  on
                    ? motion && "animate-compose-surface motion-reduce:animate-none"
                    : "transform-[translateY(3px)_rotate(-6deg)]",
                  !on && interacted && motion && "animate-compose-settle motion-reduce:animate-none",
                )}
              >
                {/* Stacked cargo and a generous curved hull keep the whale readable at 40px. */}
                <g fill="currentColor">
                  <rect x="25" y="8" width="7" height="7" rx="1.2" />
                  <rect x="16" y="17" width="7" height="7" rx="1.2" />
                  <rect x="25" y="17" width="7" height="7" rx="1.2" />
                  <rect x="34" y="17" width="7" height="7" rx="1.2" />
                  <rect x="7" y="17" width="7" height="7" rx="1.2" />
                  <path d="M5 27h36c4 0 7-1 9-3-2-3-2-6-1-9 4 1 6 4 6 7 3-1 6-1 8 0-1 4-5 6-10 6-4 11-13 16-26 16C14 44 6 38 5 27Z" />
                </g>
                <path d="M10 32c2 5 7 8 14 8" stroke="var(--color-map-surface)" strokeOpacity=".3" strokeWidth="1.5" strokeLinecap="round" />
                {on ? (
                  <circle cx="38" cy="31" r="1.6" className="fill-map-surface" />
                ) : (
                  <path d="m35 32 2 1 3-1" className="stroke-map-surface" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </g>
            </g>
            <path
              d="M10 47h9m5 0h18"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              className={cx("transition-opacity duration-500", on ? "opacity-35" : "opacity-0")}
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1 whitespace-nowrap text-label leading-none font-medium text-map-ink">Docker Compose</span>
        <span aria-hidden className="flex shrink-0 flex-col items-center gap-1.5">
          <span
            className={cx(
              "relative h-4 w-7 rounded-full border transition-colors duration-300 forced-colors:border-[ButtonText]",
              on ? "border-map-compose/70 bg-map-compose/20" : "border-map-rule bg-map-ground",
            )}
          >
            <span
              className={cx(
                "absolute top-[2px] left-[2px] size-2.5 rounded-full transition-[translate,background-color] duration-300 forced-colors:bg-[ButtonText]",
                on ? "translate-x-3 bg-map-compose" : "translate-x-0 bg-map-muted",
              )}
            />
          </span>
          <span className={cx("text-micro leading-none", on ? "text-map-compose" : "text-map-muted")}>{on ? "On" : "Off"}</span>
        </span>
      </button>
      <span id={descriptionId} className="sr-only">Visual preview only. No containers are started or stopped.</span>
    </div>
  );
}
