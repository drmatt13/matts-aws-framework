import { cx } from "../ui/classes";
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
export function SourceLines({
  lines,
  placement = "body",
  className,
}: {
  readonly lines: readonly SourceLine[];
  readonly placement?: "body" | "header" | "evidence";
  readonly className?: string;
}) {
  const { snapshot } = useStudio();
  const located = lines.filter(
    (line): line is SourceLine & { readonly location: SourceLocation } =>
      !!line.location,
  );
  if (!located.length)
    return (
      <p
        className={cx(
          "mt-0 mb-2 text-caption text-graphite",
          placement === "header" && "last:mb-0",
          className,
        )}
      >
        Its declaration could not be located in source.
      </p>
    );
  return (
    <dl
      data-ui="written"
      className={cx(
        "grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2.5 text-meta text-graphite",
        placement === "header"
          ? "mt-0.5 mb-[1em] last:-mb-1.5 [p+&]:-mt-1"
          : placement === "evidence"
            ? "mt-0 mb-0.75"
            : "mt-2 mb-[1em]",
        className,
      )}
    >
      {located.map(({ location, label }) => (
        <Fragment key={`${label}:${location.file}:${location.line}`}>
          <dt>{label ?? "Source"}</dt>
          <dd className="m-0 min-w-0">
            <a
              href={editorLink(snapshot.repositoryRoot, location)}
              className="inline-flex min-h-[var(--panel-caption-target,24px)] min-w-0 max-w-full items-center gap-1 text-caption text-graphite no-underline hover:text-ink hover:underline coarse:min-h-11"
              aria-label={`Open ${location.file}:${location.line} in VS Code`}
              title={`${location.file}:${location.line}`}
            >
              <code className="min-w-0 text-meta wrap-anywhere">
                {location.file.split("/").at(-1)}:{location.line}
              </code>{" "}
              <ExternalLink size={12} aria-hidden />
            </a>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Written(props: {
  readonly location: SourceLocation | undefined;
  readonly label?: string;
  readonly placement?: "body" | "header" | "evidence";
  readonly className?: string;
}) {
  return (
    <SourceLines
      lines={[props]}
      placement={props.placement}
      className={props.className}
    />
  );
}
