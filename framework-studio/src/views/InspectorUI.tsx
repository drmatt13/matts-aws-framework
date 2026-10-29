import { ChevronRight } from "lucide-react";
import { useId, type ReactNode, type ComponentProps } from "react";
import { cx } from "../ui/classes";

/** Boolean settings use the same named, keyboard-operable On/Off control. */
export function InspectorSwitch({ id, label, checked, onChange, disabled, describedBy, invalid }: {
  readonly id?: string; readonly label: string; readonly checked: boolean;
  readonly onChange: (checked: boolean) => void; readonly disabled?: boolean;
  readonly describedBy?: string; readonly invalid?: boolean;
}) {
  return <button id={id} type="button" data-slot="inspector-switch" className="group/switch inline-flex min-h-(--panel-icon-target) cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent p-1 font-semibold text-graphite aria-checked:text-accept disabled:cursor-default disabled:opacity-55 aria-disabled:cursor-progress" role="switch" aria-label={label}
    aria-checked={checked} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled}
    onClick={() => onChange(!checked)}>
    <span className="min-w-[3ch] text-right">{checked ? "On" : "Off"}</span>
    <span className="relative h-6 w-11 shrink-0 rounded-full border border-rule-strong bg-wash transition-[background-color,border-color] duration-180 ease-[ease] group-aria-checked/switch:border-accept group-aria-checked/switch:bg-accept group-enabled/switch:group-hover/switch:border-graphite group-enabled/switch:group-aria-checked/switch:group-hover/switch:border-accept group-enabled/switch:group-aria-checked/switch:group-hover/switch:brightness-[1.08] motion-reduce:transition-none" aria-hidden>
      <span className="absolute top-[2px] left-[2px] size-[18px] rounded-full bg-faint shadow-[0_1px_3px_rgb(0_0_0/.35)] transition-[transform,background-color] duration-180 ease-[ease] group-aria-checked/switch:translate-x-5 group-aria-checked/switch:bg-white motion-reduce:transition-none" />
    </span>
  </button>;
}

/** One heading and content rhythm across every inspector and configuration form. */
export function InspectorSection({ title, description, children, actions, className = "", "data-slot": slot }: {
  readonly title: string; readonly description?: ReactNode; readonly children: ReactNode;
  readonly actions?: ReactNode; readonly className?: string; readonly "data-slot"?: string;
}) {
  const id = useId();
  return <section data-inspector-section data-slot={slot ?? "inspector-section"} className={className} aria-labelledby={id}>
    <div data-slot="section-heading" className={cx("flex items-center justify-between gap-3 [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere [&>button]:shrink-0", description ? "mb-1" : "mb-3")}><h3 id={id} className="in-[[data-inspector-context]]:m-0">{title}</h3>{actions}</div>
    {description ? <p className="mt-0 mb-3 text-caption leading-[1.5] text-graphite">{description}</p> : null}
    <div data-slot="section-content" className="min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&>[data-slot=field]:first-child]:pt-0 [&>[data-slot=field]:last-child]:pb-0">{children}</div>
  </section>;
}

/** Supporting information stays one click away without burying everyday controls. */
export function InspectorDisclosure({ title, children, count, status, defaultOpen = false, open, onToggle, className = "", "data-slot": slot }: {
  readonly title: string; readonly children: ReactNode; readonly count?: number;
  readonly status?: "modified" | "invalid";
  readonly defaultOpen?: boolean; readonly className?: string; readonly "data-slot"?: string;
  readonly open?: boolean; readonly onToggle?: (open: boolean) => void;
}) {
  return <section data-inspector-disclosure data-inspector-section data-slot={slot ?? "inspector-disclosure"} className={cx("in-[[data-inspector-context]]:py-2", className)}>
    <details data-disclosure="icon" className="group/disclosure" open={open ?? defaultOpen} onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}>
      <summary className="-mx-1 flex min-h-(--panel-icon-target) cursor-pointer list-none items-center gap-2 rounded-sm px-1 text-label font-semibold hover:bg-wash [&::-webkit-details-marker]:hidden"><ChevronRight size={14} aria-hidden className="shrink-0 text-graphite transition-transform duration-150 group-open/disclosure:rotate-90 motion-reduce:transition-none" /><span className="min-w-0 wrap-anywhere">{title}</span>{status ? <span data-slot="section-state" data-state={status} className={cx("ml-auto text-caption font-medium", status === "invalid" ? "text-refuse" : "text-dev")}>{status === "invalid" ? "Needs attention" : "Modified"}</span> : null}{count !== undefined ? <span data-slot="section-count" className={cx("shrink-0 rounded-sm bg-wash px-2 text-meta font-medium text-graphite", status ? "ml-0" : "ml-auto")}>{count}</span> : null}</summary>
      <div data-slot="section-content" className="min-w-0 group-open/disclosure:pt-3 group-open/disclosure:pb-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0">{children}</div>
    </details>
  </section>;
}

export function FormGroup({ title, description, children }: { readonly title: string; readonly description?: ReactNode; readonly children: ReactNode }) {
  // Inspector density is contextual; document forms retain their native fieldset geometry.
  return <fieldset className="in-[[data-inspector-context]]:mx-0 in-[[data-inspector-context]]:mt-4 in-[[data-inspector-context]]:mb-0 in-[[data-inspector-context]]:min-w-0 in-[[data-inspector-context]]:border-0 in-[[data-inspector-context]]:border-t in-[[data-inspector-context]]:border-rule in-[[data-inspector-context]]:px-0 in-[[data-inspector-context]]:pt-3 in-[[data-inspector-context]]:pb-0 in-[[data-inspector-context]]:first:mt-0 in-[[data-inspector-context]]:first:border-t-0 in-[[data-inspector-context]]:first:pt-0 in-[[data-inspector-context]]:[&>legend+*]:clear-both"><legend className="in-[[data-inspector-context]]:float-left in-[[data-inspector-context]]:mb-3 in-[[data-inspector-context]]:w-full in-[[data-inspector-context]]:p-0 in-[[data-inspector-context]]:text-label in-[[data-inspector-context]]:font-semibold">{title}</legend>{description ? <p className="clear-both mt-0 mb-3 text-caption leading-[1.5] text-graphite">{description}</p> : null}{children}</fieldset>;
}

/** Native disclosure markers are replaced only inside inspector contexts. */
export function InspectorSummary({ children, className, marker = true, ...props }: ComponentProps<"summary"> & { readonly marker?: boolean }) {
  return <summary {...props} className={cx("in-[[data-inspector-context]]:min-h-(--panel-caption-target) in-[[data-inspector-context]]:list-none in-[[data-inspector-context]]:[&::-webkit-details-marker]:hidden", className)}>{marker ? <ChevronRight aria-hidden className="mr-[.35em] hidden size-[1.1em] flex-none align-[-.2em] text-graphite in-[[data-inspector-context]]:inline-block [details[open]>summary>&]:rotate-90 forced-colors:text-[CanvasText]" /> : null}{children}</summary>;
}
