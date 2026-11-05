import type { SourceLocation } from "../../shared/model";
import type { SightlineOmission, SightlineRecord } from "./types";

/** Stable across browser/server locale settings. */
export const lexical = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function omit(
  omitted: SightlineOmission[],
  path: string,
  reason: SightlineOmission["reason"],
  count?: number,
): void {
  // Collection wildcard paths keep omission evidence bounded without dropping which
  // field was cut. Counts aggregate partial and later full cuts of the same field.
  path = path.replace(/\[\d+\]|\.\d+(?=\.|$)/g, "[]");
  const at = omitted.findIndex(
    (item) => item.path === path && item.reason === reason,
  );
  if (at === -1)
    omitted.push({ path, reason, ...(count === undefined ? {} : { count }) });
  else if (count !== undefined)
    omitted[at] = { path, reason, count: (omitted[at]!.count ?? 0) + count };
}

/** Source-authored prose stays data. Paths embedded in prose never disclose a home directory. */
export function text(
  value: string,
  path: string,
  omitted: SightlineOmission[],
  limit = 240,
): string {
  const sanitized = value
    .replace(
      /(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:[\\/]Users[\\/])[^\s"'<>),;]*/g,
      "[private path]",
    )
    .replace(/\barn:(?:aws|aws-cn|aws-us-gov):[^\s"'<>),;]*/g, "[ARN omitted]")
    .replace(/\b\d{12}\b/g, "[account omitted]");
  if (sanitized !== value) omit(omitted, path, "privacy");
  if (sanitized.length <= limit) return sanitized;
  omit(omitted, path, "budget", sanitized.length - limit);
  return sanitized.slice(0, limit - 1) + "…";
}

export function relativePath(
  value: string | undefined,
  path: string,
  omitted: SightlineOmission[],
  repositoryRoot?: string,
): string | undefined {
  if (value === undefined) return undefined;
  const original = value.replaceAll("\\", "/");
  const root = repositoryRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalized =
    root && original.startsWith(`${root}/`)
      ? original.slice(root.length + 1)
      : original;
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    omit(omitted, path, "privacy");
    return undefined;
  }
  return text(normalized, path, omitted);
}

export function sourceLocation(
  value: SourceLocation | undefined,
  path: string,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (!value) return { availability: "not-loaded" };
  const file = relativePath(value.file, `${path}.file`, omitted);
  return file
    ? {
        availability: "available",
        file,
        line: value.line,
        column: value.column,
      }
    : { availability: "not-loaded" };
}

export function bounded<T>(
  values: readonly T[],
  limit: number,
  path: string,
  omitted: SightlineOmission[],
): readonly T[] {
  if (values.length > limit)
    omit(omitted, path, "budget", values.length - limit);
  return values.slice(0, limit);
}

export const notApplicable = (): SightlineRecord => ({
  availability: "not-applicable",
});
