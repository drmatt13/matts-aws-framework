import type { DraftEdit } from "./api";

export type WorkloadOperation = Extract<DraftEdit, { kind: "implementation" | "connection" | "removeWorkload" }>;
const connections = ["database", "userPool", "runsTask", "startsWorkflow", "invokesAgent", "tool", "resource", "grant"];
const grants = ["grantRead", "grantWrite", "grantReadWrite", "grantSendMessages", "grantConsumeMessages"];
/** Shared typed request boundary; source text, commands and arbitrary destinations are never accepted. */
export function readWorkloadOperation(raw: unknown): WorkloadOperation {
  const fail = (): never => { throw new Error("Choose a supported workload implementation, connection or removal operation with a canonical declared target."); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (!["implementation", "connection", "removeWorkload"].includes(String(item.kind)) || typeof item.target !== "string" || !/^(?:lambda|service|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*$/.test(item.target)) return fail();
  const allowed = item.kind === "connection" ? ["kind", "target", "connection", "destination", "enabled", "variable", "grant", "scope"] : ["kind", "target"];
  if (Object.keys(item).some(key => !allowed.includes(key))) return fail();
  if (item.kind === "connection") {
    if (!connections.includes(String(item.connection)) || typeof item.enabled !== "boolean") return fail();
    if (item.destination !== undefined && (typeof item.destination !== "string" || item.destination.length > 300 || !/^(?:resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|(?:lambda|service|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*)$/.test(item.destination))) return fail();
    if (item.variable !== undefined && (typeof item.variable !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.variable))) return fail();
    if (item.grant !== undefined && !grants.includes(String(item.grant))) return fail();
    if (item.scope !== undefined && (typeof item.scope !== "string" || item.scope.length > 256 || /[\r\n\0]/.test(item.scope))) return fail();
  }
  return item as unknown as WorkloadOperation;
}
