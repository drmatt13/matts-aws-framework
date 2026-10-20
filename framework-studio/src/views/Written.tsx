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
        {props.label ?? "Source"}
      </span>
      <a href={editorLink(snapshot.repositoryRoot, location)} className="small" aria-label={`Open ${location.file}:${location.line} in VS Code`} title={`${location.file}:${location.line}`}>
        <code>{location.file.split("/").at(-1)}:{location.line}</code> <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}
