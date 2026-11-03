import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";

/** A command or snippet the reader pastes elsewhere, with one Copy action in its corner. */
export function CopyCode({ code, label }: { readonly code: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="relative" data-slot="guide-code">
      <pre className="m-0 rounded-md bg-wash px-2.5 pt-8 pb-2 font-mono text-meta whitespace-pre-wrap wrap-anywhere">
        <code>{code}</code>
      </pre>
      <button
        className={cx(
          buttonClasses({ variant: "neutral", size: "custom" }),
          "absolute top-1 right-1 min-h-8 px-2 py-0.5 text-caption",
        )}
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
