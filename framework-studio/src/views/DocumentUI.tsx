import type { ComponentPropsWithRef } from "react";
import { cardClasses, pageHeaderClasses, pageToolbarClasses } from "../ui/Surface";
import { cx } from "../ui/classes";

/** Reading cards shared by document pages. Native dialogs keep their own margins. */
export function documentCardClasses(className?: string) {
  return cardClasses({
    variant: "document",
    className: cx("[&>:not(dialog)]:my-0 [&>:not(dialog):not(:first-child)]:mt-3", className),
  });
}
export function DocumentCard({ className, ...props }: ComponentPropsWithRef<"section">) {
  return <section {...props} data-ui="document-card" className={documentCardClasses(className)} />;
}
export const documentLabelClasses =
  "mb-3 flex min-w-0 flex-col gap-1 text-label has-[>input[type=checkbox]]:flex-row has-[>input[type=checkbox]]:items-start has-[>input[type=checkbox]]:gap-2";
export const documentSwitchLabelClasses =
  "mt-0 mb-3 flex min-w-0 items-center gap-2 text-label";
export const documentTitleClasses = "m-0 font-sans text-step0 font-semibold leading-[1.4]";
export const documentSubheadingClasses = "m-0 font-sans text-label font-semibold leading-[1.5]";
export const documentProseClasses = "m-0 text-body leading-[1.5]";
export const documentSupportClasses = "m-0 text-caption leading-[1.5] text-graphite";
/** Native markers and keyboard activation stay with summary; its target is at least 32px. */
export const documentSummaryClasses =
  "min-h-8 cursor-pointer py-1 font-sans text-label font-semibold leading-6";
export const documentDisclosureClasses = "mt-3 min-w-0 [&[open]>:not(summary)]:mt-3";
export const documentFieldsetClasses =
  "mx-0 my-3 min-w-0 rounded-md border border-rule p-3 [&>:last-child]:mb-0";
export const documentTableRegionClasses = "my-2 max-w-full overflow-x-auto";
/** Preserve readable columns on phones; the named, focusable region owns scrolling. */
export const documentDataTableClasses =
  "table w-full min-w-[720px] table-fixed border-collapse [&_thead_th]:whitespace-nowrap";
export const documentToolbarClasses = "flex flex-wrap items-end gap-2";
export const documentToolbarFieldClasses =
  "m-0 flex min-w-0 flex-[1_1_180px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentSearchFieldClasses =
  "m-0 flex min-w-0 flex-[0_1_480px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentToolbarActionClasses = "max-w-full flex-none vp-720:w-full";
export const inspectionControlClasses = "flex flex-wrap items-end gap-2";
export const inspectionFieldClasses =
  "m-0 flex min-w-0 max-w-80 flex-[1_1_160px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionRegionFieldClasses =
  "m-0 flex min-w-0 max-w-45 flex-[1_1_160px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionActionClasses = "flex-none vp-720:flex-[1_1_100%]";
/** The column every document page shares: Deploy, GraphQL, Cognito, Domains, WebSockets, Agent test. */
export const pageWidthClasses = "mx-auto w-full min-w-0 max-w-(--workspace-page-max) px-(--workspace-gutter)";
/** A document page's content: the column plus the rhythm below its toolbar. */
export const pageBodyClasses = cx(pageWidthClasses, "pt-4 pb-6 vp-720:pt-3");
export const pageTitleClasses = "m-0 font-sans text-step1 font-semibold leading-[1.3]";
export function PageToolbar({ appearance = "toolbar", className, ...props }: ComponentPropsWithRef<"div"> & { readonly appearance?: "toolbar" | "plain" }) {
  return (
    <header className={cx(appearance === "plain" ? cx(pageHeaderClasses, "border-b border-transparent") : pageToolbarClasses, "flex items-center")}>
      <div {...props} className={cx(pageWidthClasses, className)} />
    </header>
  );
}
