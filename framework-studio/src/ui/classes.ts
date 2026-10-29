/** Compose complete, statically discoverable class strings. Appearance belongs in variants. */
export function cx(...classes: readonly (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
