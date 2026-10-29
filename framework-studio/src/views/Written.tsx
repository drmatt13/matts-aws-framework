import { ExternalLink } from "lucide-react";
import { Fragment } from "react";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

export interface SourceLine {
  readonly location: SourceLocation | undefined;
  readonly label?: string;
}

/** Where something is written. Lines share one label column, so their files align and read as one list. */
export function SourceLines({ lines }: { readonly lines: readonly SourceLine[] }) {
  const { snapshot } = useStudio();
  const located = lines.filter((line): line is SourceLine & { readonly location: SourceLocation } => !!line.location);
  if (!located.length) return <p className="text-caption text-graphite">Its declaration could not be located in source.</p>;
  return (
    <dl data-ui="written" className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2.5 text-meta text-graphite [[data-ui=written]+&]:mt-0 [&>dd]:m-0 [&>dd]:min-w-0">
      {located.map(({ location, label }) => <Fragment key={`${label}:${location.file}:${location.line}`}>
        <dt>{label ?? "Source"}</dt>
        <dd>
          <a href={editorLink(snapshot.repositoryRoot, location)} className="inline-flex min-h-[var(--panel-caption-target,24px)] min-w-0 max-w-full items-center gap-1 text-caption text-graphite no-underline hover:text-ink hover:underline coarse:min-h-11" aria-label={`Open ${location.file}:${location.line} in VS Code`} title={`${location.file}:${location.line}`}>
            <code className="min-w-0 wrap-anywhere">{location.file.split("/").at(-1)}:{location.line}</code> <ExternalLink size={12} aria-hidden />
          </a>
        </dd>
      </Fragment>)}
    </dl>
  );
}

export function Written(props: { readonly location: SourceLocation | undefined; readonly label?: string }) {
  return <SourceLines lines={[props]} />;
}
