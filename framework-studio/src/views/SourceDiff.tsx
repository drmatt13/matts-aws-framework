import { Fragment } from "react";
import type { DiffLine } from "../../shared/api";
import { cx } from "../ui/classes";

const diffCellClasses =
  "px-2.5 py-0 whitespace-pre align-top text-meta leading-[1.7]";

/**
 * A reviewed change to one source file, as every source review shows one: the
 * file, its hunks, old and new line numbers, and removed and added lines in red
 * and green.
 */
export function SourceDiff({
  file,
  lines,
  note,
}: {
  readonly file: string;
  readonly lines: readonly DiffLine[];
  /** Beside the file name, such as "New file". */
  readonly note?: string;
}) {
  return (
    <div
      className="border border-rule rounded-md overflow-auto font-mono text-[0.8rem]"
      role="region"
      tabIndex={0}
      aria-label={`Changes to ${file}`}
      data-slot="diff"
    >
      {/* One width for the bar and the lines, so the bar's color runs as far as the longest line scrolls. */}
      <div className="w-max min-w-full">
        <div className="border-b border-rule bg-wash px-2.5 py-1.5 text-meta">
          <span className="sticky left-2.5 whitespace-nowrap">
            {file}
            {note ? ` · ${note}` : ""}
          </span>
        </div>
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, at) => (
              <Fragment key={at}>
                {line.hunk ? (
                  <tr className="bg-paper" data-slot="hunk">
                    <td className={diffCellClasses} colSpan={3}>
                      {line.hunk}
                    </td>
                  </tr>
                ) : null}
                <tr
                  className={
                    line.kind === "add"
                      ? "bg-added"
                      : line.kind === "remove"
                        ? "bg-removed"
                        : undefined
                  }
                >
                  <td
                    className={cx(
                      diffCellClasses,
                      "w-[1%] text-right text-ink select-none",
                    )}
                  >
                    {line.oldLine ?? ""}
                  </td>
                  <td
                    className={cx(
                      diffCellClasses,
                      "w-[1%] text-right text-ink select-none",
                    )}
                  >
                    {line.newLine ?? ""}
                  </td>
                  <td className={diffCellClasses}>
                    {line.kind === "add"
                      ? "+"
                      : line.kind === "remove"
                        ? "-"
                        : " "}
                    {line.text}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
