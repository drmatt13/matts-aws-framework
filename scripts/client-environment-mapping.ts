/** Public client-variable references. These declarations never contain secret values. */
export type ClientEnvironmentBinding = (
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "output"; readonly stack: string; readonly outputs: readonly string[]; readonly optional?: boolean }
  | { readonly kind: "region"; readonly stack: string }
  | { readonly kind: "endpoint"; readonly protocol: "http" | "https" | "ws" | "wss"; readonly host?: string; readonly port: string; readonly override?: string }
  | { readonly kind: "empty" }
) & { readonly enabled?: boolean };

export type ClientEnvironmentMappings = Readonly<Record<string, Readonly<Record<"dev" | "prod", ClientEnvironmentBinding>>>>;
