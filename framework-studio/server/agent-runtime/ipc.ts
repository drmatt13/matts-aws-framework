import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import { privateEndpoint } from "../operations/ipc";
import { AgentRuntimeError } from "./store";
import type { ExecutionIdentity } from "../../shared/operations";

export interface AgentHostInfo { readonly version: number; readonly root: string; readonly state: string; readonly pid: number; readonly identity: ExecutionIdentity; readonly releaseDigest?: string }

/** Private per-checkout state is never a child of editable project source. */
export function agentStateDirectory(root: string, override?: string): string {
  if (override) return path.resolve(override);
  const identity = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
  return path.join(realpathSync(homedir()), ".local", "state", "aws-studio", "agents", identity);
}

export function agentEndpoint(root: string, state: string): string {
  // Reuse the existing owner/type/permission checks and macOS socket length
  // handling. A distinct filename and state identity separate the protocols.
  return path.join(privateEndpoint(root, state).directory, "agent.sock");
}

export function callAgentHost<T>(socketPath: string, route: string, body?: unknown, timeout = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path: route, method: encoded === undefined ? "GET" : "POST", headers: {
      "x-agent-version": String(AGENT_RUNTIME_VERSION),
      ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }),
    } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) response.destroy(new AgentRuntimeError(502, "Agent response exceeds its bounded replay page.")); else chunks.push(chunk); });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) reject(new AgentRuntimeError(response.statusCode ?? 500, typeof result.error === "string" ? result.error : "Agent host request failed."));
          else resolve(result as T);
        } catch { reject(new AgentRuntimeError(502, "Agent host returned unreadable evidence.")); }
      });
    });
    req.once("error", reject);
    req.setTimeout(timeout, () => req.destroy(new AgentRuntimeError(504, "The task may still be running. Reconnect with its existing task ID; do not resubmit a new intent.")));
    req.end(encoded);
  });
}
