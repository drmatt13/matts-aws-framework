import type { Mode, SourceLocation } from "./model";
import type { ClientEnvironmentBinding, ClientEnvironmentMappings } from "../../scripts/client-environment-mapping";
export type { ClientEnvironmentBinding, ClientEnvironmentMappings } from "../../scripts/client-environment-mapping";

export const CLIENT_ENVIRONMENT_ID = "client-envfile";
export const CLIENT_ENVIRONMENT_ISLAND = "island:client-environment";
export const CLIENT_ENVIRONMENT_FILE = "framework-config/client-environment.ts";

export interface ClientReferenceOption {
  readonly id: string;
  readonly label: string;
  readonly group: "CDK inputs" | "Stack outputs" | "Stack regions";
  readonly binding: ClientEnvironmentBinding;
}

export function clientReferenceId(binding: ClientEnvironmentBinding): string {
  return binding.kind === "input" ? `input:${binding.name}` : binding.kind === "output" ? `output:${binding.stack}:${binding.outputs[0]}` : binding.kind === "region" ? `region:${binding.stack}` : binding.kind;
}

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
      if (typeof binding.kind !== "string" || !Object.hasOwn(keys, binding.kind) || Object.keys(binding).some((key) => !["kind", "enabled", ...keys[binding.kind as string]!].includes(key))) return `${name}: choose a supported reference.`;
      if (binding.kind === "input" && (typeof binding.name !== "string" || !publicInputName(binding.name))) return `${name}: choose a public CDK input.`;
      if ((binding.kind === "output" || binding.kind === "region") && (typeof binding.stack !== "string" || !/^[A-Za-z_$][\w$]*$/.test(binding.stack))) return `${name}: choose a stack.`;
      if (binding.kind === "output" && (!Array.isArray(binding.outputs) || !binding.outputs.length || binding.outputs.length > 16 || binding.outputs.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) || (binding.optional !== undefined && typeof binding.optional !== "boolean"))) return `${name}: choose a public stack output.`;
      if (binding.kind === "endpoint" && (!["http", "https", "ws", "wss"].includes(String(binding.protocol)) || typeof binding.port !== "string" || !publicInputName(binding.port) || (binding.override !== undefined && (typeof binding.override !== "string" || !publicInputName(binding.override))) || (binding.host !== undefined && (typeof binding.host !== "string" || !/^[A-Za-z0-9.-]+$/.test(binding.host))))) return `${name}: choose a public port input, protocol and hostname.`;
    }
  }
  return undefined;
}

export interface ClientEnvironmentSource {
  readonly entity?: string;
  readonly label: string;
  readonly available: boolean;
  readonly source?: SourceLocation;
}

export interface ClientEnvironmentEntry {
  readonly name: string;
  readonly expression: string;
  readonly required: boolean;
  /** Declaration availability only; never a claim about deployed output values. */
  readonly status: "mapped" | "unavailable" | "empty" | "disabled";
  readonly note: string;
  readonly sources: readonly ClientEnvironmentSource[];
}

export interface ClientEnvironmentFile {
  readonly path: "client-app/.env";
  readonly mode: Mode;
  readonly inputs: string;
  readonly entries: readonly ClientEnvironmentEntry[];
  readonly mappings: ClientEnvironmentMappings;
  readonly options: readonly ClientReferenceOption[];
  readonly problem?: string;
}
