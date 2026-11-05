import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { LoaderCircle, X } from "lucide-react";
import { useDockerStart, useDockerStatus } from "../../machine/docker";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";

/** A machine prerequisite for the map's visual runtime preview, not a Compose launcher. */
export function DockerStartPopover({ id, anchor, onEnablePreview, onClose }: {
  readonly id: string;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly onEnablePreview: () => void;
  readonly onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [position, setPosition] = useState({ left: 12, bottom: 12 });
  const machine = useDockerStatus();
  const startup = useDockerStart();
  const docker = machine.status?.docker;
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string>();
  const [attemptedStart, setAttemptedStart] = useState(false);

  useLayoutEffect(() => {
    const positionPanel = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 10 });
    };
    positionPanel();
    panel.current?.showPopover?.();
    close.current?.focus({ preventScroll: true });
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [anchor]);

  useEffect(() => {
    let active = true;
    const startingAtOpen = startup.starting;
    void machine.refresh().then(status => {
      if (active && !startingAtOpen && status.docker.engine === "running") onEnablePreview();
    }).catch(problem => { if (active) setError(problem instanceof Error ? problem.message : "Could not check Docker. Try again."); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [onEnablePreview]);

  const retry = async (kind: "check" | "start") => {
    setError(undefined);
    if (kind === "start") {
      setAttemptedStart(true);
      try { await startup.start(); } catch (problem) { setError(problem instanceof Error ? problem.message : "Docker could not start."); }
    } else {
      setAttemptedStart(false);
      setChecking(true);
      try { await machine.refresh(); } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not check Docker. Try again."); }
      finally { setChecking(false); }
    }
  };
  const jobError = attemptedStart && !startup.starting && startup.job && startup.job.status !== "succeeded" && startup.job.status !== "running"
    ? startup.job.summary ?? "Docker startup stopped. Check Docker before trying again." : undefined;
  const problem = docker?.engine === "running" ? undefined : error ?? jobError ?? (machine.error ? "Could not check Docker. Try again." : undefined);
  const phase = checking ? "checking" : startup.starting ? "starting" : docker?.engine === "running" ? "ready" : problem ? "error" : "blocked";
  const busy = phase === "checking" || phase === "starting";

  const title = phase === "checking" ? "Checking Docker…"
    : phase === "starting" ? "Starting Docker Desktop…"
    : phase === "ready" ? "Docker is ready"
    : phase === "error" ? "Docker needs attention"
    : docker?.engine === "missing" ? "Docker is not installed"
    : docker?.engine === "unknown" ? "Docker is unavailable"
    : docker?.desktop ? "Docker Desktop is not running" : "Docker is not running";

  return (
    <div
      ref={panel}
      id={id}
      data-ui="compose-docker-help"
      popover="auto"
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      // Keep React state in step with native dismissal before another keyboard activation.
      onBeforeToggle={(event) => { if (event.newState === "closed") onClose(); }}
      style={{ ...position, maxHeight: `calc(100dvh - ${position.bottom + 12}px)` }}
      className="pointer-events-auto fixed top-auto right-auto z-30 m-0 box-border w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl border border-map-rule bg-map-panel p-4 font-sans text-map-ink shadow-popover [--ink:var(--color-map-ink)] [--sheet:var(--color-map-panel)] [--wash:var(--color-map-row)] [--graphite:var(--color-map-muted)] [--rule-strong:var(--color-map-rule)]"
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={titleId} className="m-0 pt-1 text-body leading-snug font-semibold">{title}</h2>
        <IconButton ref={close} type="button" variant="quiet" size="compact" aria-label="Close Docker help" onClick={onClose}>
          <X size={15} aria-hidden />
        </IconButton>
      </header>
      <p id={descriptionId} className="mt-2 mb-0 text-label leading-relaxed text-map-text">
        {phase === "ready" ? "Docker is running. Close this popup, then turn on Local runtime when you’re ready."
          : "Docker runs your app’s local services, including the database, in containers on your machine. Start Docker Desktop before turning on the local runtime."}
      </p>
      {busy ? (
        <p role="status" className="mt-3 mb-0 flex items-center gap-2 text-caption text-map-muted">
          <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" />
          {phase === "starting" ? "Waiting for the Docker engine. This may take a minute." : "Checking whether the Docker engine is available."}
        </p>
      ) : null}
      {problem ? <p role="alert" className="mt-3 mb-0 text-caption leading-relaxed text-map-error-text wrap-anywhere">{problem}</p> : null}
      {!busy && phase !== "ready" && !docker?.desktop ? (
        <p className="mt-3 mb-0 text-caption leading-relaxed text-map-muted">
          {docker?.engine === "missing" ? "Install Docker Desktop, open it and finish setup, then check again."
            : "Open Docker Desktop from your applications and wait for the engine to start, then check again."}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {phase === "ready" ? <Button type="button" variant="primary" onClick={onClose}>Done</Button> : <>
          {docker?.desktop ? <Button type="button" variant="primary" disabled={busy} onClick={() => retry("start")}>
            {phase === "starting" ? "Starting…" : "Start Docker Desktop"}
          </Button> : null}
          <Button type="button" disabled={busy} onClick={() => retry("check")}>Check again</Button>
        </>}
      </div>
    </div>
  );
}
