import { X } from "lucide-react";
import { cx } from "./classes";

export function ToastNotice({ text, tone, onDismiss }: {
  readonly text: string;
  readonly tone: "plain" | "info" | "refuse";
  readonly onDismiss: () => void;
}) {
  return (
    <div
      data-ui="toast"
      className={cx(
        "relative min-h-13 rounded-md border border-graphite py-3 pr-14 pl-4 text-step-minus1 text-sheet shadow-popover wrap-anywhere coarse:pr-16",
        tone === "refuse" ? "bg-refuse" : "bg-ink",
      )}
    >
      {text}
      <button
        type="button"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        onClick={onDismiss}
        className="absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-full border border-current bg-transparent p-0 text-inherit cursor-pointer hover:bg-sheet/10 focus-visible:outline-current coarse:top-1 coarse:right-1 coarse:size-11"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
