import { Readable } from "node:stream";
import type express from "express";
import type { FrameworkConfig } from "@repo/framework/config";
import {
  assertLocalInvocationEdge,
  handleLocalGatewayRequest,
  type GatewayToolManifest,
  type LocalToolInvoker,
} from "@repo/framework/local";
import type { AgentForward } from "./agents";

/**
 * The runner's AgentCore surface: an agent's invocations, and its Gateway.
 *
 * `POST /agents/<id>/invocations` is the local Runtime endpoint. A backend
 * caller names itself in x-framework-caller and must have declared
 * `invokesAgent(<id>)` — the local half of the IAM grant. A request without a
 * caller has come from the browser through the local API dev server, which
 * verified the user, and only an agent with users is reachable that way; the
 * agent's adapter verifies the token again.
 *
 * `POST /agents/<id>/gateway` is that agent's emulated Gateway.
 */

/** The part of LocalAgentSupervisor these routes use. */
export interface AgentInvoker {
  invoke(id: string, request: AgentForward, consume: (response: Response) => Promise<void>): Promise<void>;
}

export interface AgentRouteOptions {
  readonly config: FrameworkConfig;
  readonly agents: AgentInvoker;
  /** Runs tool Lambdas. A fresh process per call, so an edited tool runs as edited. */
  readonly tools: LocalToolInvoker;
  readonly loadTools: () => Promise<GatewayToolManifest>;
}

const FORWARDED_HEADERS = ["content-type", "authorization", "x-amzn-bedrock-agentcore-runtime-session-id"];
const RETURNED_HEADERS = ["content-type", "cache-control"];

export function registerAgentRoutes(app: express.Express, options: AgentRouteOptions): void {
  app.post("/agents/:id/invocations", async (request, response) => {
    const id = String(request.params.id);
    const declaration = options.config.agents?.[id];
    const caller = request.header("x-framework-caller");
    try {
      if (caller) {
        assertLocalInvocationEdge(options.config, caller, `agent:${id}`);
      } else if (declaration?.auth !== true) {
        response.status(403).json({
          error: `agent:${id} has no auth: true, so it is reachable only from a workload that declares invokesAgent("${id}").`,
        });
        return;
      }
    } catch (error) {
      response.status(403).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.header(name);
      if (value !== undefined) headers[name] = value;
    }

    try {
      await options.agents.invoke(
        id,
        { headers, body: JSON.stringify(request.body), signal: controller.signal },
        async (reply) => {
          response.status(reply.status);
          for (const name of RETURNED_HEADERS) {
            const value = reply.headers.get(name);
            if (value !== null) response.setHeader(name, value);
          }
          if (!reply.body) {
            response.end();
            return;
          }
          // Streamed through as it arrives, so server-sent events reach the
          // browser as the agent yields them.
          const body = Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]);
          body.pipe(response);
          await new Promise<void>((resolve) => {
            body.once("end", resolve);
            body.once("error", () => resolve());
            response.once("close", resolve);
          });
        },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[agent:${id}] Invocation failed:`, error);
      if (!response.headersSent) response.status(502).json({ error: "LOCAL_AGENT_UNAVAILABLE" });
      else response.end();
    }
  });

  app.post("/agents/:id/gateway", async (request, response) => {
    const id = String(request.params.id);
    if (!options.config.agents?.[id]) {
      response.status(404).json({ error: `agent:${id} is not declared.` });
      return;
    }
    try {
      const reply = await handleLocalGatewayRequest(options.config, options.tools, id, request.body, await options.loadTools());
      if (reply === undefined) response.status(202).end();
      else response.json(reply);
    } catch (error) {
      console.error(`[agent:${id}] Gateway request failed:`, error);
      response.status(500).json({ error: "LOCAL_GATEWAY_FAILED" });
    }
  });
}
