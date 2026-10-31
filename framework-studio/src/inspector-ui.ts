import { cx } from "./ui/classes";

/** Panel geometry is shared by the map, database inspector and native dialogs. */
export const panelVariables =
  "[--panel-control-height:32px] [--panel-icon-target:32px] [--panel-caption-target:24px] [--field-label-width:120px] [--field-column-gap:12px] coarse:[--panel-control-height:44px] coarse:[--panel-icon-target:44px] coarse:[--panel-caption-target:44px]";

export const inspectorContextClasses = cx(
  panelVariables,
  "group/inspector text-body leading-[1.5] [container:inspector/inline-size] vp-540:[--field-label-width:100px] coarse:[&_button]:min-h-11 coarse:[&_summary]:min-h-11",
);
export const inspectorPanelClasses = cx(
  inspectorContextClasses,
  "flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-rule bg-sheet vp-900:border-l-0 vp-900:border-t",
);

/** Scroll containment only. Headers, sections, titles and badges own their presentation. */
export const inspectorContentClasses =
  "relative min-h-0 flex-1 overflow-auto overscroll-contain scrollbar-thin scrollbar-gutter-stable";
export const inspectorHeaderClasses = "border-b border-rule px-5 py-4";
export const inspectorSectionClasses = "border-b border-rule px-5 py-4 [&>:first-child]:mt-0";
export const inspectorTitleClasses =
  "mt-1 mb-1.5 font-sans text-[20px] leading-[1.3] font-semibold tracking-[-.025em] wrap-anywhere text-balance last:mb-0";

/** Shared tag content rhythm; passed directly to InspectorDisclosure's content slot. */
export const tagDisclosureContentClasses = "grid gap-3";

/**
 * Field layout is chosen by the component, never inferred from a descendant's role.
 * Value fields stack label → control → support on one left edge at every panel width, with
 * 4 px between each; a switch keeps its label and On/Off control on one centered line.
 * Fields are separated by a rule and 12 px on each side.
 */
export function inspectorFieldRowClasses({
  switch: isSwitch = false,
  flush = false,
}: {
  readonly switch?: boolean;
  readonly flush?: boolean;
} = {}) {
  return cx(
    "grid min-w-0 gap-x-(--field-column-gap) gap-y-1 border-t border-rule first-of-type:border-t-0",
    isSwitch ? "grid-cols-[minmax(0,1fr)_auto] items-center" : "grid-cols-[minmax(0,1fr)]",
    flush ? "py-0 -mt-1.5" : "py-3 first:pt-0 last:pb-0",
  );
}
export const inspectorFieldClasses = inspectorFieldRowClasses();
export const inspectorSwitchFieldClasses = inspectorFieldRowClasses({ switch: true });
/** An unruled stacked field, for a single control inside a section that supplies its own rhythm. */
export const inspectorStackedFieldClasses = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1";
/** A ruled field whose control is a composite (a picker or list) rather than one input. */
export const inspectorWideFieldClasses = inspectorFieldClasses;
export function inspectorFieldLabelClasses({
  modified = false,
}: {
  readonly modified?: boolean;
} = {}) {
  return cx(
    "min-w-0 text-label font-medium wrap-anywhere",
    modified && "after:content-['_•'] after:text-dev",
  );
}
export const inspectorLabelClasses = inspectorFieldLabelClasses();
export const inspectorControlClasses = "flex min-w-0 flex-nowrap items-center gap-2";
const supportingTextClasses = "min-w-0 text-caption leading-[1.4] text-graphite wrap-anywhere";
/** Help sits directly beneath its control, on the label's left edge. */
export const inspectorHelpClasses = cx("col-span-full", supportingTextClasses);
/** Switch rows have no help column. A full-width support row keeps long descriptions
 * from sizing the switch's auto track and squeezing its label. */
export const inspectorFullWidthHelpClasses = inspectorHelpClasses;
export const inspectorLockedClasses =
  "col-span-full min-w-0 border-l-2 border-rule-strong pl-2 text-caption text-graphite wrap-anywhere [&[role=alert]]:border-refuse [&[role=alert]]:text-refuse";
export const inspectorFullWidthLockedClasses = cx(
  inspectorLockedClasses,
  "aria-[invalid=true]:border-refuse",
);

const noteTextClasses = "min-w-0 text-caption leading-[1.5] text-graphite wrap-anywhere";
/** Supporting copy that owns no margins; its container's gap places it. */
export const inspectorNoteClasses = cx("m-0", noteTextClasses);
/**
 * An action and the note that qualifies it: the note follows by 8 px. Copy that introduces the
 * action sits 12 px above the group, the same distance a heading keeps from its content.
 */
export const inspectorActionGroupClasses = "grid min-w-0 justify-items-start gap-2";
/** Introductory copy above a control, list or action group. */
export const inspectorIntroClasses = cx("mt-0 mb-3", noteTextClasses);

/**
 * A Development or Production card: tinted by its environment's color, with a dotted top edge
 * when the subject is absent from that environment. Deployment and input behavior share it.
 */
export function environmentCardClasses({
  mode,
  active,
}: {
  readonly mode: "dev" | "prod";
  readonly active: boolean;
}) {
  return cx(
    "flex min-w-0 flex-col gap-1 rounded-md border border-rule px-3 py-2 text-caption [background:color-mix(in_srgb,currentColor_3%,var(--sheet))]",
    mode === "dev" ? "text-dev" : "text-prod",
    !active && "[border-top-style:dotted]",
  );
}

export const inspectorRelationListClasses = "m-0 list-none p-0";
/** Rows own their geometry; list containers never reach into buttons or environment badges. */
export function inspectorRelationRowClasses({
  layout = "default",
}: {
  readonly layout?: "default" | "connection" | "entry" | "member" | "usage" | "consumer";
} = {}) {
  return cx(
    "grid border-b border-rule py-2.5 wrap-anywhere first:pt-0 last:border-b-0 last:pb-0",
    layout === "member"
      ? "grid-cols-2 items-baseline gap-x-3 gap-y-2 inspector-360:grid-cols-1"
      : "grid-cols-[minmax(0,1fr)_auto]",
    layout === "entry" ? "items-center gap-x-3 gap-y-1" : layout !== "member" && "gap-x-2.5",
    layout === "connection"
      ? "items-start gap-y-0.5"
      : layout === "consumer"
        ? "items-baseline gap-y-1.25"
        : layout !== "entry" && layout !== "member" && "items-start gap-y-1.25",
    layout === "usage" && "inspector-360:grid-cols-1",
  );
}

export function dialogClasses({
  className,
  size = "regular",
}: {
  readonly className?: string;
  readonly size?: "regular" | "wide" | "help" | "creation" | "unsaved";
} = {}) {
  const widths = {
    regular: "w-[min(860px,calc(100vw-32px))]",
    wide: "w-[min(1200px,calc(100vw-36px))]",
    help: "w-[min(640px,calc(100vw-32px))]",
    creation: "w-[min(700px,calc(100vw-32px))]",
    unsaved: "w-[min(580px,calc(100vw-32px))]",
  };
  return cx(
    panelVariables,
    "pointer-events-auto m-auto max-h-[calc(100vh-48px)] border border-rule-strong bg-sheet p-0 text-body leading-[1.5] text-ink rounded-lg shadow-[0_24px_80px_rgb(0_0_0/.35)] backdrop:bg-[rgb(5_9_15/.6)] open:flex open:flex-col open:overflow-hidden coarse:[&_button]:min-h-11 coarse:[&_summary]:min-h-11",
    widths[size],
    size === "help" ? "backdrop:backdrop-blur-[6px]" : "backdrop:backdrop-blur-[2px]",
    className,
  );
}
export const dialogHeaderClasses = "flex-none border-b border-rule px-5 pt-4 pb-3";
export const dialogSubtitleClasses = "mt-0 mb-1 text-caption text-graphite";
export const dialogTitleClasses = "m-0 font-sans text-[22px] font-semibold";
export const dialogBodyClasses =
  "grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-auto px-5 py-4";
export const dialogBodyHeadingClasses = "mt-0 -mb-2 text-label";
export const dialogFooterClasses =
  "flex flex-none flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 vp-540:px-4";

/** Apply to the primary action itself; footer layout never queries button metadata. */
export const dialogPrimaryActionClasses = "min-w-27.5 vp-420:min-w-0 vp-420:flex-[1_1_100%]";

export const checkGridClasses = "grid grid-cols-2 gap-3 vp-540:grid-cols-1";
export function checkClasses(tone: "ok" | "refused" | "neutral" = "neutral") {
  return cx(
    "rounded-md border p-3",
    tone === "neutral" && "border-rule",
    tone === "ok" && "border-[color-mix(in_srgb,var(--accept)_35%,transparent)] bg-accept-wash",
    tone === "refused" &&
      "border-[color-mix(in_srgb,var(--refuse)_35%,transparent)] bg-refuse-wash",
  );
}
export const checkTitleClasses = "flex items-center gap-1.5 text-label";
export const checkMessageClasses = "mt-[6px] text-step-minus1 wrap-anywhere";

export const disclosureSummaryClasses =
  "min-h-(--panel-caption-target) cursor-pointer py-1 text-caption leading-[1.5] text-graphite";
export const pickerOptionClasses =
  "flex min-h-[58px] min-w-0 w-full items-center gap-2 rounded-sm border border-transparent bg-transparent p-2 text-left [font:inherit] text-ink hover:bg-wash aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-pressed:border-[color-mix(in_srgb,var(--accept)_40%,transparent)] aria-pressed:bg-[color-mix(in_srgb,var(--accept)_9%,transparent)]";
