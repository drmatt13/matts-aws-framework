import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { AlertTriangle, Check, ChevronDown, CircleDashed, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OperationRequest, PrerequisiteView } from "../../../shared/deploy";

/** Machine checks stay local; the global Source menu owns AWS connection details. */
export function AccountBar(props: {
  readonly prerequisites: readonly PrerequisiteView[];
  readonly onRemedy: (request: OperationRequest) => void;
}) {
  const [showReady, setShowReady] = useState(false);
  const readyId = useId();
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 12 });
  const ready = props.prerequisites.filter((item) => item.status === "ok");
  const attention = props.prerequisites.filter((item) => item.status !== "ok");
  const positionPanel = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(340, window.innerWidth - 24);
    setPosition({
      top: anchor.bottom + 8,
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
    });
  }, []);
  useEffect(() => {
    if (!showReady) return;
    if (!ready.length) {
      panel.current?.hidePopover?.();
      return;
    }
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [showReady, ready.length, positionPanel]);
  return (
    <section className="px-4 py-3 text-label text-ink" aria-label="Machine readiness">
      {props.prerequisites.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {ready.length ? (
            <button
              ref={trigger}
              type="button"
              className="group/machine inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-caption text-graphite hover:text-ink"
              popoverTarget={readyId}
              aria-haspopup="dialog"
              aria-expanded={showReady}
              aria-controls={readyId}
              onClick={positionPanel}
            >
              <Check size={13} className="text-accept" aria-hidden />
              <span>
                This machine · {ready.length} {ready.length === 1 ? "check" : "checks"} passed
              </span>
              <ChevronDown
                size={13}
                className="transition-transform duration-120 group-aria-expanded/machine:rotate-180"
                aria-hidden
              />
            </button>
          ) : null}
          {attention.length ? (
            <ul
              className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-caption"
              aria-label="Machine issues"
            >
              {attention.map((item) => (
                <li
                  key={item.id}
                  className={cx(
                    "inline-flex min-w-0 flex-wrap items-center gap-1 wrap-anywhere",
                    item.status === "fail"
                      ? "text-refuse"
                      : item.status === "warn"
                        ? "text-[color-mix(in_srgb,var(--local)_70%,var(--ink))]"
                        : "text-graphite",
                  )}
                  aria-label={`${item.label}: ${item.summary}`}
                  title={item.detail ?? item.summary}
                >
                  {item.status === "fail" ? (
                    <X size={13} className="flex-none" aria-hidden />
                  ) : item.status === "warn" ? (
                    <AlertTriangle size={13} className="flex-none" aria-hidden />
                  ) : (
                    <CircleDashed size={13} className="flex-none" aria-hidden />
                  )}
                  <span className="text-inherit">{item.summary}</span>
                  {item.remedy ? (
                    <button
                      className={cx(
                        buttonClasses({ variant: "link", size: "regular" }),
                        "text-caption",
                      )}
                      onClick={() => props.onRemedy(item.remedy!)}
                    >
                      {item.remedy.kind === "docker-start"
                        ? "Start"
                        : item.remedy.kind === "deps-install"
                          ? "Install"
                          : "Fix"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div
            ref={panel}
            id={readyId}
            popover="auto"
            role="dialog"
            aria-labelledby={titleId}
            onToggle={(event) => setShowReady(event.newState === "open")}
            style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }}
            className="fixed right-auto bottom-auto z-30 m-0 w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-lg border border-rule-strong bg-sheet p-0 text-ink shadow-popover"
          >
            <header className="flex items-center justify-between gap-4 border-b border-rule px-4 py-3">
              <h2 id={titleId} className="m-0 text-body font-semibold">
                This machine
              </h2>
              <IconButton
                variant="quiet"
                aria-label="Close machine checks"
                onClick={() => panel.current?.hidePopover?.()}
              >
                <X size={15} aria-hidden />
              </IconButton>
            </header>
            <ul className="m-0 grid list-none gap-4 p-4 text-caption" aria-label="Passed machine checks">
              {ready.map((item) => (
                <li
                  key={item.id}
                  title={item.detail}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 wrap-anywhere"
                >
                  <Check size={14} className="self-center text-accept" aria-hidden />
                  <strong className="text-label font-medium">{item.label}</strong>
                  <span className="col-start-2 text-graphite">{item.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
