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
  /** Selected environment-file value (private), or a standalone public source value. */
  readonly value?: string;
  readonly configured: boolean;
}

/** One graph's settings for an authored input, as an edit states them. */
export interface InputModeIntent {
  /** The graph holds the input. Written as `.only()` when only one graph does. */
  readonly present: boolean;
  readonly required: boolean;
  /** null: no environment fallback. Secrets and standalone inputs never have one. */
  readonly default: string | null;
  /** Standalone source value; no environment fallback applies. */
  readonly value?: string | null;
}

export interface ResourceIntent {
  readonly resource: string;
  readonly kind: "input" | "secret";
  /** null selects a standalone value; omitted preserves the current source for older clients. */
  readonly fromEnv?: string | null;
  /** Presence, environment fallback or standalone source value in each graph. */
  readonly modes: Readonly<Record<Mode, InputModeIntent>>;
  /** Empty means an ungrouped catalog entry. */
  readonly group: string;
  readonly requirements: Readonly<Record<string, "required" | "optional">>;
}

/** An input's declared settings per graph, as an edit starts from them. */
export function inputModeIntents(resource: ModelResource): Record<Mode, InputModeIntent> {
  const intent = (mode: Mode): InputModeIntent => {
    const policy = resource.modes?.[mode] ?? { present: !resource.absent, required: !!resource.required, default: resource.default, value: resource.authoredValue };
    return { present: policy.present, required: policy.present && policy.required, default: policy.present ? policy.default ?? null : null,
      ...(policy.present && policy.value !== undefined ? { value: policy.value } : {}) };
  };
  return { dev: intent("dev"), prod: intent("prod") };
}

export const sameInputModes = (a: ResourceIntent["modes"], b: ResourceIntent["modes"]) =>
  (["dev", "prod"] as const).every((mode) => a[mode].present === b[mode].present && a[mode].required === b[mode].required && a[mode].default === b[mode].default && (a[mode].value ?? null) === (b[mode].value ?? null));

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
