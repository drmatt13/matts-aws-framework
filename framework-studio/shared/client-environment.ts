import type { Mode, SourceLocation } from "./model";
import type { ClientEnvironmentBinding, ClientEnvironmentMappings } from "../../scripts/client-environment-mapping";
export type { ClientEnvironmentBinding, ClientEnvironmentMappings } from "../../scripts/client-environment-mapping";

export const CLIENT_ENVIRONMENT_ID = "client-envfile";
export const CLIENT_ENVIRONMENT_ISLAND = "island:client-environment";
export { CLIENT_ENVIRONMENT_FILE } from "../../scripts/client-environment-mapping";

export interface ClientReferenceOption {
  readonly id: string;
  readonly label: string;
  readonly group: "CDK inputs" | "Stack outputs" | "Stack regions";
  readonly binding: ClientEnvironmentBinding;
}

export function clientReferenceId(binding: ClientEnvironmentBinding): string {
  return binding.kind === "input" ? `input:${binding.name}` : binding.kind === "output" ? `output:${binding.stack}:${binding.outputs[0]}` : binding.kind === "region" ? `region:${binding.stack}` : binding.kind;
}

export { publicInputName, clientMappingsError } from "../../scripts/client-environment-mapping";

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
