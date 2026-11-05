import { call } from "./http";
import type { AgentLabModels, AgentLabProvider } from "../shared/agent-lab";

export type { AgentLabModel, AgentLabModels, AgentLabProvider } from "../shared/agent-lab";

export interface AgentLabStatus {
  readonly providers: readonly {
    readonly id: AgentLabProvider;
    readonly label: string;
    readonly available: boolean;
    readonly detail: string;
  }[];
  readonly busy: boolean;
}

export interface AgentLabPlan {
  readonly id: string;
  readonly provider: AgentLabProvider;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly message: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
  readonly expiresAt: string;
}

export const agentLabApi = {
  status: () => call<AgentLabStatus>("/agent-lab/status"),
  models: (provider: AgentLabProvider, signal?: AbortSignal, refresh = false) =>
    call<AgentLabModels>(`/agent-lab/models?provider=${provider}${refresh ? "&refresh=1" : ""}`, undefined, signal),
  plan: (provider: AgentLabProvider, prompt: string) =>
    call<AgentLabPlan>("/agent-lab/plan", { provider, prompt }),
  apply: (id: string) => call<{ applied: true; message: string }>("/agent-lab/apply", { id }),
};
