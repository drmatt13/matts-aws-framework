import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { workspaceToolbarClasses } from "../../ui/Surface";
import { AlertTriangle, Check, ChevronDown, CircleDashed, X } from "lucide-react";
import { useId, useState } from "react";
import type { OperationRequest, PrerequisiteView } from "../../../shared/deploy";

/** Machine checks stay local; the global Source menu owns AWS connection details. */
export function AccountBar(props: {
  readonly prerequisites: readonly PrerequisiteView[];
  readonly onRemedy: (request: OperationRequest) => void;
}) {
  const [showReady, setShowReady] = useState(false);
  const readyId = useId();
  const ready = props.prerequisites.filter((item) => item.status === "ok");
  const attention = props.prerequisites.filter((item) => item.status !== "ok");
  return (
    <section className={workspaceToolbarClasses} aria-label="Machine readiness">
      {props.prerequisites.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {ready.length ? (
            <button
              className="group/machine inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-caption text-graphite hover:text-ink"
              aria-expanded={showReady}
              aria-controls={readyId}
              onClick={() => setShowReady(!showReady)}
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
                        ? "text-[color-mix(in_srgb,var(--local)_75%,var(--ink))]"
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
          <ul
            id={readyId}
            className="m-0 grid flex-[1_1_100%] list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-4 gap-y-2 border-t border-rule px-0 pt-2 pb-1 text-caption"
            aria-label="Passed machine checks"
            hidden={!showReady || !ready.length}
          >
            {ready.map((item) => (
              <li
                key={item.id}
                title={item.detail}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1 wrap-anywhere"
              >
                <Check size={13} className="self-center text-accept" aria-hidden />
                <strong className="font-medium">{item.label}</strong>
                <span className="col-start-2 text-graphite">{item.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
