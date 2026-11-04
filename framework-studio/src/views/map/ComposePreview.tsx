import { useId, useState, type CSSProperties } from "react";
import { cx } from "../../ui/classes";

/*
 * Motion. Every state change is a CSS transition with per-part delays, so a second
 * click mid-flight reverses each part from wherever it is instead of snapping.
 * Turning on is one sequence of about 900ms: the water rises, the whale surfaces,
 * the containers load onto its back, and it spouts. Turning off is quicker and
 * runs in reverse. Keyframes are only the idle loops and one-shot accents.
 */
const EXPO_OUT = "cubic-bezier(.16,1,.3,1)";
const EASE_IN = "cubic-bezier(.5,0,.75,0)";
const IN_OUT = "cubic-bezier(.65,0,.35,1)";
const SPRING = "var(--spring)";
const BOUNCE = "var(--spring-bounce)";

/** Container positions on the whale's back, in loading order: bottom row left to right, then the top row. */
const CARGO = [[12.1, 17.9], [18.04, 17.9], [23.98, 17.9], [29.92, 17.9], [18.04, 11.96], [23.98, 11.96]] as const;
const LOAD_AT = 240;
const LOAD_STAGGER = 55;
const UNLOAD_STAGGER = 28;
/** Horizontal drift of each spout droplet, in SVG units. */
const SPOUT = [-2.6, 0.4, 3] as const;
const WAVE = "q5.5-1.6 11 0t11 0t11 0t11 0t11 0t11 0t11 0t11 0V44H-44Z";
const SWELL = "q5.5 1.4 11 0t11 0t11 0t11 0t11 0t11 0t11 0t11 0V44H-44Z";
const HULL =
  "M11 23.4H33C37.18 23.4 39.38 25.49 39.38 28.35C39.38 33.63 33.44 37.26 24.86 37.26C17.38 37.26 12.54 34.4 10.45 30C7.48 29.89 4.73 27.8 3.74 22.96C3.63 22.3 4.18 21.86 4.73 22.08C7.04 22.96 9.02 23.4 11 23.4Z";
/** Rotation and bobbing pivot on the waterline, in viewBox units. */
const PIVOT = "[transform-box:view-box] origin-[22px_30px]";

const timing = (on: boolean, whenOn: string, whenOff: string): CSSProperties => ({ transition: on ? whenOn : whenOff });

/** A visual prototype only. It deliberately has no runtime API or persisted state. */
export function ComposePreview({ motion }: { readonly motion: boolean }) {
  const [on, setOn] = useState(false);
  // Remounts the one-shot accents so each turn-on plays them once.
  const [launches, setLaunches] = useState(0);
  // The hover spout waits until the pointer has left after a turn-on, so the click itself never plays it.
  const [armed, setArmed] = useState(false);
  const descriptionId = useId();
  const loops = motion && cx(!on && "[animation-play-state:paused]");

  return (
    <div className="pointer-events-auto max-w-full">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Local runtime"
        aria-describedby={descriptionId}
        title="Visual preview only · no containers are started or stopped"
        data-ui="compose-preview"
        data-state={on ? "on" : "off"}
        data-motion={motion ? "on" : "off"}
        onClick={() => {
          if (!on) {
            setLaunches((count) => count + 1);
            setArmed(false);
          }
          setOn(!on);
        }}
        onPointerLeave={() => setArmed(true)}
        className={cx(
          "group/compose relative isolate flex h-14 max-w-full min-w-[236px] cursor-pointer items-center gap-3 rounded-[16px] border py-[5px] pr-3.5 pl-[5px] text-left font-sans backdrop-blur-[12px] select-none",
          "scale-100 [transition:scale_440ms_var(--spring),border-color_300ms,background-color_300ms,box-shadow_700ms_cubic-bezier(.16,1,.3,1)] active:scale-[.975] active:[transition:scale_120ms_cubic-bezier(.3,0,.5,1)]",
          "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-map-focus forced-colors:border-[ButtonText]",
          on
            ? "border-map-compose/45 bg-map-panel/95 shadow-compose hover:border-map-compose/75"
            : "border-map-rule/80 bg-map-surface/95 shadow-[0_4px_16px_#0003,inset_0_1px_0_#ffffff06] hover:border-map-muted/60 hover:bg-map-panel/95",
          !motion && "active:scale-100 [&_*]:transition-none! [&_*]:animate-none!",
          "motion-reduce:active:scale-100 motion-reduce:[&_*]:animate-none!",
        )}
      >
        {/* Light from the water spills onto the card. */}
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-radial-[150px_64px_at_27px_50%] from-map-compose/15 to-transparent to-72% transition-opacity duration-700",
            on ? "opacity-100" : "opacity-0",
          )}
        />
        {/* One band of light runs once around the border on each turn-on. */}
        {motion && launches > 0 ? (
          <span
            aria-hidden
            className={cx("pointer-events-none absolute -inset-px rounded-[inherit] transition-opacity duration-200", on ? "opacity-100" : "opacity-0")}
          >
            <span
              key={launches}
              data-slot="compose-launch"
              className="absolute inset-0 animate-compose-sweep rounded-[inherit] bg-conic-[from_var(--compose-sweep)] from-transparent via-map-compose-light via-18% to-transparent to-26% p-px [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)]"
              style={{ animationDelay: "260ms" }}
            />
          </span>
        ) : null}

        {/* The porthole: radius 10 sits concentric inside the card's 16 at a 6px inset. */}
        <span aria-hidden className="relative size-11 shrink-0 overflow-hidden rounded-[10px] bg-map-ground">
          <span
            className={cx(
              "absolute inset-0 bg-radial-[130%_80%_at_50%_108%] from-map-compose-deep/30 to-transparent to-70% transition-opacity duration-700",
              on ? "opacity-100" : "opacity-0",
            )}
          />
          <svg
            viewBox="0 0 44 44"
            fill="none"
            className={cx(
              "absolute inset-0 size-full transition-colors duration-300 forced-colors:text-[CanvasText]",
              on ? "text-map-compose" : "text-map-compose-off group-hover/compose:text-map-compose-off-hover",
            )}
          >
            <g className={on ? "translate-y-0" : "translate-y-[14px]"} style={timing(on, `translate 560ms ${EXPO_OUT} 30ms`, `translate 420ms ${EASE_IN} 180ms`)}>
              <path className={cx("fill-map-compose-deep/50", motion && "animate-compose-drift", loops)} d={`M-44 31.6${WAVE}`} />
            </g>
            {/* Rings spread across the water behind the whale as it breaks the surface. */}
            {motion && on && launches > 0 ? (
              <g key={launches} data-slot="compose-launch" className="stroke-map-compose-light" strokeWidth=".7">
                {[320, 480].map((delay) => (
                  <ellipse
                    key={delay}
                    cx="22"
                    cy="31.8"
                    rx="16"
                    ry="2.6"
                    className="origin-center animate-compose-ripple [transform-box:fill-box]"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </g>
            ) : null}
            <g className={cx(PIVOT, motion && "animate-compose-bob", loops)}>
              <g
                className={cx(
                  PIVOT,
                  on
                    ? "translate-y-0 rotate-0"
                    : "translate-y-[3.5px] -rotate-5 group-hover/compose:translate-y-[2.5px] group-hover/compose:-rotate-[3.5deg]",
                )}
                style={timing(on, `translate 820ms ${BOUNCE} 120ms, rotate 900ms ${BOUNCE} 120ms`, `translate 520ms ${IN_OUT}, rotate 560ms ${IN_OUT}`)}
              >
                <path fill="currentColor" d={HULL} />
                {/* Empty berths keep the stack's outline readable while nothing is loaded. */}
                <g
                  stroke="currentColor"
                  strokeWidth=".8"
                  className={on ? "opacity-0" : "opacity-100"}
                  style={timing(on, "opacity 200ms linear 700ms", "opacity 260ms linear 120ms")}
                >
                  {CARGO.map(([x, y]) => (
                    <rect key={`${x},${y}`} x={x + 0.44} y={y + 0.44} width="3.96" height="3.96" rx=".77" />
                  ))}
                </g>
                {CARGO.map(([x, y], index) => {
                  const load = LOAD_AT + index * LOAD_STAGGER;
                  const unload = (CARGO.length - 1 - index) * UNLOAD_STAGGER;
                  return (
                    <rect
                      key={`${x},${y}`}
                      x={x}
                      y={y}
                      width="4.84"
                      height="4.84"
                      rx=".88"
                      className={cx("fill-map-compose", on ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0")}
                      style={timing(
                        on,
                        `translate 640ms ${BOUNCE} ${load}ms, opacity 140ms linear ${load}ms`,
                        `translate 240ms ${EASE_IN} ${unload}ms, opacity 200ms linear ${unload + 40}ms`,
                      )}
                    />
                  );
                })}
                <circle cx="34.32" cy="28.02" r="1.1" className="fill-map-surface" />
                <path d="M14.3 32.64C16.72 35.28 20.24 36.16 24.2 36.16" className="stroke-map-surface" strokeOpacity=".35" strokeWidth="1" strokeLinecap="round" />
                {motion && on && launches > 0 ? (
                  <g key={launches} data-slot="compose-launch" className="fill-map-compose-light">
                    {SPOUT.map((drift, index) => (
                      <circle
                        key={drift}
                        cx="36.74"
                        cy="22.52"
                        r="1.15"
                        className="origin-center animate-compose-spout [transform-box:fill-box]"
                        style={{ "--spout-x": `${drift}px`, animationDelay: `${720 + index * 60}ms` } as CSSProperties}
                      />
                    ))}
                  </g>
                ) : null}
                {motion && on && armed ? (
                  <g data-slot="compose-hover-spout" className="fill-map-compose-light">
                    {SPOUT.map((drift, index) => (
                      <circle
                        key={drift}
                        cx="36.74"
                        cy="22.52"
                        r="1.15"
                        className="origin-center opacity-0 [transform-box:fill-box] group-hover/compose:animate-compose-spout"
                        style={{ "--spout-x": `${drift}px`, animationDelay: `${index * 60}ms` } as CSSProperties}
                      />
                    ))}
                  </g>
                ) : null}
              </g>
            </g>
            {/* The near swell passes in front of the hull, so the whale sits in the water rather than on it. */}
            <g className={on ? "translate-y-0" : "translate-y-[14px]"} style={timing(on, `translate 560ms ${EXPO_OUT} 70ms`, `translate 400ms ${EASE_IN} 140ms`)}>
              <path className={cx("fill-map-compose/30", motion && "animate-compose-drift [animation-direction:reverse]", loops)} d={`M-44 34.2${SWELL}`} />
            </g>
          </svg>
          <span
            className={cx(
              "pointer-events-none absolute inset-0 rounded-[inherit] inset-ring transition-shadow duration-500",
              on ? "inset-ring-map-compose/30" : "inset-ring-map-rule/60",
            )}
          />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate text-label leading-none font-medium text-map-ink">Local runtime</span>
          {/* The status rolls up when turning on and back down when turning off. */}
          <span aria-hidden className="grid text-caption leading-none">
            <span
              data-slot="compose-status"
              data-current={!on}
              className={cx("col-start-1 row-start-1 text-map-muted", on ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100")}
              style={timing(on, `opacity 120ms linear, translate 260ms ${EXPO_OUT}`, `opacity 220ms linear 160ms, translate 440ms ${SPRING} 160ms`)}
            >
              Stopped
            </span>
            <span
              data-slot="compose-status"
              data-current={on}
              className={cx("col-start-1 row-start-1 text-map-compose", on ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}
              style={timing(on, `opacity 220ms linear 300ms, translate 440ms ${SPRING} 300ms`, `opacity 120ms linear, translate 260ms ${EXPO_OUT}`)}
            >
              Running
            </span>
          </span>
        </span>

        {/* The knob stretches under a press and springs across on release. */}
        <span
          aria-hidden
          className={cx(
            "relative h-[22px] w-[38px] shrink-0 rounded-full inset-ring transition-[background-color,box-shadow] duration-200 forced-colors:border forced-colors:border-[ButtonText]",
            on
              ? "bg-map-compose shadow-compose-glow inset-ring-white/12 forced-colors:bg-[Highlight]"
              : "bg-map-ground inset-ring-map-rule group-hover/compose:inset-ring-map-muted/50",
          )}
        >
          <span
            className={cx(
              "absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-map-ink shadow-[0_1px_3px_#0008,0_0_0_.5px_#0000002e] [transition:translate_440ms_var(--spring),width_240ms_var(--spring)] group-active/compose:w-[22px] forced-colors:bg-[ButtonText]",
              on ? "translate-x-4 group-active/compose:translate-x-3" : "translate-x-0",
            )}
          />
        </span>
      </button>
      <span id={descriptionId} className="sr-only">Visual preview only. No containers are started or stopped.</span>
    </div>
  );
}
