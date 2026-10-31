import type { ComponentPropsWithRef } from "react";
import { cardClasses } from "../ui/Surface";
import { cx } from "../ui/classes";

/** Reading cards shared by Cognito and Domains. Native dialogs keep their own margins. */
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
  "mb-3 flex min-w-0 flex-col gap-1 text-caption has-[>input[type=checkbox]]:flex-row has-[>input[type=checkbox]]:items-start has-[>input[type=checkbox]]:gap-2";
export const documentFieldsetClasses =
  "mx-0 my-3 min-w-0 rounded-md border border-rule p-3 [&>:last-child]:mb-0";
export const documentTableRegionClasses = "my-2 max-w-full overflow-x-auto";
/** Preserve readable columns on phones; the named, focusable region owns scrolling. */
export const documentDataTableClasses =
  "table w-full min-w-[720px] table-fixed border-collapse [&_thead_th]:whitespace-nowrap";
export const documentToolbarClasses = "flex flex-wrap items-end gap-2";
export const documentToolbarFieldClasses =
  "m-0 flex min-w-0 flex-[1_1_180px] flex-col gap-1 text-caption vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentSearchFieldClasses =
  "m-0 flex min-w-0 flex-[0_1_480px] flex-col gap-1 text-caption vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentToolbarActionClasses = "max-w-full flex-none vp-720:w-full";
export const inspectionControlClasses = "flex flex-wrap items-end gap-2";
export const inspectionFieldClasses =
  "m-0 flex min-w-0 max-w-80 flex-[1_1_160px] flex-col gap-1 text-caption vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionRegionFieldClasses =
  "m-0 flex min-w-0 max-w-45 flex-[1_1_160px] flex-col gap-1 text-caption vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionActionClasses = "flex-none vp-720:flex-[1_1_100%]";
export const pageWidthClasses = "mx-auto w-full min-w-0 max-w-[1280px] px-4";
