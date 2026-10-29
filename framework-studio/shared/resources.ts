import type { ApplyResponse, DiffLine } from "./api";
import type { Diagnostic, Mode, ModelResource } from "./model";

export interface RequirementRule {
  readonly require: readonly string[];
  readonly when?: { readonly resource: string; readonly equals: string };
  readonly message?: string;
}

export interface ResourceDetails {
  readonly file?: string;
  /** Selected-file revision only; no other variables or values are returned. */
  readonly inputFile?: { readonly exists: boolean; readonly hash: string };
  /** Only the selected, declared key is returned. Never included in a snapshot. */
  readonly value?: string;
  readonly configured: boolean;
}

/** One graph's settings for an authored input, as an edit states them. */
export interface InputModeIntent {
  /** The graph holds the input. Written as `.only()` when only one graph does. */
  readonly present: boolean;
  readonly required: boolean;
  /** null: nothing stands in when the file leaves it blank. Secrets never have one. */
  readonly default: string | null;
}

export interface ResourceIntent {
  readonly resource: string;
  readonly kind: "input" | "secret";
  /** Presence, requirement and fallback in each graph. */
  readonly modes: Readonly<Record<Mode, InputModeIntent>>;
  /** Empty means an ungrouped catalog entry. */
  readonly group: string;
  readonly requirements: Readonly<Record<string, "required" | "optional">>;
}

/** An input's declared settings per graph, as an edit starts from them. */
export function inputModeIntents(resource: ModelResource): Record<Mode, InputModeIntent> {
  const intent = (mode: Mode): InputModeIntent => {
    const policy = resource.modes?.[mode] ?? { present: !resource.absent, required: !!resource.required, default: resource.default };
    return { present: policy.present, required: policy.present && policy.required, default: policy.present ? policy.default ?? null : null };
  };
  return { dev: intent("dev"), prod: intent("prod") };
}

export const sameInputModes = (a: ResourceIntent["modes"], b: ResourceIntent["modes"]) =>
  (["dev", "prod"] as const).every((mode) => a[mode].present === b[mode].present && a[mode].required === b[mode].required && a[mode].default === b[mode].default);

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
}
