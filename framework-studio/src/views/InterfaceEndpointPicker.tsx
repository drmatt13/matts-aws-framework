import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { endpointServiceDetails } from "../endpoint-services";

/** A multi-select over the framework's catalog; every click stages the owning VPC draft. */
export function InterfaceEndpointPicker({ id, services, selected, onChange, disabled, describedBy, invalid }: {
  readonly id: string; readonly services: readonly string[] | undefined; readonly selected: readonly string[];
  readonly onChange: (services: readonly string[]) => void; readonly disabled?: boolean;
  readonly describedBy?: string; readonly invalid?: boolean;
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
  const catalog = useMemo(() => (services ?? []).map(endpointServiceDetails).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), [services]);
  const matches = catalog.filter(service => {
    const terms = `${service.label} ${service.id}`.toLowerCase().split(/[^a-z0-9]+/);
    return words.every(word => service.id.startsWith(word) || terms.some(term => term.startsWith(word)));
  });
  const focused = matches.some(service => service.id === active) ? active : matches[0]?.id;
  const expanded = open && !disabled;
  const close = (restoreFocus = false) => {
    setOpen(false); setQuery(""); setActive("");
    if (restoreFocus) toggle.current?.focus();
  };
  useEffect(() => {
    if (disabled) { setOpen(false); return; }
    if (!expanded) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); setActive(""); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded, disabled]);
  const select = (service: string) => onChange(chosen.has(service) ? selected.filter(item => item !== service) : [...selected, service]);
  const focusResult = (index: number) => {
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>(".endpoint-option");
    const button = buttons?.[index];
    if (button) { setActive(matches[index]!.id); button.focus(); }
  };
  return <div ref={root} className="endpoint-picker" role="group" aria-label="Interface endpoints" aria-describedby={describedBy}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
    onKeyDown={event => { if (expanded && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    {selected.length ? <ul className="endpoint-selected" aria-label="Selected interface endpoints">{selected.map(id => {
      const service = endpointServiceDetails(id);
      return <li key={id}><button type="button" className="endpoint-chip" disabled={disabled} aria-label={`Remove ${id} endpoint`} onClick={event => { select(id); if (document.activeElement === event.currentTarget) toggle.current?.focus(); }}>
        <img src={service.icon} alt="" aria-hidden /><span><strong>{service.label}</strong><code>{id}</code></span><X size={13} aria-hidden />
      </button></li>;
    })}</ul> : <p className="small muted endpoint-empty">No interface endpoints selected.</p>}
    <button id={id} ref={toggle} type="button" className="button endpoint-picker-toggle" aria-label="Choose interface endpoint services" aria-expanded={expanded} aria-controls={`${prefix}-services`}
      aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled || !services?.length}
      onClick={() => expanded ? close() : setOpen(true)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <Plus size={15} aria-hidden /><span>Add services</span><span className="muted small">{selected.length} selected</span><ChevronDown size={15} aria-hidden />
    </button>
    {!services?.length ? <p className="reason small" role="status">Service catalog unavailable. Restart npm run studio and reload this page.</p> : null}
    {expanded ? <div id={`${prefix}-services`} className="endpoint-dropdown" role="region" aria-label="Available interface endpoint services">
      <div className="endpoint-search"><Search size={15} aria-hidden /><input ref={search} type="search" aria-label="Search interface endpoint services" placeholder="Find a service or endpoint…" value={query}
        aria-controls={`${prefix}-results`} onChange={event => { setQuery(event.target.value); setActive(""); }}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); focusResult(0); } }} /></div>
      <div className="endpoint-picker-status"><span className="small muted" role="status">{matches.length} services · {selected.length} selected</span><button type="button" className="linkish small" onClick={() => close(true)}>Done</button></div>
      {selected.length >= 50 ? <p className="small muted">{selected.length} selected. Remove an endpoint to add another.</p> : null}
      <ul id={`${prefix}-results`} className="endpoint-options" aria-label="Interface endpoint services">{matches.map((service, index) => <li key={service.id}>
        <button type="button" className="endpoint-option" aria-label={`${service.label} · ${service.id}`} aria-pressed={chosen.has(service.id)} tabIndex={focused === service.id ? 0 : -1}
          aria-disabled={!chosen.has(service.id) && selected.length >= 50 || undefined}
          onFocus={() => setActive(service.id)} onClick={() => { if (chosen.has(service.id) || selected.length < 50) select(service.id); }}
          onKeyDown={event => {
            const next = event.key === "ArrowDown" ? Math.min(index + 1, matches.length - 1) : event.key === "ArrowUp" ? Math.max(index - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1 : undefined;
            if (next !== undefined) { event.preventDefault(); focusResult(next); }
          }}>
          <img src={service.icon} alt="" aria-hidden /><span><strong>{service.label}</strong><code>{service.id}</code></span><span className="endpoint-option-mark" aria-hidden>{chosen.has(service.id) ? <Check size={15} /> : <Plus size={15} />}</span>
        </button>
      </li>)}</ul>
      {!matches.length ? <p className="small muted endpoint-no-results">No services match “{query}”. Try a service name or endpoint ID.</p> : null}
      <p className="small muted endpoint-catalog-note">Service availability varies by AWS region.</p>
    </div> : null}
  </div>;
}
