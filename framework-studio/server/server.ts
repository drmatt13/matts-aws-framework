import { readNetworkDraft } from "../shared/networks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { readCreationRequest, CreationValidationError } from "../shared/creation";
import type { DraftEdit, SnapshotResponse } from "../shared/api";
import { COMMANDS, CommandRunner } from "./commands";
import { EditError, EditService } from "./edits/transaction";
import { SourceJournal } from "./edits/journal";
import { readWorkloadOperation } from "../shared/workload-operations";
import { apiGuard, hostGuard } from "./guards";
import type { EditIntent } from "./edits/plan";
import { sha256 } from "./files";
import { ResourceService, readResourceIntent } from "./resources";
import { SnapshotBuilder, type StudioState } from "./snapshot";
import { watchRepository } from "./watch";
import type { SourceWatchState } from "../shared/watch";
import { InfrastructureService } from "./infrastructure";
import { createDeploymentInput } from "./deployment-inputs";
import { DeploymentInputService, inputMode, readInputEdits } from "./deployment-input-edits";
import { DeployService } from "./deploy/service";
import { deployRouter } from "./deploy/routes";
import { FrontendReleaseService } from "./frontend-release";
import { DeploymentIdentityService } from "./deployment-identities";
import { frontendReleaseRouter } from "./frontend-release-routes";
import { readIdentityPolicyEdit } from "./identity-policy-source";
import { IdentityPolicyService, identityPolicyRouter } from "./identity-policy";
import { sendJson } from "./http";
import { STUDIO_PROTOCOL_VERSION, STUDIO_RESTART_MESSAGE } from "../shared/protocol";
import { readDatabaseDraft, readDatabasePlacementDraft } from "../shared/managed-database";
import { DatabaseWorkbenchService } from "./database-workbench";
import { DatabaseHistoryService } from "./database-history";
import { DatabaseApplicationService } from "./database-application";
import { DatabaseCloudService } from "./database-cloud";
import { databaseSqlRouter } from "./database-sql";
import { IdentityService } from "./identity/service";
import { identityRouter } from "./identity/routes";
import { CognitoOperations } from "./identity/operations";
import { StatefulResourceService, statefulResourceRouter } from "./stateful-resources";

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


export function readDraftEdits(entries: unknown): readonly DraftEdit[] {
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new EditError(400, "A draft contains between 1 and 100 setting changes.");
    return entries.map((edit: unknown): DraftEdit => {
      const item = edit as Record<string, unknown> | undefined;
      if (["implementation", "connection", "removeWorkload"].includes(String(item?.kind))) {
        try { return readWorkloadOperation(item); } catch (error) { throw new EditError(400, error instanceof Error ? error.message : "Choose a supported workload operation."); }
      }
      if (item?.kind === "create") {
        try { return { kind: "create", request: readCreationRequest(item.request) }; }
        catch (error) { if (error instanceof CreationValidationError) throw new EditError(422, `${error.field}: ${error.message}`); throw error; }
      }
      if (item?.kind === "placement" || item?.kind === "network") {
        try { return readNetworkDraft(item); }
        catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (item?.kind === "removeNetwork" && Object.keys(item).every(key => ["kind", "network"].includes(key)) && typeof item.network === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(item.network)) return { kind: "removeNetwork", network: item.network };
      if (item?.kind === "database") {
        try { return readDatabaseDraft(item); } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (item?.kind === "databasePlacement") {
        try { return readDatabasePlacementDraft(item); } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (item?.kind === "field") return { kind: "field", intent: readIntent(item) };
      if (item?.kind === "identityPolicy") return readIdentityPolicyEdit(item);
      if (item?.kind === "clientEnvironment") return { kind: "clientEnvironment", mappings: item.mappings as never };
      if (item?.kind === "tags" && Object.keys(item).every(key => ["kind", "entity", "tags"].includes(key)) && typeof item.entity === "string" && item.tags && typeof item.tags === "object" && !Array.isArray(item.tags)) return { kind: "tags", entity: item.entity, tags: item.tags as Readonly<Record<string, string>> };
      if (item?.kind === "description" && typeof item.entity === "string" && typeof item.value === "string") return { kind: "description", entity: item.entity, value: item.value };
      if (item?.kind === "route" && typeof item.route === "string" && typeof item.value === "string") return { kind: "route", route: item.route, value: item.value };
      if (item?.kind === "triggers" && typeof item.event === "string" && Array.isArray(item.bindings)) return { kind: "triggers", event: item.event, bindings: item.bindings };
      if (item?.kind === "nativeTrigger" && typeof item.edge === "string") return { kind: "nativeTrigger", edge: item.edge };
      if (item?.kind === "onFailure" && typeof item.event === "string" && (item.value === null || (typeof item.value === "object" && !Array.isArray(item.value)))) return { kind: "onFailure", event: item.event, value: item.value as never };
      throw new EditError(400, "A draft change names an editable field, description, HTTP route or trigger.");
    });
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
  let sourceWatch: SourceWatchState | undefined;

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const infrastructure = new InfrastructureService(repositoryRoot, () => builder.current?.snapshot, undefined, () => broadcast("infrastructure", {}));
  const deploy = new DeployService(repositoryRoot, broadcast);
  const stateful = new StatefulResourceService(repositoryRoot, builder, deploy);
  /** Every preview was offered against one snapshot; a new one expires them all, whoever wrote it. */
  const published = (revision: string, external: readonly string[] = []) => {
    edits.expirePlans();
    resources.expirePlans();
    inputs.expirePlans();
    stateful.expirePlans();
    broadcast("snapshot", { revision, external, history: edits.history() });
  };
  let evaluating = false;
  const refresh = async (external: readonly string[]): Promise<StudioState | undefined> => {
    evaluating = true;
    broadcast("status", { evaluating: true });
    try {
      const state = await builder.refresh();
      published(state.snapshot.revision, external);
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
  api.use(express.json({ limit: "640kb" }));
  api.use(apiGuard(token));
  api.use((request, response, next) => {
    if (request.method !== "GET" && request.get("x-studio-protocol") !== STUDIO_PROTOCOL_VERSION) {
      response.status(409).json({ error: STUDIO_RESTART_MESSAGE }); return;
    }
    next();
  });
  const send = sendJson;
  api.use("/identity-policy", identityPolicyRouter(new IdentityPolicyService(repositoryRoot, () => builder.current)));
  api.use("/database/sql", databaseSqlRouter(repositoryRoot));
  api.use("/frontend-release", frontendReleaseRouter(new FrontendReleaseService(repositoryRoot), new DeploymentIdentityService(repositoryRoot), () => { void refresh([]); }));
  const identityService = new IdentityService(repositoryRoot, deploy);
  api.use("/identity", identityRouter(identityService, new CognitoOperations(repositoryRoot, identityService)));
  api.use("/stateful-resources", statefulResourceRouter(stateful, revision => published(revision)));
  const sourceJournal = new SourceJournal(repositoryRoot);
  const recoveryState = () => { try { return { sourceRecovery: sourceJournal.pending() }; } catch (error) { return { sourceRecoveryProblem: `Source recovery records cannot be read: ${error instanceof Error ? error.message : String(error)}. Source writes remain blocked; inspect .cache/framework-studio/transactions without discarding user files.` }; } };
  api.get("/source-recovery", (_request, response) => send(response, async () => sourceJournal.pending()));
  api.post("/source-recovery/restore", (request, response) => send(response, async () => {
    const result = sourceJournal.restore(String(request.body?.id ?? ""), String(request.body?.approval ?? ""));
    await refresh([]);
    return result;
  }));
  api.post("/source-recovery/keep", (request, response) => send(response, async () => {
    const state = await refresh([]);
    if (!state || Object.values(state.snapshot.models).some(model => model.stale || model.status === "error" || model.targets.some(target => target.implementation && !target.implementation.ready))) throw new EditError(422, "Current source or implementation artifacts need attention. Fix the reported configuration/implementation errors, refresh, then review recovery again. No files were changed.");
    return sourceJournal.keepCurrent(String(request.body?.id ?? ""), String(request.body?.fingerprint ?? ""), String(request.body?.approval ?? ""));
  }));
  const database = new DatabaseWorkbenchService(repositoryRoot, () => refresh([]));
  const databaseHistory = new DatabaseHistoryService(repositoryRoot);
  const databaseApplication = new DatabaseApplicationService(repositoryRoot, database, () => databaseHistory.load());
  const databaseCloud = new DatabaseCloudService(repositoryRoot);
  const requestSignal = (request: Request, response: Response) => {
    const controller = new AbortController();
    request.on("aborted", () => controller.abort());
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    return controller.signal;
  };
  api.get("/database/workbench", (_request, response) => send(response, () => database.load()));
  api.post("/database/workbench/validate", (request, response) => send(response, () => database.validate(request.body?.source, requestSignal(request, response))));
  api.post("/database/workbench/format", (request, response) => send(response, () => database.format(request.body?.source)));
  api.post("/database/workbench/review", (request, response) => send(response, () => database.review(request.body?.source, String(request.body?.expectedRevision ?? ""))));
  api.post("/database/workbench/save", (request, response) => send(response, () => database.save(String(request.body?.reviewId ?? ""))));
  api.post("/database/workbench/inspect", (request, response) => send(response, async () => {
    const history = await databaseHistory.load();
    const result = await database.inspect(String(request.body?.targetId ?? ""), String(request.body?.expectedRevision ?? ""), history.revision, history);
    const after = await databaseHistory.load();
    return after.revision === history.revision ? result : { ...result, status: "stale", message: "Migration history changed during inspection. Inspect again before using this evidence." };
  }));
  api.get("/database/history", (_request, response) => send(response, () => databaseHistory.load()));
  api.post("/database/history/compare", (request, response) => send(response, () => databaseHistory.compare(request.body, requestSignal(request, response))));
  api.post("/database/history/plan", (request, response) => send(response, () => databaseHistory.plan(request.body, requestSignal(request, response))));
  api.post("/database/history/install", (request, response) => send(response, async () => {
    const result = await databaseHistory.install(request.body);
    if (result.status === "installed") broadcast("database-history", {});
    return result;
  }));
  api.post("/database/history/discard", (request, response) => send(response, () => databaseHistory.discard(String(request.body?.reviewId ?? ""))));
  api.get("/database/application/operations", (_request, response) => send(response, () => databaseApplication.listOperations()));
  api.post("/database/application/review", (request, response) => send(response, () => databaseApplication.review(String(request.body?.targetId ?? ""), String(request.body?.sourceHash ?? ""), request.body?.initialize === true)));
  api.post("/database/application/apply", (request, response) => send(response, () => databaseApplication.apply(String(request.body?.reviewId ?? ""), String(request.body?.confirmation ?? ""))));
  api.post("/database/cloud/prepare", (request, response) => send(response, () => databaseCloud.prepare(String(request.body?.deployment ?? ""), String(request.body?.profile ?? ""))));
  api.post("/database/cloud/review", (request, response) => send(response, () => databaseCloud.review(String(request.body?.deployment ?? ""), String(request.body?.profile ?? ""), String(request.body?.confirmation ?? ""), String(request.body?.preparationId ?? ""))));
  api.post("/database/cloud/apply", (request, response) => send(response, () => databaseCloud.apply(String(request.body?.reviewId ?? ""), String(request.body?.confirmation ?? ""))));

  api.get("/snapshot", (_request, response) => {
    const state = builder.current;
    if (!state) {
      response.status(503).json({ error: "The first evaluation is still running." });
      return;
    }
    const body: SnapshotResponse = {
      ...recoveryState(),
      sourceWatch,
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

  api.post("/snapshot/refresh", (_request, response) => send(response, async () => {
    const state = await refresh([]);
    if (!state) throw new EditError(503, "Source could not be reloaded. Check the Studio server output and retry.");
    return { revision: state.snapshot.revision };
  }));

  api.get("/events", (request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    response.write(`event: hello\ndata: ${JSON.stringify({ revision: builder.current?.snapshot.revision ?? null, evaluating, sourceWatch })}\n\n`);
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
    published(result.revision);
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
    published(result.revision);
    return result;
  }));
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/resources/${direction}`, (_request, response) => send(response, async () => {
      const result = await resources.replay(direction);
      published(result.revision);
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
  api.post("/edits/batch/plan", (request, response) => send(response, () => edits.planBatch(readDraftEdits(request.body?.edits), String(request.body?.revision ?? ""))));
  api.post("/edits/batch/apply", (request, response) => send(response, async () => {
    const result = await edits.applyBatch(String(request.body?.planId ?? ""));
    published(result.revision);
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
      published(result.revision);
      return result;
    }),
  );
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/edits/${direction}`, (_request, response) =>
      send(response, async () => {
        const result = await edits[direction]();
        published(result.revision);
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
  api.use((_request, response) => {
    response.status(404).json({ error: "This API is unavailable in the running Studio server. Restart npm run studio in this checkout and reload the page." });
  });

  app.use("/api", api);

  const server = createServer(app);
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    root: STUDIO_ROOT,
    // Separate Studio processes may share installed dependencies. Each needs
    // its own optimizer cache so one server cannot replace another's modules.
    cacheDir: path.join(repositoryRoot, ".cache/framework-studio/vite", String(port)),
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
        .send(page.replace("</head>", `<meta name="studio-token" content="${token}" />\n<meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}" />\n</head>`));
    } catch (error) {
      next(error);
    }
  });

  const stopWatching = watchRepository(repositoryRoot, (files) => {
    // A file this studio just wrote, still holding exactly what it wrote, is
    // its own change; anything else was changed by someone else.
    const external = files.filter((file) => {
      const owner = stateful.ownWrites.has(file) ? stateful.ownWrites : database.ownWrites.has(file) ? database.ownWrites : inputs.ownWrites.has(file) ? inputs.ownWrites : resources.ownWrites.has(file) ? resources.ownWrites : edits.ownWrites;
      const written = owner.get(file);
      if (written === undefined) return true;
      try {
        if (sha256(readFileSync(path.join(repositoryRoot, file), "utf8")) === written) {
          owner.delete(file);
          return false;
        }
      } catch (error) {
        if (written === "absent" && (error as NodeJS.ErrnoException).code === "ENOENT") { owner.delete(file); return false; }
      }
      return true;
    });
    if (external.length > 0) void refresh(external);
  }, 200, { onStatus: status => { sourceWatch = status; broadcast("source-watch", status); } });

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
