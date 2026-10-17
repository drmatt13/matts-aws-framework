import type { ApplyResponse, DiffLine, HistoryState } from "./api";
import type { Diagnostic } from "./model";

export interface RequirementRule {
  readonly require: readonly string[];
  readonly when?: { readonly resource: string; readonly equals: string };
  readonly message?: string;
}

export interface ResourceDetails {
  /** Only the selected, declared key is returned. Never included in a snapshot. */
  readonly value?: string;
  readonly configured: boolean;
  readonly consumers: readonly {
    readonly target: string;
    readonly title: string;
    readonly rules: readonly RequirementRule[];
  }[];
  readonly history: HistoryState;
}

export interface ResourceIntent {
  readonly resource: string;
  readonly kind: "input" | "secret";
  /** null removes the fallback. Secrets never have a source-code fallback. */
  readonly default: string | null;
  /** Empty means an ungrouped catalog entry. */
  readonly group: string;
  readonly requirements: Readonly<Record<string, "required" | "optional">>;
}

export interface ResourcePlan {
  readonly planId: string;
  readonly resource: string;
  readonly nextResource: string;
  readonly ok: boolean;
  readonly changes: readonly { readonly file: string; readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] } }[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResourceApply extends ApplyResponse {
  readonly resource: string;
  readonly history: HistoryState;
}
