import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { DockerPresence } from "../../../shared/machine";
import { Button, buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { StatusDot } from "./DeployUI";

const TEXT: Readonly<Record<DockerPresence["tone"], string>> = {
  ok: "text-graphite",
  warn: "font-medium text-[color-mix(in_srgb,var(--local)_70%,var(--ink))]",
  busy: "text-[color-mix(in_srgb,var(--local)_60%,var(--ink))]",
  unknown: "text-graphite",
};

/** Docker's current state and its remedy, shown on every route whatever the job history says. */
export function DockerStatus({ presence, onStart, onCheck, className }: {
  readonly presence: DockerPresence;
  readonly onStart: () => void;
  readonly onCheck: () => Promise<unknown>;
  readonly className?: string;
}) {
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void onCheck().finally(() => setChecking(false));
  };
  return (
    <div data-ui="docker-status" className={cx("flex items-center gap-2", className)}>
      <span role="status" title={presence.detail} className={cx("inline-flex items-center gap-1.5 text-step-minus1 whitespace-nowrap", TEXT[presence.tone])}>
        {presence.tone === "busy"
          ? <LoaderCircle size={13} className="flex-none animate-spin motion-reduce:animate-none" aria-hidden />
          : <StatusDot tone={presence.tone} />}
        {presence.label}
      </span>
      {presence.action === "start" ? (
        <Button type="button" size="compact" aria-label="Start Docker" onClick={onStart}>Start</Button>
      ) : presence.action === "check" ? (
        <Button type="button" size="compact" aria-label="Check again for Docker" disabled={checking} onClick={check}>Check again</Button>
      ) : presence.action === "install" ? (
        <a className={buttonClasses({ size: "compact" })} href="https://docs.docker.com/get-docker/" target="_blank" rel="noreferrer">Install Docker</a>
      ) : null}
    </div>
  );
}
