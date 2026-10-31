import { cardClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import {
  dialogClasses,
  dialogHeaderClasses,
  dialogTitleClasses,
  dialogBodyClasses,
  dialogFooterClasses,
} from "../inspector-ui";
import { iconButtonClasses } from "../ui/IconButton";
import { sourceDiff } from "../../shared/source-diff";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Shared reading surfaces for schema history, evidence and reviewed artifacts. */
export const workbenchCardClasses = cardClasses();
export const workbenchHeadingClasses = "mt-0 mb-2 font-condensed text-[17px] font-semibold";
export const workbenchTextClasses = "my-1.5 text-caption leading-[1.6]";
export const workbenchCodeClasses = "text-meta wrap-anywhere";
export const workbenchPreClasses =
  "max-h-110 overflow-auto border border-rule bg-paper p-3 text-meta";

export function workbenchNoticeClasses(tone: "neutral" | "warning" = "neutral"): string {
  return cx(
    "rounded-md border border-rule px-4 py-3 text-caption leading-[1.6] wrap-anywhere group-[:fullscreen]/workbench:shrink-0",
    tone === "warning"
      ? "border-l-[3px] border-l-local bg-[color-mix(in_srgb,var(--local)_8%,var(--sheet))]"
      : "bg-sheet",
  );
}

export function WorkbenchDialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  className = "",
  id,
  size = "wide",
  titleClassName = dialogTitleClasses,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly size?: "wide" | "help";
  readonly titleClassName?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) {
      body.current.scrollTop = 0;
      body.current.scrollLeft = 0;
    }
  }, [title]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      data-inspector-context
      ref={dialog}
      id={id}
      data-ui="preview workbench-dialog"
      className={dialogClasses({ size, className })}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className={cx(dialogHeaderClasses, "flex items-center justify-between")}>
        <h2 className={titleClassName}>{title}</h2>
        <button
          className={iconButtonClasses()}
          aria-label={`Close ${title}`}
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div
        ref={body}
        data-ui="body"
        className={cx(dialogBodyClasses, "min-w-0 grid-cols-[minmax(0,1fr)] wrap-anywhere")}
      >
        {children}
      </div>
      <footer className={dialogFooterClasses}>{footer}</footer>
    </dialog>
  );
}

export function SourceComparison({
  before,
  after,
  beforeLabel = "Saved source",
  afterLabel = "Proposed source",
}: {
  readonly before: string;
  readonly after: string;
  readonly beforeLabel?: string;
  readonly afterLabel?: string;
}) {
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  const changes = sourceDiff("source", before, after, 0).lines;
  const removed = new Set(
    changes.filter((line) => line.kind === "remove").map((line) => line.oldLine),
  );
  const added = new Set(changes.filter((line) => line.kind === "add").map((line) => line.newLine));
  return (
    <div
      data-ui="workbench-source-comparison"
      className="grid grid-cols-2 gap-3 vp-850:grid-cols-1"
    >
      {[
        { lines: oldLines, label: beforeLabel, kind: "remove" },
        { lines: newLines, label: afterLabel, kind: "add" },
      ].map(({ lines, label, kind }) => (
        <section key={label} className="min-w-0">
          <h3 className="my-2.5 text-caption">{label}</h3>
          <pre
            aria-label={label}
            className="m-0 min-w-0 max-h-[52vh] max-w-full overflow-auto border border-rule px-0 py-2.5 text-meta"
          >
            {lines.map((line, index) => (
              <span
                key={index}
                className={cx(
                  "block h-[1.7em] w-max min-w-full leading-[1.7] whitespace-pre",
                  (kind === "remove" ? removed : added).has(index + 1) &&
                    (kind === "remove" ? "bg-removed" : "bg-added"),
                )}
              >
                <span
                  data-ui="line-number"
                  className="mr-3 inline-block w-[4ch] text-right text-graphite select-none"
                  aria-hidden
                >
                  {index + 1}
                </span>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}
