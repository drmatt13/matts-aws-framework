import { TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { pickerOptionClasses } from "../inspector-ui";
import { ArrowRight, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { iconUrl, type IconKey } from "../icons";

export interface ConfiguredResourceOption {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: IconKey;
  readonly reason?: string;
  readonly searchTerms?: string;
}

/** Search the application's configured resources without leaving the owning editor. */
export function ConfiguredResourcePicker({
  label,
  options,
  onChoose,
  onCancel,
  disabled,
}: {
  readonly label: string;
  readonly options: readonly ConfiguredResourceOption[];
  readonly onChoose: (id: string) => void;
  readonly onCancel: () => void;
  readonly disabled?: boolean;
}) {
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = options.filter((option) => {
    const text = `${option.title} ${option.subtitle} ${option.searchTerms ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const focused = matches.some((option) => option.id === active) ? active : matches[0]?.id;

  useEffect(() => {
    if (!disabled) search.current?.focus();
  }, [disabled]);

  const focusResult = (index: number) => {
    const option = matches[index];
    const button = root.current?.querySelectorAll<HTMLButtonElement>("[data-slot=endpoint-option]")[
      index
    ];
    if (option && button) {
      setActive(option.id);
      button.focus();
    }
  };

  return (
    <div
      ref={root}
      className="min-w-0"
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      data-slot="endpoint-picker"
    >
      <div
        className="mt-2 border border-rule-strong rounded-md p-2 bg-paper"
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
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder="Find a resource or service…"
            value={query}
            disabled={disabled}
            aria-controls={`${prefix}-results`}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive("");
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                focusResult(event.key === "ArrowDown" ? 0 : matches.length - 1);
              }
            }}
          />
        </div>
        <div
          className="flex items-center justify-between gap-2 p-2"
          data-slot="endpoint-picker-status"
        >
          <span className="text-caption text-graphite" role="status">
            {matches.length} {matches.length === 1 ? "resource" : "resources"}
          </span>
          <button
            type="button"
            className={cx(
              buttonClasses({ variant: "link" }),
              "min-h-(--panel-caption-target) text-caption",
            )}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        <ul
          id={`${prefix}-results`}
          className="m-0 max-h-[300px] list-none overflow-auto overscroll-contain p-[2px] scrollbar-thin scroll-p-1"
          aria-label={label}
          data-slot="endpoint-options"
        >
          {matches.map((option, index) => (
            <li className="mt-0.5 first:mt-0" key={option.id}>
              <button
                type="button"
                className={pickerOptionClasses}
                tabIndex={focused === option.id ? 0 : -1}
                aria-label={`${option.title} · ${option.subtitle}`}
                aria-describedby={option.reason ? `${prefix}-reason-${index}` : undefined}
                aria-disabled={disabled || !!option.reason || undefined}
                onFocus={() => setActive(option.id)}
                onClick={() => {
                  if (!disabled && !option.reason) onChoose(option.id);
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowDown"
                      ? Math.min(index + 1, matches.length - 1)
                      : event.key === "ArrowUp"
                        ? index - 1
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? matches.length - 1
                            : undefined;
                  if (next !== undefined) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (next < 0) search.current?.focus();
                    else focusResult(next);
                  } else if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                }}
                data-slot="endpoint-option"
              >
                <img className="size-8 flex-none" src={iconUrl(option.icon)} alt="" aria-hidden />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-caption leading-[1.35] font-medium wrap-anywhere">
                    {option.title}
                  </strong>
                  <span className="text-caption text-graphite">{option.subtitle}</span>
                  {option.reason ? (
                    <span id={`${prefix}-reason-${index}`} className="text-caption text-graphite">
                      {option.reason}
                    </span>
                  ) : null}
                </span>
                {!option.reason ? (
                  <span
                    className="grid size-[22px] flex-none place-items-center rounded-full text-graphite"
                    aria-hidden
                    data-slot="endpoint-option-mark"
                  >
                    <ArrowRight size={15} />
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {!matches.length ? (
          <p className="text-caption text-graphite my-3 mx-[2px]" data-slot="endpoint-no-results">
            {query.trim() ? `No resources match “${query.trim()}”.` : "No resources available."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
