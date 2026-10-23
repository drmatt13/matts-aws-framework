/** Source observations only; contains no source text or environment values. */
export interface SourceWatchState {
  readonly status: "watching" | "polling" | "unavailable";
  readonly checkedAt: string;
  readonly pollIntervalMs: number;
  readonly problems: readonly { readonly path: string; readonly code: string }[];
}
