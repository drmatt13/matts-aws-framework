/** Application section types derive from the complete resource catalog. */
import type { resources } from "./resources";
import type {
  FrameworkHttp, FrameworkEvents, FrameworkServices, FrameworkTasks,
  FrameworkWebSocket, FrameworkWorkflows, FrameworkTools, FrameworkAgents,
} from "@repo/framework/config";

export type HttpSection = FrameworkHttp<typeof resources>;
export type WebSocketSection = FrameworkWebSocket<typeof resources>;
export type EventsSection = FrameworkEvents<typeof resources>;
export type ServicesSection = FrameworkServices<typeof resources>;
export type TasksSection = FrameworkTasks<typeof resources>;
export type WorkflowsSection = FrameworkWorkflows;
export type ToolsSection = FrameworkTools<typeof resources>;
export type AgentsSection = FrameworkAgents<typeof resources>;
