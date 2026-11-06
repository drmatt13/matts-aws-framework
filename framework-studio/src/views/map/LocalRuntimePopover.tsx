import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { openActivity } from "../../activity";
import type { useLocalRuntime } from "../../deploy/local-runtime";
import { Button, buttonClasses } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";

export function LocalRuntimePopover({ id, anchor, runtime, onClose, onStop }: {
  readonly id: string; readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly runtime: ReturnType<typeof useLocalRuntime>; readonly onClose: () => void; readonly onStop: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [position, setPosition] = useState({ left: 12, bottom: 12 });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  useLayoutEffect(() => {
    const positionPanel = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 10 });
    };
    positionPanel(); panel.current?.showPopover?.(); close.current?.focus({ preventScroll: true });
    window.addEventListener("resize", positionPanel); window.addEventListener("scroll", positionPanel, true);
    return () => { window.removeEventListener("resize", positionPanel); window.removeEventListener("scroll", positionPanel, true); };
  }, [anchor]);
  const binding = runtime.local?.binding;
  const reason = error ?? runtime.error ?? runtime.problem ?? (runtime.active && !runtime.matches
    ? "Local services already use another deployment or AWS profile. Stop them before starting the selected development deployment."
    : runtime.local?.restartNeeded.length ? "Local services need to restart to pick up updated settings. Stop the runtime, then start it again."
    : runtime.active && runtime.attention ? runtime.attention
    : runtime.active ? runtime.local?.readiness?.message : runtime.blocker)
    ?? "Refresh the runtime status, then turn on Local runtime to start development.";
  return <div ref={panel} id={id} data-ui="local-runtime-help" popover="auto" role="dialog" aria-labelledby={titleId}
    onBeforeToggle={event => { if (event.newState === "closed") onClose(); }}
    style={{ ...position, maxHeight: `calc(100dvh - ${position.bottom + 12}px)` }}
    className="pointer-events-auto fixed top-auto right-auto z-30 m-0 box-border w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl border border-map-rule bg-map-panel p-4 font-sans text-map-ink shadow-popover [--ink:var(--color-map-ink)] [--sheet:var(--color-map-panel)] [--wash:var(--color-map-row)] [--graphite:var(--color-map-muted)] [--rule-strong:var(--color-map-rule)]">
    <header className="flex items-start justify-between gap-2">
      <h2 id={titleId} className="m-0 pt-1 text-body leading-snug font-semibold">Local runtime</h2>
      <IconButton ref={close} variant="quiet" size="compact" aria-label="Close runtime details" onClick={onClose}><X size={15} aria-hidden /></IconButton>
    </header>
    <p role={error || runtime.error || runtime.problem ? "alert" : undefined} className="mt-2 mb-0 text-label leading-relaxed text-map-text wrap-anywhere">{reason}</p>
    {runtime.active ? <p className="mt-2 mb-0 text-caption leading-relaxed text-map-muted wrap-anywhere">
      {binding ? `${binding.deployment} · profile ${binding.profile} · ${binding.account ?? "account unknown"} · ${binding.region ?? "region unknown"}` : "Existing local services have no verified deployment binding."}
    </p> : null}
    <div className="mt-4 flex flex-wrap gap-2">
      {runtime.active ? <Button variant="quiet" disabled={runtime.busy} onClick={onStop}>Stop runtime</Button>
        : runtime.blocker ? <Link to="/deploy" className={buttonClasses({ variant: "quiet" })}>Open Deploy</Link> : null}
      <Button variant="quiet" disabled={checking || runtime.checking} onClick={async () => {
        setChecking(true); setError(undefined);
        try { await runtime.refresh(); } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not refresh runtime status."); }
        finally { setChecking(false); }
      }}>{checking ? "Checking…" : "Check again"}</Button>
      {runtime.job ? <Button variant="link" onClick={() => { openActivity(runtime.job!.id); onClose(); }}>View activity</Button> : null}
    </div>
  </div>;
}
