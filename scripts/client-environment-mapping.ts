export const CLIENT_ENVIRONMENT_FILE = "framework-config/client-environment.ts";

/** Public client-variable references. These declarations never contain secret values. */
export type ClientEnvironmentBinding = (
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "output"; readonly stack: string; readonly outputs: readonly string[]; readonly optional?: boolean }
  | { readonly kind: "region"; readonly stack: string }
  | { readonly kind: "endpoint"; readonly protocol: "http" | "https" | "ws" | "wss"; readonly host?: string; readonly port: string; readonly override?: string }
  | { readonly kind: "empty" }
) & { readonly enabled?: boolean; readonly when?: { readonly input: string; readonly equals: string } };

export type ClientEnvironmentMappings = Readonly<Record<string, Readonly<Record<"dev" | "prod", ClientEnvironmentBinding>>>>;

export const publicInputName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY/i.test(name);

/** Shared draft/request validation. Only references can enter source and graph data. */
export function clientMappingsError(value: unknown): string | undefined {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(value) || Object.keys(value).length > 100) return "Use at most 100 client fields.";
  for (const [name, modes] of Object.entries(value)) {
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) return "Client field names must start with VITE_ and use uppercase letters, digits and underscores.";
    if (!object(modes) || Object.keys(modes).some((mode) => mode !== "dev" && mode !== "prod")) return `${name}: supply Development and Production mappings.`;
    for (const mode of ["dev", "prod"] as const) {
      const binding = modes[mode];
      if (!object(binding) || (binding.enabled !== undefined && typeof binding.enabled !== "boolean")) return `${name}: invalid mapping.`;
      const keys: Record<string, string[]> = { input: ["name"], output: ["stack", "outputs", "optional"], region: ["stack"], endpoint: ["protocol", "host", "port", "override"], empty: [] };
      if (typeof binding.kind !== "string" || !Object.hasOwn(keys, binding.kind) || Object.keys(binding).some((key) => !["kind", "enabled", "when", ...keys[binding.kind as string]!].includes(key))) return `${name}: choose a supported reference.`;
      if (binding.when !== undefined && (!object(binding.when) || Object.keys(binding.when).some((key) => key !== "input" && key !== "equals") || typeof binding.when.input !== "string" || !publicInputName(binding.when.input) || typeof binding.when.equals !== "string" || !binding.when.equals.trim() || binding.when.equals !== binding.when.equals.trim() || binding.when.equals.length > 512)) return `${name}: choose a public input parameter and comparison.`;
      if (binding.kind === "input" && (typeof binding.name !== "string" || !publicInputName(binding.name))) return `${name}: choose a public CDK input.`;
      if ((binding.kind === "output" || binding.kind === "region") && (typeof binding.stack !== "string" || !/^[A-Za-z_$][\w$]*$/.test(binding.stack))) return `${name}: choose a stack.`;
      if (binding.kind === "output" && (!Array.isArray(binding.outputs) || !binding.outputs.length || binding.outputs.length > 16 || binding.outputs.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) || (binding.optional !== undefined && typeof binding.optional !== "boolean"))) return `${name}: choose a public stack output.`;
      if (binding.kind === "endpoint" && (!["http", "https", "ws", "wss"].includes(String(binding.protocol)) || typeof binding.port !== "string" || !publicInputName(binding.port) || (binding.override !== undefined && (typeof binding.override !== "string" || !publicInputName(binding.override))) || (binding.host !== undefined && (typeof binding.host !== "string" || !/^[A-Za-z0-9.-]+$/.test(binding.host))))) return `${name}: choose a public port input, protocol and hostname.`;
    }
  }
  return undefined;
}
