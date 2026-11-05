export type AgentLabProvider = "codex" | "claude";

export interface AgentLabModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

/** Choices reported by the authenticated local CLI, never an application-owned catalog. */
export interface AgentLabModels {
  readonly provider: AgentLabProvider;
  readonly models: readonly AgentLabModel[];
  readonly source: "cli";
  readonly problem?: string;
}
