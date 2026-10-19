import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { DraftEdit, SnapshotResponse } from "../shared/api";
import { COMMANDS, CommandRunner } from "./commands";
import { EditError, EditService } from "./edits/transaction";
import { apiGuard, hostGuard } from "./guards";
import type { EditIntent } from "./edits/plan";
import { sha256 } from "./files";
import { ResourceService, readResourceIntent } from "./resources";
import { SnapshotBuilder, type StudioState } from "./snapshot";
import { watchRepository } from "./watch";
import { InfrastructureService } from "./infrastructure";
import { createDeploymentInput } from "./deployment-inputs";
import { DeploymentInputService, inputMode, readInputEdits } from "./deployment-input-edits";
import { DeployService } from "./deploy/service";
import { deployRouter } from "./deploy/routes";

/**
 * The studio's HTTP surface: one origin, on the loopback interface only.
 *
 * Three guards stand in front of everything:
 *
 * - the Host header must name this server (`127.0.0.1:<port>` or
 *   `localhost:<port>`), so a page on another site that rebinds its own
 *   hostname to 127.0.0.1 is answered with nothing;
 * - every API call carries a per-process token, written into the page this
 *   server serves and readable by no other origin;
 * - every request that changes something must also come from this origin.
 *
 * No CORS headers are sent, ever.
 */

const STUDIO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 4590;

function portFrom(args: readonly string[]): number {
  const flag = args.indexOf("--port");
  const raw = flag >= 0 ? args[flag + 1] : process.env.STUDIO_PORT;
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`--port takes a number from 1024 to 65535, not ${raw}.`);
  return port;
}

export function readIntent(body: unknown): EditIntent {
  const record = (body ?? {}) as Record<string, unknown>;
  const intent = record.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent.target !== "string" || typeof intent.field !== "string") {
    throw new EditError(400, "An edit names a target and a field.");
  }
  if (intent.inherit === true) return { target: intent.target, field: intent.field, inherit: true };
  if (typeof intent.value !== "string" && typeof intent.value !== "number" && typeof intent.value !== "boolean") {
    throw new EditError(400, "An edit gives a string, number or boolean value, or inherit: true.");
  }
  return { target: intent.target, field: intent.field, value: intent.value };
}

export async function startServer(repositoryRoot: string, args: readonly string[]): Promise<Server> {
  const port = portFrom(args);
  const token = randomBytes(24).toString("hex");
  const log = (line: string) => process.stderr.write(`${line}\n`);

  const builder = new SnapshotBuilder(repositoryRoot, log);
  const edits = new EditService(repositoryRoot, builder);
  const resources = new ResourceService(repositoryRoot, builder);
  const inputs = new DeploymentInputService(repositoryRoot, builder);
  const commands = new CommandRunner(repositoryRoot);
  const clients = new Set<Response>();

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const infrastructure = new InfrastructureService(repositoryRoot, () => builder.current?.snapshot, undefined, () => broadcast("infrastructure", {}));
  const deploy = new DeployService(repositoryRoot, broadcast);
  let evaluating = false;
  const refresh = async (external: readonly string[]): Promise<StudioState | undefined> => {
    evaluating = true;
    broadcast("status", { evaluating: true });
    try {
      const state = await builder.refresh();
      edits.expirePlans();
      resources.expirePlans();
      inputs.expirePlans();
      broadcast("snapshot", { revision: state.snapshot.revision, external, history: edits.history() });
      return state;
    } catch (error) {
      log(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      evaluating = false;
      broadcast("status", { evaluating: false });
    }
  };

  const app = express();
  app.disable("x-powered-by");

  app.use(hostGuard(port));

  const api = express.Router();
  api.use(express.json({ limit: "64kb" }));
  api.use(apiGuard(token));

  const send = (response: Response, run: () => Promise<unknown>) => {
    run().then(
      (body) => response.json(body),
      (error: unknown) => {
        const status = error instanceof EditError ? error.status : (error as { status?: number }).status ?? 500;
        response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      },
    );
  };

  api.get("/snapshot", (_request, response) => {
    const state = builder.current;
    if (!state) {
      response.status(503).json({ error: "The first evaluation is still running." });
      return;
    }
    const body: SnapshotResponse = {
      snapshot: state.snapshot,
      history: edits.history(),
      evaluating,
      commands: Object.fromEntries(
        Object.entries(COMMANDS).map(([name, { label, description, writes }]) => [name, { label, description, writes }]),
      ),
      busy: commands.busy ?? null,
    };
    response.json(body);
  });

  api.get("/events", (request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    response.write(`event: hello\ndata: ${JSON.stringify({ revision: builder.current?.snapshot.revision ?? null, evaluating })}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
  });

  api.get("/infrastructure", (request, response) => send(response, async () => infrastructure.get(request.query.mode === "prod" ? "prod" : "dev")));
  api.post("/deployment-inputs/create", (request, response) => send(response, async () => {
    if (request.body?.mode !== "dev" && request.body?.mode !== "prod") throw new EditError(400, "Choose development or production inputs.");
    const result = createDeploymentInput(repositoryRoot, request.body.mode);
    await refresh([result.file]);
    return result;
  }));
  api.get("/deployment-inputs/details", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    send(response, async () => inputs.details(inputMode(request.query.mode)));
  });
  api.post("/deployment-inputs/plan", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    send(response, async () => inputs.plan(inputMode(request.body?.mode), readInputEdits(request.body?.edits), String(request.body?.hash ?? ""), String(request.body?.revision ?? "")));
  });
  api.post("/deployment-inputs/apply", (request, response) => send(response, async () => {
    const result = await inputs.apply(String(request.body?.planId ?? ""));
    edits.expirePlans(); resources.expirePlans();
    broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
    return result;
  }));
  api.post("/infrastructure/synthesize", (request, response) => send(response, async () => {
    if (request.body?.mode !== "dev" && request.body?.mode !== "prod") throw new EditError(400, "Choose development or production synthesis.");
    if (request.body.profile !== undefined && typeof request.body.profile !== "string") throw new EditError(400, "An AWS profile is a name.");
    return infrastructure.synthesize(request.body.mode, request.body.profile || undefined);
  }));

  api.get("/resources/details", (request, response) => send(response, async () => resources.details(String(request.query.id ?? ""), request.query.mode === "prod" ? "prod" : "dev")));
  api.post("/resources/plan", (request, response) => send(response, () => resources.plan(readResourceIntent(request.body), String(request.body?.revision ?? ""), request.body?.mode === "prod" ? "prod" : "dev")));
  api.post("/resources/apply", (request, response) => send(response, async () => {
    const result = await resources.apply(String(request.body?.planId ?? ""));
    edits.expirePlans();
    broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
    return result;
  }));
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/resources/${direction}`, (_request, response) => send(response, async () => {
      const result = await resources.replay(direction);
      edits.expirePlans();
      broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
      return result;
    }));
  }

  api.post("/routes/plan", (request, response) => send(response, async () => {
    if (typeof request.body?.route !== "string" || typeof request.body?.value !== "string") throw new EditError(400, "A route edit names a route and its new path.");
    return edits.planRoute(request.body.route, request.body.value, String(request.body.revision ?? ""));
  }));

  api.post("/edits/plan", (request, response) =>
    send(response, () => edits.plan(readIntent(request.body), String((request.body as { revision?: unknown })?.revision ?? ""))),
  );
  api.post("/edits/batch/plan", (request, response) => send(response, () => {
    const entries = request.body?.edits;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new EditError(400, "A draft contains between 1 and 100 setting changes.");
    const parsed: DraftEdit[] = entries.map((edit: unknown) => {
      const item = edit as Record<string, unknown> | undefined;
      if (item?.kind === "field") return { kind: "field", intent: readIntent(item) };
      if (item?.kind === "description" && typeof item.entity === "string" && typeof item.value === "string") return { kind: "description", entity: item.entity, value: item.value };
      if (item?.kind === "route" && typeof item.route === "string" && typeof item.value === "string") return { kind: "route", route: item.route, value: item.value };
      if (item?.kind === "triggers" && typeof item.event === "string" && Array.isArray(item.bindings)) return { kind: "triggers", event: item.event, bindings: item.bindings };
      if (item?.kind === "nativeTrigger" && typeof item.edge === "string") return { kind: "nativeTrigger", edge: item.edge };
      if (item?.kind === "onFailure" && typeof item.event === "string" && (item.value === null || (typeof item.value === "object" && !Array.isArray(item.value)))) return { kind: "onFailure", event: item.event, value: item.value as never };
      throw new EditError(400, "A draft change names an editable field, description, HTTP route or trigger.");
    });
    return edits.planBatch(parsed, String(request.body?.revision ?? ""));
  }));
  api.post("/edits/batch/apply", (request, response) => send(response, async () => {
    const result = await edits.applyBatch(String(request.body?.planId ?? ""));
    resources.expirePlans();
    broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
    return result;
  }));
  api.post("/cdk-links/refresh", (_request, response) =>
    send(response, async () => {
      const state = await refresh([]);
      if (!state) throw new EditError(503, "CDK links could not be refreshed. See the studio server output.");
      return { edges: state.snapshot.source.cdkLinks.edges.length, files: Object.keys(state.snapshot.source.cdkLinks.files).length };
    }),
  );
  api.post("/edits/apply", (request, response) =>
    send(response, async () => {
      const result = await edits.apply(String((request.body as { planId?: unknown })?.planId ?? ""));
      broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
      return result;
    }),
  );
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/edits/${direction}`, (_request, response) =>
      send(response, async () => {
        const result = await edits[direction]();
        broadcast("snapshot", { revision: result.revision, external: [], history: edits.history() });
        return result;
      }),
    );
  }
  api.post("/commands/:name", (request, response) =>
    send(response, async () => {
      const name = String(request.params.name);
      broadcast("command", { name, running: true });
      try {
        return await commands.run(name, (request.body as { confirmed?: unknown })?.confirmed === true);
      } finally {
        broadcast("command", { name, running: false });
      }
    }),
  );

  api.use("/deploy", deployRouter(deploy));

  app.use("/api", api);

  const server = createServer(app);
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    root: STUDIO_ROOT,
    configFile: path.join(STUDIO_ROOT, "vite.config.mts"),
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
      allowedHosts: ["127.0.0.1", "localhost"],
      fs: { strict: true, allow: [STUDIO_ROOT, path.join(repositoryRoot, "node_modules")] },
    },
  });
  app.use(vite.middlewares);
  app.use(async (request: Request, response: Response, next: NextFunction) => {
    if (request.method !== "GET") {
      next();
      return;
    }
    try {
      const page = await vite.transformIndexHtml(request.originalUrl, readFileSync(path.join(STUDIO_ROOT, "index.html"), "utf8"));
      response
        .status(200)
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(page.replace("</head>", `<meta name="studio-token" content="${token}" />\n</head>`));
    } catch (error) {
      next(error);
    }
  });

  const stopWatching = watchRepository(repositoryRoot, (files) => {
    // A file this studio just wrote, still holding exactly what it wrote, is
    // its own change; anything else was changed by someone else.
    const external = files.filter((file) => {
      const owner = inputs.ownWrites.has(file) ? inputs.ownWrites : resources.ownWrites.has(file) ? resources.ownWrites : edits.ownWrites;
      const written = owner.get(file);
      if (written === undefined) return true;
      try {
        if (sha256(readFileSync(path.join(repositoryRoot, file), "utf8")) === written) {
          owner.delete(file);
          return false;
        }
      } catch {
        // Removed since: someone else's change.
      }
      return true;
    });
    if (external.length > 0) void refresh(external);
  });

  log("Evaluating the repository…");
  await refresh([]);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  log(`Framework Studio is running at http://127.0.0.1:${port}/`);

  const shutdown = async () => {
    stopWatching();
    for (const client of clients) client.end();
    await deploy.dispose();
    await vite.close();
    await builder.dispose();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return server;
}
