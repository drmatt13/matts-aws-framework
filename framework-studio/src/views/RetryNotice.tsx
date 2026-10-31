import type { ReactNode } from "react";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Notice } from "../ui/Surface";

/** The source/context read failure shared by document workspaces. Queries stay with callers. */
export function RetryNotice({
  message,
  retryLabel,
  retrying,
  onRetry,
}: {
  readonly message: ReactNode;
  readonly retryLabel: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <Notice role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-[1_1_280px]">{message}</span>
      <button
        className={cx(buttonClasses({ variant: "quiet" }), "max-w-full flex-none")}
        disabled={retrying}
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </Notice>
  );
}
