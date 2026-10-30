import type { ReactNode } from "react";
import { buttonClasses } from "../ui/Button";
import { Notice } from "../ui/Surface";

/** The source/context read failure shared by document workspaces. Queries stay with callers. */
export function RetryNotice({ message, retryLabel, retrying, onRetry }: {
  readonly message: ReactNode;
  readonly retryLabel: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return <Notice role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 [&>span]:min-w-0 [&>span]:flex-[1_1_280px] [&>button]:max-w-full [&>button]:flex-none [&>p]:m-0 [&>p]:basis-full">
    <span>{message}</span>
    <button className={buttonClasses({ variant: "quiet" })} disabled={retrying} onClick={onRetry}>{retryLabel}</button>
  </Notice>;
}
