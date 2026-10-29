import { ExternalLink } from "lucide-react";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

export function Written(props: { readonly location: SourceLocation | undefined; readonly label?: string }) {
  const { snapshot } = useStudio();
  if (!props.location) return <p className="text-caption text-graphite">Its declaration could not be located in source.</p>;
  const { location } = props;
  return (
    <div data-ui="written" className="mt-2 flex flex-wrap items-center gap-[6px] text-meta text-graphite [[data-ui=written]+&]:mt-0">
      <span>
        {props.label ?? "Source"}
      </span>
      <a href={editorLink(snapshot.repositoryRoot, location)} className="inline-flex min-h-7 min-w-0 max-w-full items-center gap-1 text-caption text-graphite no-underline hover:text-ink hover:underline coarse:min-h-11" aria-label={`Open ${location.file}:${location.line} in VS Code`} title={`${location.file}:${location.line}`}>
        <code className="min-w-0 wrap-anywhere">{location.file.split("/").at(-1)}:{location.line}</code> <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}
