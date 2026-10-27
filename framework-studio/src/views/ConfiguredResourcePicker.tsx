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
export function ConfiguredResourcePicker({ label, options, onChoose, onCancel, disabled }: {
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
  const matches = options.filter(option => {
    const text = `${option.title} ${option.subtitle} ${option.searchTerms ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  const focused = matches.some(option => option.id === active) ? active : matches[0]?.id;

  useEffect(() => { if (!disabled) search.current?.focus(); }, [disabled]);

  const focusResult = (index: number) => {
    const option = matches[index];
    const button = root.current?.querySelectorAll<HTMLButtonElement>(".endpoint-option")[index];
    if (option && button) { setActive(option.id); button.focus(); }
  };

  return <div ref={root} className="endpoint-picker" role="group" aria-label={label}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}>
    <div className="endpoint-dropdown">
      <div className="endpoint-search">
        <Search size={15} aria-hidden />
        <input ref={search} type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Find a resource or service…"
          value={query} disabled={disabled} aria-controls={`${prefix}-results`}
          onChange={event => { setQuery(event.target.value); setActive(""); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); event.stopPropagation();
              focusResult(event.key === "ArrowDown" ? 0 : matches.length - 1);
            }
          }} />
      </div>
      <div className="endpoint-picker-status">
        <span className="small muted" role="status">{matches.length} {matches.length === 1 ? "resource" : "resources"}</span>
        <button type="button" className="linkish small" onClick={onCancel}>Cancel</button>
      </div>
      <ul id={`${prefix}-results`} className="endpoint-options" aria-label={label}>
        {matches.map((option, index) => <li key={option.id}>
          <button type="button" className="endpoint-option" tabIndex={focused === option.id ? 0 : -1}
            aria-label={`${option.title} · ${option.subtitle}`} aria-describedby={option.reason ? `${prefix}-reason-${index}` : undefined}
            aria-disabled={disabled || !!option.reason || undefined}
            onFocus={() => setActive(option.id)}
            onClick={() => { if (!disabled && !option.reason) onChoose(option.id); }}
            onKeyDown={event => {
              const next = event.key === "ArrowDown" ? Math.min(index + 1, matches.length - 1)
                : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0
                  : event.key === "End" ? matches.length - 1 : undefined;
              if (next !== undefined) {
                event.preventDefault(); event.stopPropagation();
                if (next < 0) search.current?.focus(); else focusResult(next);
              } else if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}>
            <img src={iconUrl(option.icon)} alt="" aria-hidden />
            <span><strong>{option.title}</strong><span className="small muted">{option.subtitle}</span>
              {option.reason ? <span id={`${prefix}-reason-${index}`} className="small muted">{option.reason}</span> : null}
            </span>
            {!option.reason ? <span className="endpoint-option-mark" aria-hidden><ArrowRight size={15} /></span> : null}
          </button>
        </li>)}
      </ul>
      {!matches.length ? <p className="small muted endpoint-no-results">{query.trim() ? `No resources match “${query.trim()}”.` : "No resources available."}</p> : null}
    </div>
  </div>;
}
