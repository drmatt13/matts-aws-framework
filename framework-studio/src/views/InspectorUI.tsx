import { ChevronRight } from "lucide-react";
import { useId, type ReactNode, type ComponentProps } from "react";
import { cx } from "../ui/classes";
import { inspectorSectionClasses } from "../inspector-ui";
import { EnvironmentPills } from "./DeploymentBadge";

/** Boolean settings use the same named, keyboard-operable On/Off control. */
export function InspectorSwitch({
  id,
  label,
  checked,
  onChange,
  disabled,
  describedBy,
  invalid,
  className,
}: {
  readonly id?: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly describedBy?: string;
  readonly invalid?: boolean;
  readonly className?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      data-slot="inspector-switch"
      className={cx(
        "group/switch inline-flex min-h-(--panel-icon-target) cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent p-1 font-semibold text-graphite aria-checked:text-accept disabled:cursor-default disabled:opacity-55 aria-disabled:cursor-progress",
        className,
      )}
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="min-w-[3ch] text-right">{checked ? "On" : "Off"}</span>
      <span
        className="relative h-6 w-11 shrink-0 rounded-full border border-rule-strong bg-wash transition-[background-color,border-color] duration-180 ease-[ease] group-aria-checked/switch:border-accept group-aria-checked/switch:bg-accept group-enabled/switch:group-hover/switch:border-graphite group-enabled/switch:group-aria-checked/switch:group-hover/switch:border-accept group-enabled/switch:group-aria-checked/switch:group-hover/switch:brightness-[1.08] motion-reduce:transition-none"
        aria-hidden
      >
        <span className="absolute top-[2px] left-[2px] size-[18px] rounded-full bg-faint shadow-[0_1px_3px_rgb(0_0_0/.35)] transition-[transform,background-color] duration-180 ease-[ease] group-aria-checked/switch:translate-x-5 group-aria-checked/switch:bg-white motion-reduce:transition-none" />
      </span>
    </button>
  );
}

/** An inspector header's type label, with its subject's Dev | Prod pair at the right where it has one. */
export function InspectorKind({
  children,
  environments,
}: {
  readonly children: ReactNode;
  readonly environments?: ComponentProps<typeof EnvironmentPills>;
}) {
  return (
    <div data-slot="inspector-kind" className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-graphite text-meta font-medium tracking-[.03em] wrap-anywhere">
        {children}
      </span>
      {environments ? <EnvironmentPills {...environments} className="-my-1 shrink-0" /> : null}
    </div>
  );
}

/** A count beside a heading or supporting summary; the shared disclosure right-aligns its own. */
export function InspectorCount({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      data-slot="section-count"
      className={cx(
        "inline-block shrink-0 rounded-sm bg-wash px-2 text-meta leading-[1.5] font-medium text-graphite tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** One heading and content rhythm across every inspector and configuration form.
 * A heading action keeps its 32 px target without lowering the title, so every section title sits
 * the same distance below its rule. */
export function InspectorSection({
  title,
  description,
  children,
  actions,
  className = "",
  contentClassName,
  embedded = false,
  appearance = "inspector",
  "data-slot": slot,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly embedded?: boolean;
  readonly appearance?: "inspector" | "native";
  readonly "data-slot"?: string;
}) {
  const id = useId();
  return (
    <section
      data-inspector-section
      data-slot={slot ?? "inspector-section"}
      className={cx(appearance === "inspector" && !embedded && inspectorSectionClasses, className)}
      aria-labelledby={id}
    >
      <div
        data-slot="section-heading"
        className={cx(
          "flex items-center justify-between gap-3",
          description ? (actions ? "mb-2.5" : "mb-1") : "mb-3",
        )}
      >
        <h3
          id={id}
          className={cx(
            "min-w-0 wrap-anywhere",
            appearance === "inspector" && "m-0 text-label font-semibold text-balance",
          )}
        >
          {title}
        </h3>
        {actions ? (
          <span className="-my-1.5 inline-flex shrink-0 items-center">{actions}</span>
        ) : null}
      </div>
      {description ? (
        <p className="mt-0 mb-3 text-caption leading-[1.5] text-graphite">{description}</p>
      ) : null}
      <div
        data-slot="section-content"
        className={cx(
          "min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&>[data-slot=field]:first-child]:pt-0 [&>[data-slot=field]:last-child]:pb-0",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Supporting information stays one click away without burying everyday controls. */
export function InspectorDisclosure({
  title,
  children,
  count,
  status,
  defaultOpen = false,
  open,
  onToggle,
  className = "",
  contentClassName,
  embedded = false,
  appearance = "inspector",
  "data-slot": slot,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly count?: number;
  readonly status?: "modified" | "invalid";
  readonly defaultOpen?: boolean;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly embedded?: boolean;
  readonly appearance?: "inspector" | "native";
  readonly "data-slot"?: string;
  readonly open?: boolean;
  readonly onToggle?: (open: boolean) => void;
}) {
  return (
    <section
      data-inspector-disclosure
      data-inspector-section
      data-slot={slot ?? "inspector-disclosure"}
      className={cx(
        appearance === "inspector" && cx(!embedded && "border-b border-rule px-5", "py-2"),
        className,
      )}
    >
      <details
        data-disclosure="icon"
        className="group/disclosure"
        open={open ?? defaultOpen}
        onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      >
        <summary className="-mx-1 flex min-h-(--panel-icon-target) cursor-pointer list-none items-center gap-2 rounded-sm px-1 text-label font-semibold hover:bg-wash [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-graphite transition-transform duration-150 group-open/disclosure:rotate-90 motion-reduce:transition-none"
          />
          <span className="min-w-0 wrap-anywhere">{title}</span>
          {status ? (
            <span
              data-slot="section-state"
              data-state={status}
              className={cx(
                "ml-auto text-caption font-medium",
                status === "invalid" ? "text-refuse" : "text-dev",
              )}
            >
              {status === "invalid" ? "Needs attention" : "Modified"}
            </span>
          ) : null}
          {count !== undefined ? (
            <InspectorCount className={status ? "ml-0" : "ml-auto"}>{count}</InspectorCount>
          ) : null}
        </summary>
        <div
          data-slot="section-content"
          className={cx(
            "min-w-0 group-open/disclosure:pt-3 group-open/disclosure:pb-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
            contentClassName,
          )}
        >
          {children}
        </div>
      </details>
    </section>
  );
}

export function FormGroup({
  title,
  description,
  children,
  appearance = "inspector",
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly appearance?: "inspector" | "plain";
}) {
  // Inspector density is contextual; document forms retain their native fieldset geometry.
  return (
    <fieldset
      className={cx(
        appearance === "plain"
          ? "m-0 min-w-0 border-0 p-0"
          : "in-[[data-inspector-context]]:mx-0 in-[[data-inspector-context]]:mt-4 in-[[data-inspector-context]]:mb-0 in-[[data-inspector-context]]:min-w-0 in-[[data-inspector-context]]:border-0 in-[[data-inspector-context]]:border-t in-[[data-inspector-context]]:border-rule in-[[data-inspector-context]]:px-0 in-[[data-inspector-context]]:pt-3 in-[[data-inspector-context]]:pb-0 in-[[data-inspector-context]]:first:mt-0 in-[[data-inspector-context]]:first:border-t-0 in-[[data-inspector-context]]:first:pt-0 ",
        "[&>legend+*]:clear-both",
      )}
    >
      <legend className="in-[[data-inspector-context]]:float-left in-[[data-inspector-context]]:mb-3 in-[[data-inspector-context]]:w-full in-[[data-inspector-context]]:p-0 in-[[data-inspector-context]]:text-label in-[[data-inspector-context]]:font-semibold">
        {title}
      </legend>
      {description ? (
        <p className="clear-both mt-0 mb-3 text-caption leading-[1.5] text-graphite">
          {description}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

/** Native disclosure markers are replaced only inside inspector contexts. */
export function InspectorSummary({
  children,
  className,
  marker = true,
  ...props
}: ComponentProps<"summary"> & { readonly marker?: boolean }) {
  return (
    <summary
      {...props}
      className={cx(
        "in-[[data-inspector-context]]:min-h-(--panel-caption-target) in-[[data-inspector-context]]:list-none in-[[data-inspector-context]]:[&::-webkit-details-marker]:hidden",
        className,
      )}
    >
      {marker ? (
        <ChevronRight
          aria-hidden
          className="mr-[.35em] hidden size-[1.1em] flex-none align-[-.2em] text-graphite in-[[data-inspector-context]]:inline-block [details[open]>summary>&]:rotate-90 forced-colors:text-[CanvasText]"
        />
      ) : null}
      {children}
    </summary>
  );
}
