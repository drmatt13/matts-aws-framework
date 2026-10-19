import { ExternalLink } from "lucide-react";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

export function Written(props: { readonly location: SourceLocation | undefined; readonly label?: string }) {
  const { snapshot } = useStudio();
  if (!props.location) return <p className="small muted">Its declaration could not be located in source.</p>;
  const { location } = props;
  return (
    <div className="written">
      <span>
        {props.label ?? "Written in"} <code>{location.file}:{location.line}</code>
      </span>
      <a href={editorLink(snapshot.repositoryRoot, location)} className="small">
        Open in VS Code <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}
