import type { ComponentPropsWithRef } from "react";
import { cardClasses } from "../ui/Surface";
import { cx } from "../ui/classes";

/** The lifecycle editor shares its behavior with Database/Deploy; document cards
 * retain their smaller headings, labels and native disclosure rhythm. */
const nestedDocumentFormClasses = [
  "[&_[data-slot=data-retention]_h2]:[font:600_15px/1.4_var(--condensed)]",
  "[&_[data-slot=data-retention]_h2]:mt-0 [&_[data-slot=data-retention]_h2]:mb-2",
  "[&_[data-slot=data-retention]_h3]:[font:600_13px_var(--condensed)]",
  "[&_[data-slot=data-retention]_h3]:mt-3 [&_[data-slot=data-retention]_h3]:mb-2",
  "[&_[data-slot=data-retention]_p]:mt-0 [&_[data-slot=data-retention]_p]:mb-2 [&_[data-slot=data-retention]_p:last-child]:mb-0",
  "[&_[data-slot=data-retention]_label]:mb-3 [&_[data-slot=data-retention]_label]:flex [&_[data-slot=data-retention]_label]:flex-col [&_[data-slot=data-retention]_label]:gap-1 [&_[data-slot=data-retention]_label]:text-caption",
  "[&_[data-slot=data-retention]_details]:mt-3 [&_[data-slot=data-retention]_summary]:py-1 [&_[data-slot=data-retention]_summary]:text-label [&_[data-slot=data-retention]_details[open]>summary]:mb-2",
].join(" ");

/** Reading cards shared by Cognito and Domains. Native dialogs keep their own margins. */
export function documentCardClasses(className?: string) {
  return cardClasses({ variant: "document", className: cx("[&_h2]:text-[15px] [&_h2]:leading-[1.4] [&_h2]:mt-0 [&_h2]:mb-2 [&_h3]:text-label [&_p]:text-label [&_p]:leading-[1.5] [&>:not(dialog)]:my-0 [&>:not(dialog):not(:first-child)]:mt-3", nestedDocumentFormClasses, className) });
}
export function DocumentCard({ className, ...props }: ComponentPropsWithRef<"section">) {
  return <section {...props} data-ui="document-card" className={documentCardClasses(className)} />;
}
export const documentLabelClasses = "mb-3 flex min-w-0 flex-col gap-1 text-caption has-[>input[type=checkbox]]:flex-row has-[>input[type=checkbox]]:items-start has-[>input[type=checkbox]]:gap-2";
export const documentFieldsetClasses = "mx-0 my-3 min-w-0 rounded-md border border-rule p-3 [&>:last-child]:mb-0";
export const documentTableRegionClasses = "my-2 max-w-full overflow-x-auto";
/** Preserve readable columns on phones; the named, focusable region owns scrolling. */
export const documentDataTableClasses = "table w-full min-w-[720px] table-fixed border-collapse [&_thead_th]:whitespace-nowrap";
const toolbarLayout = "flex flex-wrap items-end gap-2 [&>label]:m-0 [&>button]:max-w-full [&>button]:flex-none vp-720:[&>label]:max-w-none vp-720:[&>label]:flex-[1_1_100%] vp-720:[&>button]:w-full";
export const documentToolbarClasses = cx(toolbarLayout, "[&>label]:flex-[1_1_180px]");
export const documentSearchToolbarClasses = cx(toolbarLayout, "[&>label]:flex-[0_1_480px]");
export const inspectionControlClasses = "flex flex-wrap items-end gap-2 [&>label]:m-0 [&>label]:flex [&>label]:min-w-0 [&>label]:max-w-80 [&>label]:flex-[1_1_160px] [&>label]:flex-col [&>label]:gap-1 [&>label]:text-caption [&>label:last-of-type]:max-w-45 [&_input]:h-8 [&_select]:h-8 [&>button]:flex-none vp-720:[&>label]:max-w-none vp-720:[&>label]:flex-[1_1_140px] vp-720:[&>label:last-of-type]:max-w-none vp-720:[&>button]:flex-[1_1_100%]";
export const pageWidthClasses = "mx-auto w-full min-w-0 max-w-[1280px] px-4";
