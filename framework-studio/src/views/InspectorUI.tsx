import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

/** Boolean settings use the same named, keyboard-operable On/Off control. */
export function InspectorSwitch({ id, label, checked, onChange, disabled, describedBy, invalid }: {
  readonly id?: string; readonly label: string; readonly checked: boolean;
  readonly onChange: (checked: boolean) => void; readonly disabled?: boolean;
  readonly describedBy?: string; readonly invalid?: boolean;
}) {
  return <button id={id} type="button" className="auth-switch" role="switch" aria-label={label}
    aria-checked={checked} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled}
    onClick={() => onChange(!checked)}>
    <span className="auth-switch-state">{checked ? "On" : "Off"}</span>
    <span className="auth-switch-track" aria-hidden><span className="auth-switch-thumb" /></span>
  </button>;
}

/** One heading and content rhythm across every inspector and configuration form. */
export function InspectorSection({ title, description, children, actions, className = "" }: {
  readonly title: string; readonly description?: ReactNode; readonly children: ReactNode;
  readonly actions?: ReactNode; readonly className?: string;
}) {
  const id = useId();
  return <section className={`inspector-section ${className}`} aria-labelledby={id}>
    <div className="section-heading"><h3 id={id}>{title}</h3>{actions}</div>
    {description ? <p className="section-description">{description}</p> : null}
    <div className="section-content">{children}</div>
  </section>;
}

/** Supporting information stays one click away without burying everyday controls. */
export function InspectorDisclosure({ title, children, count, defaultOpen = false, open, onToggle, className = "" }: {
  readonly title: string; readonly children: ReactNode; readonly count?: number;
  readonly defaultOpen?: boolean; readonly className?: string;
  readonly open?: boolean; readonly onToggle?: (open: boolean) => void;
}) {
  return <section className={`inspector-section inspector-disclosure ${className}`}>
    <details open={open ?? defaultOpen} onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}>
      <summary><ChevronRight size={14} aria-hidden /><span>{title}</span>{count !== undefined ? <span className="section-count">{count}</span> : null}</summary>
      <div className="section-content">{children}</div>
    </details>
  </section>;
}

export function FormGroup({ title, description, children }: { readonly title: string; readonly description?: ReactNode; readonly children: ReactNode }) {
  return <fieldset className="form-group"><legend>{title}</legend>{description ? <p className="section-description">{description}</p> : null}{children}</fieldset>;
}
