import { TriangleAlert, Unplug, X } from "lucide-react";
import type { EntityIssue } from "../issues";
import { cx } from "../ui/classes";
import { noticeClasses } from "../ui/Surface";

/** The DOM counterpart of an issue's map badge: a cross for an error, the badge's own glyph otherwise. */
export function IssueGlyph({ issue, size = 14 }: { readonly issue: EntityIssue; readonly size?: number }) {
  const Glyph = issue.badge === "unattached" ? Unplug : issue.severity === "error" ? X : TriangleAlert;
  return <Glyph size={size} aria-hidden className="flex-none" />;
}

/**
 * An entity's issues in its inspector, as the header's last element: the hover card's titles and
 * sentences, errors first, in the shared notice treatment. Errors are alerts; warnings are notes.
 */
export function IssueNotice({
  issues,
  className = "mt-3",
}: {
  readonly issues: readonly EntityIssue[];
  readonly className?: string;
}) {
  if (!issues.length) return null;
  return (
    <div className={cx("grid gap-2", className)} data-slot="issues">
      {issues.map((issue) => (
        <div
          key={issue.title}
          role={issue.severity === "error" ? "alert" : "note"}
          data-issue={issue.severity}
          className={noticeClasses({ tone: issue.severity })}
        >
          <strong
            className={cx(
              "flex items-center gap-1.5 font-semibold",
              issue.severity === "error" ? "text-refuse" : "text-local",
            )}
          >
            <IssueGlyph issue={issue} />
            {issue.title}
          </strong>
          {issue.details.map((detail) => (
            <p key={detail} className="mt-1 mb-0 text-caption wrap-anywhere">
              {detail}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
