import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { SnapshotResponse } from "../shared/api";
import { COMMANDS, CommandRunner } from "./commands";
import { EditError, EditService } from "./edits/transaction";
import { apiGuard, hostGuard } from "./guards";
import type { EditIntent } from "./edits/plan";
import { sha256 } from "./files";
import { SnapshotBuilder, type StudioState } from "./snapshot";
import { watchRepository } from "./watch";

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

function readIntent(body: unknown): EditIntent {
  const record = (body ?? {}) as Record<string, unknown>;
  const intent = record.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent.target !== "string" || typeof intent.field !== "string") {
    throw new EditError(400, "An edit names a target and a field.");
  }
  if (intent.inherit === true) return { target: intent.target, field: intent.field, inherit: true };
  if (typeof intent.value !== "string" && typeof intent.value !== "number") {
    throw new EditError(400, "An edit gives a string or number value, or inherit: true.");
  }
  return { target: intent.target, field: intent.field, value: intent.value };
}

export async function startServer(repositoryRoot: string, args: readonly string[]): Promise<Server> {
  const port = portFrom(args);
  const token = randomBytes(24).toString("hex");
  const log = (line: string) => process.stderr.write(`${line}\n`);

  const builder = new SnapshotBuilder(repositoryRoot, log);
  const edits = new EditService(repositoryRoot, builder);
  const commands = new CommandRunner(repositoryRoot);
  const clients = new Set<Response>();

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  };
  let evaluating = false;
  const refresh = async (external: readonly string[]): Promise<StudioState | undefined> => {
    evaluating = true;
    broadcast("status", { evaluating: true });
    try {
      const state = await builder.refresh();
      edits.expirePlans();
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

  api.post("/edits/plan", (request, response) =>
    send(response, () => edits.plan(readIntent(request.body), String((request.body as { revision?: unknown })?.revision ?? ""))),
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
      const written = edits.ownWrites.get(file);
      if (written === undefined) return true;
      try {
        if (sha256(readFileSync(path.join(repositoryRoot, file), "utf8")) === written) {
          edits.ownWrites.delete(file);
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
    await vite.close();
    await builder.dispose();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return server;
}
