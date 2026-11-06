import { buttonClasses } from "../../ui/Button";
import { documentSupportClasses } from "../DocumentUI";
import { useLayoutEffect, useRef } from "react";

export interface RuntimeMutationGate {
  readonly reason: string;
  readonly action: string;
  readonly disabled?: boolean;
  readonly onAction: () => void;
}

/** Keep the next step beside the disabled action without adding a page card. */
export function RuntimeMutationNotice({ gate, focusAfterRemoval }: {
  readonly gate: RuntimeMutationGate;
  readonly focusAfterRemoval?: () => HTMLElement | null;
}) {
  const notice = useRef<HTMLDivElement>(null);
  const ownsFocus = useRef(false);
  const focusTarget = useRef(focusAfterRemoval);
  focusTarget.current = focusAfterRemoval;
  useLayoutEffect(() => {
    const element = notice.current!;
    return () => {
      if (!ownsFocus.current && !element.contains(document.activeElement)) return;
      queueMicrotask(() => {
        // A person may have moved focus while shutdown completed. Keep it there.
        if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
        const target = focusTarget.current?.();
        if (target?.isConnected && !target.hasAttribute("disabled")) target.focus({ preventScroll: true });
      });
    };
  }, []);
  return <div ref={notice} className="flex min-w-0 flex-[1_1_100%] flex-wrap items-center justify-between gap-2 border-l-2 border-local pl-3" role="status"
    onFocusCapture={() => { ownsFocus.current = true; }}
    onBlurCapture={event => {
      const next = event.relatedTarget as Node | null;
      // Disabling the focused Stop button during shutdown can blur it to the body.
      ownsFocus.current = next ? event.currentTarget.contains(next) : (event.target as HTMLElement).hasAttribute("disabled");
    }}>
    <p className={documentSupportClasses}>{gate.reason}</p>
    <button type="button" className={buttonClasses({ variant: "quiet", size: "compact" })} disabled={gate.disabled} onClick={gate.onAction}>{gate.action}</button>
  </div>;
}
