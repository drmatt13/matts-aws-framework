import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

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
