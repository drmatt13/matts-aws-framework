import type { SourceLocation } from "./model";

export const DISPLAY_NAMES_FILE = "framework-config/display-names.ts";

/** Source refactors and presentation names have separate authorities. */
export interface NamingCapability {
  readonly code: boolean;
  readonly codeName?: string;
  readonly reason?: string;
  readonly display: boolean;
}
export interface RenameIssue {
  readonly message: string;
  readonly source: SourceLocation;
}
export interface RenameSummary {
  readonly from: string;
  readonly to: string;
  readonly referenceCount: number;
  readonly fileCount: number;
}

const reservedNames = new Set("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield constructor prototype".split(" "));
export function codeNameError(value: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) return "Use a catalog name beginning with a letter and containing only letters and digits.";
  return reservedNames.has(value) ? "Choose a name that is not a reserved TypeScript identifier." : undefined;
}

export function displayNameError(value: string): string | undefined {
  if (value.length > 120) return "Use a display name of at most 120 characters.";
  if (/[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(value)) return "Use a single-line display name without control characters.";
  return undefined;
}

/** Exact ids and descendants move together; unrelated text never does. */
export function remapEntity(entity: string, remap: Readonly<Record<string, string>>): string {
  if (Object.hasOwn(remap, entity)) return remap[entity]!;
  const owner = Object.keys(remap).filter(key => entity.startsWith(`${key}.`)).sort((a, b) => b.length - a.length)[0];
  return owner ? remap[owner]! + entity.slice(owner.length) : entity;
}
