import path from "node:path";
import { performance } from "node:perf_hooks";
import type { FrameworkConfig } from "@repo/framework/config";
import type { Mode } from "../../shared/model";
import { failedModel, projectModel } from "../model/project";
import { preflight, type PreflightRequest } from "../model/preflight";

/**
 * One mode's evaluator: a child process that loads framework.config.ts the way
 * `workflows:inspect` does, projects it, and answers preflight questions about it.
 *
 * A process per evaluation because a module graph cannot be reloaded: an
 * edited section module is only ever seen fresh by a fresh process. The parent
 * starts it with FRAMEWORK_INPUTS_FILE pointing at a file holding nothing but
 * PROD_DEPLOYMENT, so loading the catalog never reads an authored secret.
 *
 * Talks over the IPC channel only. stdout belongs to whatever the config
 * prints while it loads.
 */

const mode = process.env.STUDIO_MODE as Mode;
const webSocketApi = process.env.STUDIO_WEBSOCKET_API === "true";
const repositoryRoot = process.env.STUDIO_REPOSITORY_ROOT ?? process.cwd();

type Outgoing =
  | { readonly type: "model"; readonly model: unknown }
  | { readonly type: "preflight"; readonly id: number; readonly result: unknown };

function send(message: Outgoing): void {
  process.send?.(message);
}

/** The config, whichever way the loader surfaced its default export. */
function frameworkFrom(loaded: Record<string, unknown>): FrameworkConfig {
  let candidate: unknown = loaded.default ?? loaded;
  for (let hop = 0; hop < 3; hop += 1) {
    if (candidate && typeof candidate === "object" && "defaults" in candidate && "http" in candidate) {
      return candidate as FrameworkConfig;
    }
    candidate = (candidate as Record<string, unknown> | undefined)?.default;
  }
  throw new Error("framework.config.ts does not export its configuration as the default export.");
}

const started = performance.now();
let config: FrameworkConfig | undefined;
try {
  // `require`, as tsx gives this CommonJS module, so the config and this
  // process share one instance of @repo/framework/config.
  const loaded = require(path.join(repositoryRoot, "framework.config.ts")) as Record<string, unknown>;
  config = frameworkFrom(loaded);
  send({ type: "model", model: projectModel(config, { mode, webSocketApi }, Math.round(performance.now() - started)) });
} catch (error) {
  send({ type: "model", model: failedModel(mode, error, Math.round(performance.now() - started)) });
}

process.on("message", (message: { readonly type?: string; readonly id?: number; readonly request?: PreflightRequest }) => {
  if (message?.type !== "preflight" || typeof message.id !== "number" || !message.request) return;
  const result = config
    ? preflight(config, message.request, { mode, webSocketApi })
    : {
        mode,
        ok: false,
        diagnostics: [{ severity: "error", stage: "load", message: "The configuration did not load, so nothing can be checked against it." }],
      };
  send({ type: "preflight", id: message.id, result });
});

process.on("disconnect", () => process.exit(0));
