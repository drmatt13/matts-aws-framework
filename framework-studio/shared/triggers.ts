export type { TriggerAdapterMetadata, TriggerField } from "../../packages/framework/src/config/triggers";

export interface TriggerBinding {
  readonly event: string;
  readonly id: string;
  readonly key: string;
  readonly adapter: string;
  readonly resource: string;
  readonly accepts: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface TriggerCapability {
  readonly resource: string;
  readonly stack: string;
  readonly name: string;
  readonly location: import("./model").SourceLocation;
  readonly owned: boolean;
  readonly canonicalTypes: readonly string[];
  readonly facts?: Readonly<Record<string, boolean | number | undefined>>;
  readonly adapters: readonly { readonly kind: string; readonly reason?: string }[];
}

export function triggerBindingsEqual(left: readonly TriggerBinding[], right: readonly TriggerBinding[]): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.$cdk === "@repo/framework/cdk-resource" && Array.isArray(object.path)) return ["resource", ...object.path];
      return Object.entries(object).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]);
    }
    return value;
  };
  const signature = (bindings: readonly TriggerBinding[]) => JSON.stringify(bindings.map((binding) => [binding.event, binding.resource, binding.adapter, binding.id, binding.accepts, canonical(binding.options)]));
  return signature(left) === signature(right);
}
