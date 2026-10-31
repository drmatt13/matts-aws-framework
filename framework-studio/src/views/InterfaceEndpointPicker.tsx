import { TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { pickerOptionClasses } from "../inspector-ui";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { endpointServiceDetails } from "../endpoint-services";

/** A multi-select over the framework's catalog; every click stages the owning VPC draft. */
export function InterfaceEndpointPicker({
  id,
  services,
  selected,
  onChange,
  disabled,
  describedBy,
  invalid,
}: {
  readonly id: string;
  readonly services: readonly string[] | undefined;
  readonly selected: readonly string[];
  readonly onChange: (services: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly describedBy?: string;
  readonly invalid?: boolean;
}) {
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const chosen = new Set(selected);
  const words = query.toLowerCase().trim().split(/\s+/);
  const catalog = useMemo(
    () =>
      (services ?? [])
        .map(endpointServiceDetails)
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    [services],
  );
  const matches = catalog.filter((service) => {
    const terms = `${service.label} ${service.id}`.toLowerCase().split(/[^a-z0-9]+/);
    return words.every(
      (word) => service.id.startsWith(word) || terms.some((term) => term.startsWith(word)),
    );
  });
  const focused = matches.some((service) => service.id === active) ? active : matches[0]?.id;
  const expanded = open && !disabled;
  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActive("");
    if (restoreFocus) toggle.current?.focus();
  };
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!expanded) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
        setActive("");
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded, disabled]);
  const select = (service: string) =>
    onChange(
      chosen.has(service) ? selected.filter((item) => item !== service) : [...selected, service],
    );
  const focusResult = (index: number) => {
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>(
      "[data-slot=endpoint-option]",
    );
    const button = buttons?.[index];
    if (button) {
      setActive(matches[index]!.id);
      button.focus();
    }
  };
  return (
    <div
      ref={root}
      className="min-w-0"
      role="group"
      aria-label="Interface endpoints"
      aria-describedby={describedBy}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
          close();
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
      data-slot="endpoint-picker"
    >
      {selected.length ? (
        <ul
          className="mt-0 mb-3 grid list-none grid-cols-2 gap-2 p-0 vp-420:grid-cols-1 inspector-420:grid-cols-1"
          aria-label="Selected interface endpoints"
          data-slot="endpoint-selected"
        >
          {selected.map((id) => {
            const service = endpointServiceDetails(id);
            return (
              <li className="min-w-0" key={id}>
                <button
                  type="button"
                  className="flex min-h-[52px] min-w-0 w-full cursor-pointer items-center gap-2 rounded-md border border-rule-strong bg-paper p-2 text-left [font:inherit] text-ink hover:enabled:border-graphite hover:enabled:bg-wash"
                  disabled={disabled}
                  aria-label={`Remove ${id} endpoint`}
                  onClick={(event) => {
                    select(id);
                    if (document.activeElement === event.currentTarget) toggle.current?.focus();
                  }}
                  data-slot="endpoint-chip"
                >
                  <img className="size-6 flex-none" src={service.icon} alt="" aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <strong className="text-caption leading-[1.35] font-medium wrap-anywhere">
                      {service.label}
                    </strong>
                    <code className="text-micro leading-[1.35] text-graphite wrap-anywhere">
                      {id}
                    </code>
                  </span>
                  <X size={13} aria-hidden className="flex-none text-graphite" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-0 mb-2 text-caption text-graphite" data-slot="endpoint-empty">
          No interface endpoints selected.
        </p>
      )}
      <button
        id={id}
        ref={toggle}
        type="button"
        className={cx(buttonClasses({ variant: "neutral" }), "w-full justify-start gap-2")}
        aria-label="Choose interface endpoint services"
        aria-expanded={expanded}
        aria-controls={`${prefix}-services`}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        disabled={disabled || !services?.length}
        onClick={() => (expanded ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        data-slot="endpoint-picker-toggle"
      >
        <Plus size={15} aria-hidden />
        <span className="flex-1 text-left">Add services</span>
        <span className="text-graphite text-caption">{selected.length} selected</span>
        <ChevronDown size={15} aria-hidden className={expanded ? "rotate-180" : undefined} />
      </button>
      {!services?.length ? (
        <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption" role="status">
          Service catalog unavailable. Restart npm run studio and reload this page.
        </p>
      ) : null}
      {expanded ? (
        <div
          id={`${prefix}-services`}
          className="mt-2 border border-rule-strong rounded-md p-2 bg-paper"
          role="region"
          aria-label="Available interface endpoint services"
          data-slot="endpoint-dropdown"
        >
          <div className="relative flex items-center gap-2" data-slot="endpoint-search">
            <Search
              size={15}
              aria-hidden
              className="pointer-events-none absolute left-2.5 text-graphite"
            />
            <TextInput
              className="w-full pl-8"
              ref={search}
              type="search"
              aria-label="Search interface endpoint services"
              placeholder="Find a service or endpoint…"
              value={query}
              aria-controls={`${prefix}-results`}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive("");
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusResult(0);
                }
              }}
            />
          </div>
          <div
            className="flex items-center justify-between gap-2 p-2"
            data-slot="endpoint-picker-status"
          >
            <span className="text-caption text-graphite" role="status">
              {matches.length} services · {selected.length} selected
            </span>
            <button
              type="button"
              className={cx(
                buttonClasses({ variant: "link" }),
                "min-h-(--panel-caption-target) text-caption",
              )}
              onClick={() => close(true)}
            >
              Done
            </button>
          </div>
          {selected.length >= 50 ? (
            <p className="mt-0 mb-2 text-caption text-graphite">
              {selected.length} selected. Remove an endpoint to add another.
            </p>
          ) : null}
          <ul
            id={`${prefix}-results`}
            className="m-0 max-h-[300px] list-none overflow-auto overscroll-contain p-[2px] scrollbar-thin scroll-p-1"
            aria-label="Interface endpoint services"
            data-slot="endpoint-options"
          >
            {matches.map((service, index) => (
              <li className="mt-0.5 first:mt-0" key={service.id}>
                <button
                  type="button"
                  className={pickerOptionClasses}
                  aria-label={`${service.label} · ${service.id}`}
                  aria-pressed={chosen.has(service.id)}
                  tabIndex={focused === service.id ? 0 : -1}
                  aria-disabled={(!chosen.has(service.id) && selected.length >= 50) || undefined}
                  onFocus={() => setActive(service.id)}
                  onClick={() => {
                    if (chosen.has(service.id) || selected.length < 50) select(service.id);
                  }}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowDown"
                        ? Math.min(index + 1, matches.length - 1)
                        : event.key === "ArrowUp"
                          ? Math.max(index - 1, 0)
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? matches.length - 1
                              : undefined;
                    if (next !== undefined) {
                      event.preventDefault();
                      focusResult(next);
                    }
                  }}
                  data-slot="endpoint-option"
                >
                  <img className="size-8 flex-none" src={service.icon} alt="" aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <strong className="text-caption leading-[1.35] font-medium wrap-anywhere">
                      {service.label}
                    </strong>
                    <code className="text-micro leading-[1.35] text-graphite wrap-anywhere">
                      {service.id}
                    </code>
                  </span>
                  <span
                    className={cx(
                      "grid size-[22px] flex-none place-items-center rounded-full",
                      chosen.has(service.id)
                        ? "bg-[color-mix(in_srgb,var(--accept)_14%,transparent)] text-accept"
                        : "text-graphite",
                    )}
                    aria-hidden
                    data-slot="endpoint-option-mark"
                  >
                    {chosen.has(service.id) ? <Check size={15} /> : <Plus size={15} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!matches.length ? (
            <p className="text-caption text-graphite my-3 mx-[2px]" data-slot="endpoint-no-results">
              No services match “{query}”. Try a service name or endpoint ID.
            </p>
          ) : null}
          <p
            className="mb-2 text-caption text-graphite mt-2 mx-[2px] text-meta"
            data-slot="endpoint-catalog-note"
          >
            Service availability varies by AWS region.
          </p>
        </div>
      ) : null}
    </div>
  );
}
