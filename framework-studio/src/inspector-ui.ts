import { cx } from "./ui/classes";

/** Panel geometry is shared by the map, database inspector and native dialogs. */
export const panelVariables = "[--panel-control-height:32px] [--panel-icon-target:32px] [--panel-caption-target:24px] [--field-label-width:120px] [--field-column-gap:12px] coarse:[--panel-control-height:44px] coarse:[--panel-icon-target:44px] coarse:[--panel-caption-target:44px]";

export const inspectorContextClasses = cx(panelVariables, "group/inspector text-body leading-[1.5] [container:inspector/inline-size] vp-540:[--field-label-width:100px] [:where(&)_p]:mt-0 [:where(&)_p]:mb-2 [:where(&)_h3]:mt-0 [:where(&)_h3]:mb-3 [:where(&)_h3]:text-label [:where(&)_h3]:font-semibold [:where(&)_h2]:text-balance [:where(&)_h3]:text-balance [:where(&)_h4]:text-balance [:where(&)_h5]:text-balance coarse:[&_button]:min-h-11 coarse:[&_summary]:min-h-11");
export const inspectorPanelClasses = cx(inspectorContextClasses, "flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-rule bg-sheet vp-900:border-l-0 vp-900:border-t");

// A header's identifiers and source lines read as one evenly spaced block (10 px of text-to-text space,
// what consecutive 24 px link targets leave); a badge keeps its usual margin above them, and a header
// ending on a source line closes with the same space it opens with.
export const inspectorContentClasses = "relative min-h-0 flex-1 overflow-auto overscroll-contain scrollbar-thin scrollbar-gutter-stable [&>header]:border-b [&>header]:border-rule [&>header]:px-5 [&>header]:py-4 [&>section]:border-b [&>section]:border-rule [&>section]:px-5 [&>section:not([data-inspector-disclosure])]:py-4 [&>section>:first-child]:mt-0 [&>section>[data-slot=connection-details]>:first-child]:mt-0 [:where(&)_h2]:mt-1 [:where(&)_h2]:mb-1.5 [:where(&)_h2]:font-sans [:where(&)_h2]:text-[20px] [:where(&)_h2]:leading-[1.3] [:where(&)_h2]:font-semibold [:where(&)_h2]:tracking-[-.025em] [:where(&)_h2]:wrap-anywhere [&_h2_img]:float-left [&_h2_img]:mt-px [&_h2_img]:mr-2 [&_h2_img]:size-6 [&>header>[data-ui=written]]:mt-1 [&>header>p+[data-ui=written]]:-mt-1 [&>header>[data-ui=written]:last-child]:-mb-1.5";

export const inspectorFieldClasses = "grid grid-cols-[var(--field-label-width)_minmax(0,1fr)] gap-x-(--field-column-gap) gap-y-1 border-t border-rule py-3 first-of-type:border-t-0 has-[[role=switch]]:grid-cols-[minmax(0,1fr)_auto] inspector-420:[&:not(:has([role=switch]))]:grid-cols-[minmax(0,1fr)] inspector-420:[&:not(:has([role=switch]))]:gap-2 [&:has([role=switch])>[data-slot=note]]:col-span-full [&:has([role=switch])>[data-slot=locked]]:col-span-full [&:has([role=switch])>[data-slot=locked]]:text-caption";
export const inspectorStackedFieldClasses = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 inspector-420:gap-2";
export const inspectorWideFieldClasses = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t border-rule py-3 first-of-type:border-t-0";
export const inspectorLabelClasses = "min-w-0 pt-[calc((var(--panel-control-height)-1.5em)/2)] text-label font-medium wrap-anywhere inspector-420:pt-0";
export const inspectorControlClasses = "flex min-w-0 flex-nowrap items-center gap-2 [&>select]:w-full [&>input:not([type=checkbox]):not([type=radio])]:w-full [&>input:not([type=checkbox]):not([type=radio])]:flex-1 [&>code]:min-w-0 [&>code]:text-caption [&>code]:wrap-anywhere";
const supportingTextClasses = "min-w-0 text-caption leading-[1.4] text-graphite wrap-anywhere";
export const inspectorHelpClasses = cx("col-start-2 inspector-420:col-span-full", supportingTextClasses);
/** Switch and stacked rows have no help column. A full-width support row keeps
 * long descriptions from sizing the switch's auto track and squeezing its label. */
export const inspectorFullWidthHelpClasses = cx("col-span-full", supportingTextClasses);
export const inspectorLockedClasses = "col-start-2 min-w-0 border-l-2 border-rule-strong pl-2 text-step-minus1 text-graphite wrap-anywhere [&[role=alert]]:border-refuse [&[role=alert]]:text-refuse inspector-420:col-span-full";
const relationRows = "m-0 list-none p-0 [&>li]:grid [&>li]:grid-cols-[minmax(0,1fr)_auto] [&>li]:items-start [&>li]:gap-x-2.5 [&>li]:gap-y-1.25 [&>li]:border-b [&>li]:border-rule [&>li]:py-2.5 [&>li]:wrap-anywhere [&>li:first-child]:pt-0 [&>li:last-child]:border-b-0 [&>li:last-child]:pb-0 [&>li>button]:wrap-anywhere";
export const inspectorRelationListClasses = cx(relationRows, "[&>li>button]:max-w-40 [&_[data-slot=environment-pills]]:col-span-full");
export const connectionRelationListClasses = cx(relationRows, "[&>li]:gap-y-0.5 [&>li>button]:max-w-none [&_[data-slot=environment-pills]]:col-start-2 [&_[data-slot=environment-pills]]:col-span-1 [&_[data-slot=environment-pills]]:row-start-1 inspector-300:[&_[data-slot=environment-pills]]:col-span-full inspector-300:[&_[data-slot=environment-pills]]:row-auto");
export const inputGroupRelationListClasses = cx(relationRows, "[&>li>button]:max-w-40 [&_[data-slot=environment-pills]]:col-auto");

export function dialogClasses({ className, size = "regular" }: { readonly className?: string; readonly size?: "regular" | "wide" | "help" | "creation" | "unsaved" } = {}) {
  const widths = { regular: "w-[min(860px,calc(100vw-32px))]", wide: "w-[min(1200px,calc(100vw-36px))]", help: "w-[min(640px,calc(100vw-32px))]", creation: "w-[min(700px,calc(100vw-32px))]", unsaved: "w-[min(580px,calc(100vw-32px))]" };
  return cx(panelVariables, "pointer-events-auto m-auto max-h-[calc(100vh-48px)] border border-rule-strong bg-sheet p-0 text-body leading-[1.5] text-ink rounded-lg shadow-[0_24px_80px_rgb(0_0_0/.35)] backdrop:bg-[rgb(5_9_15/.6)] open:flex open:flex-col open:overflow-hidden coarse:[&_button]:min-h-11 coarse:[&_summary]:min-h-11", widths[size], size === "help" ? "backdrop:backdrop-blur-[6px]" : "backdrop:backdrop-blur-[2px]", className);
}
export const dialogHeaderClasses = "flex-none border-b border-rule px-5 pt-4 pb-3 [&>p]:mt-0 [&>p]:mb-1";
export const dialogTitleClasses = "m-0 font-sans text-[22px] font-semibold";
export const dialogBodyClasses = "grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-auto px-5 py-4 [&>h3]:mt-0 [&>h3]:-mb-2 [&>h3]:text-label";
export const dialogFooterClasses = "flex flex-none flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 vp-540:px-4 [&>[data-variant=primary]]:min-w-27.5 vp-420:[&>[data-variant=primary]]:min-w-0 vp-420:[&>[data-variant=primary]]:flex-[1_1_100%]";

export const checkGridClasses = "grid grid-cols-2 gap-3 vp-540:grid-cols-1";
export function checkClasses(tone: "ok" | "refused" | "neutral" = "neutral") {
  return cx("rounded-md border p-3 [&>strong]:flex [&>strong]:items-center [&>strong]:gap-1.5 [&>strong]:text-label", tone === "neutral" && "border-rule", tone === "ok" && "border-[color-mix(in_srgb,var(--accept)_35%,transparent)] bg-accept-wash", tone === "refused" && "border-[color-mix(in_srgb,var(--refuse)_35%,transparent)] bg-refuse-wash");
}
export const checkMessageClasses = "mt-[6px] text-step-minus1 wrap-anywhere";

export const disclosureSummaryClasses = "min-h-(--panel-caption-target) cursor-pointer py-1 text-caption leading-[1.5] text-graphite";
export const pickerOptionClasses = "flex min-h-[58px] min-w-0 w-full items-center gap-2 rounded-sm border border-transparent bg-transparent p-2 text-left [font:inherit] text-ink hover:bg-wash aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-pressed:border-[color-mix(in_srgb,var(--accept)_40%,transparent)] aria-pressed:bg-[color-mix(in_srgb,var(--accept)_9%,transparent)] [&>img]:size-8 [&>img]:flex-none [&>span:first-of-type]:grid [&>span:first-of-type]:min-w-0 [&>span:first-of-type]:flex-1 [&>span:first-of-type]:gap-0.5 [&_strong]:text-caption [&_strong]:leading-[1.35] [&_strong]:font-medium [&_strong]:wrap-anywhere [&_code]:text-micro [&_code]:leading-[1.35] [&_code]:text-graphite [&_code]:wrap-anywhere";
