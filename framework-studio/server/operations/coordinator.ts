import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONS_VERSION, type ExecutionIdentity, type JobView, type OperationRequest } from "../../shared/operations";
import { prepareIntent, reconcileOutcome, validateRequest } from "./adapter";
import { processIdentity, identityAlive } from "./identity";
import { OperationsError, privateEndpoint, secureSocket } from "./ipc";
import { canonicalRequest, OperationStore } from "./store";

const loader = createRequire(path.join(__dirname, "../../package.json")).resolve("tsx");
const worker = path.join(__dirname, "worker.ts");

/** A transaction protects stale-socket recovery from competing coordinator startups. */
function coordinatorLease(directory: string): (() => void) | undefined {
  const file = path.join(directory, "coordinator.sqlite");
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Unsafe coordinator lease file.");
  }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)");
  const identity = processIdentity(randomUUID());
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT identity FROM owner WHERE singleton=1").get() as { identity: string } | undefined;
    if (row) {
      const previous = JSON.parse(row.identity) as ExecutionIdentity;
      if (identityAlive(previous) !== false) { db.exec("ROLLBACK"); db.close(); return undefined; }
    }
    db.prepare("INSERT OR REPLACE INTO owner (singleton,identity) VALUES (1,?)").run(JSON.stringify(identity));
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* No transaction. */ } db.close(); throw error; }
  return () => {
    try { db.prepare("DELETE FROM owner WHERE singleton=1 AND identity=?").run(JSON.stringify(identity)); } finally { db.close(); }
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 64 * 1024) throw new OperationsError(413, "The operation intent is too large.");
  }
  try { return JSON.parse(text); } catch { throw new OperationsError(400, "An operation request must be JSON."); }
}

function requestIntent(value: unknown): OperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationsError(400, "Name an operation.");
  const request = value as OperationRequest;
  if (Object.keys(value).some(key => !["kind", "params", "requestKey"].includes(key))) throw new OperationsError(400, "Unsupported operation request field.");
  if (typeof request.kind !== "string" || !request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new OperationsError(400, "An operation names its kind and parameters.");
  if (typeof request.requestKey !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(request.requestKey)) throw new OperationsError(400, "Supply a stable operation request key.");
  if (Object.values(request.params).some(value => value !== undefined && typeof value !== "string" && typeof value !== "boolean")) throw new OperationsError(400, "Operation parameters must be named strings or booleans.");
  return { kind: request.kind, params: request.params, requestKey: request.requestKey };
}

export async function startCoordinator(rootInput: string, stateInput: string): Promise<{ close(): Promise<void> }> {
  process.umask(0o077);
  mkdirSync(path.resolve(stateInput), { recursive: true, mode: 0o700 });
  const root = realpathSync(rootInput), state = realpathSync(stateInput);
  const endpoint = privateEndpoint(root, state);
  const release = coordinatorLease(endpoint.directory);
  if (!release) throw new OperationsError(409, "An operations coordinator already owns this workspace.");
  let store: OperationStore;
  try { store = new OperationStore(path.join(state, "operations")); } catch (error) { release(); throw error; }
  try { store.bindWorkspace(root); } catch (error) { store.close(); release(); throw error; }
  let closing = false;
  let lastRequest = Date.now();
  let closeRunner: () => Promise<void> = async () => {};
  let submissions = Promise.resolve();
  let storageProblem: unknown;
  const dispatch = (job: JobView) => {
    if (job.execution !== "accepted") return;
    const token = store.dispatch(job.id);
    if (!token) return;
    try {
      const child = spawn(process.execPath, ["--import", loader, worker, root, state, job.id, token], { cwd: root, env: process.env, stdio: "ignore", detached: true, windowsHide: true });
      child.once("error", () => {
        try { store.update(job.id, { execution: "lost", status: "interrupted", outcome: "uncertain", summary: "The worker could not be started. Inspect recorded dispatch evidence before another operation.", recovery: "Inspect the operation and its domain journal; this attempt will not be dispatched again." }); }
        catch (error) { storageProblem = error; }
      });
      child.unref();
    } catch (error) { storageProblem = error; }
  };
  const reconcile = () => {
    try {
      store.reconcile();
      const jobs = store.list();
      for (const job of jobs) {
        dispatch(job);
        if (job.execution === "lost" && job.outcome === "uncertain") {
          const recovered = reconcileOutcome(store.get(job.id)!, state);
          if (recovered?.outcome === "confirmed" && recovered.summary) store.reconcileConfirmed(job.id, { outcome: "confirmed", summary: recovered.summary, recovery: recovered.recovery });
        }
      }
      storageProblem = undefined;
      if (Date.now() - lastRequest > 60_000 && !jobs.some(job => ["accepted", "dispatching", "running"].includes(job.execution ?? ""))) void closeRunner();
    } catch (error) { storageProblem = error; }
  };
  const respond = (response: ServerResponse, status: number, result: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(result));
  };
  const server = createServer((request, response) => {
    lastRequest = Date.now();
    void (async () => {
      if (request.headers["x-operations-version"] !== String(OPERATIONS_VERSION)) throw new OperationsError(409, "Operations protocol mismatch.");
      const url = new URL(request.url ?? "/", "http://local");
      if (request.method === "GET" && url.pathname === "/ping") return { version: OPERATIONS_VERSION, pid: process.pid, root, state };
      if (storageProblem) throw new OperationsError(503, "Operation storage or recovery is unavailable. Preserve its files; no uncertain work will be restarted.");
      if (request.method === "GET" && url.pathname === "/operations") return store.list();
      if (request.method === "POST" && url.pathname === "/submit") {
        const intent = requestIntent(await body(request));
        validateRequest(intent);
        let result!: JobView;
        const submitted = submissions.then(async () => {
          if (closing) throw new OperationsError(503, "The coordinator is stopping; retry this request key after reconnecting.");
          const previous = store.findRequest(intent.requestKey!);
          if (previous) {
            if (canonicalRequest(previous.intent.request) !== canonicalRequest(intent)) throw new OperationsError(409, "This request key already identifies different operation intent.");
            result = previous.view;
            return;
          }
          const prepared = await prepareIntent(root, state, intent);
          result = store.accept(prepared, intent.requestKey!);
          dispatch(result);
          result = store.get(result.id)!.view;
        });
        submissions = submitted.then(() => {}, () => {});
        await submitted;
        return result;
      }
      const match = /^\/operations\/([A-Za-z0-9-]+)(?:\/(log|events|cancel))?$/.exec(url.pathname);
      if (!match) throw new OperationsError(404, "No such operations endpoint.");
      const [, id, action] = match;
      if (request.method === "GET" && !action) return store.get(id!) ?? null;
      if (request.method === "GET" && (action === "log" || action === "events")) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new OperationsError(400, "Replay cursors are nonnegative sequence numbers.");
        return action === "events" ? store.events(id!, after) : store.log(id!, after, 1000);
      }
      if (request.method === "POST" && action === "cancel") return store.requestCancel(id!);
      throw new OperationsError(405, "Unsupported operations request method.");
    })().then(result => respond(response, 200, result), error => {
      // Private input values and adapter exceptions must not leak through generic IPC errors.
      const status = typeof error?.status === "number" && error.status >= 400 && error.status <= 599 ? error.status : 503;
      respond(response, status, { error: status < 500 ? String(error.message) : "The operations runner could not durably complete this request. Existing operation evidence was preserved; inspect it before retrying a mutation." });
    });
  });
  try {
    if (existsSync(endpoint.socket)) {
      const stat = lstatSync(endpoint.socket);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe operations socket.");
      // Only the SQLite lease owner can remove an abandoned socket.
      unlinkSync(endpoint.socket);
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socket, resolve); });
    secureSocket(endpoint.socket);
    reconcile();
  } catch (error) { server.close(); store.close(); release(); throw error; }
  const interval = setInterval(reconcile, 1000);
  closeRunner = async () => {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    await submissions;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    // Closing this server removes its socket before releasing singleton ownership.
    release();
  };
  return { close: closeRunner };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const [root, state] = process.argv.slice(2);
  if (!root || !state) process.exitCode = 2;
  else void startCoordinator(root, state).then(coordinator => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void coordinator.close().then(() => process.exit(0)); });
  }, error => {
    // A concurrently launched coordinator owns the endpoint; this contender exits.
    process.exitCode = error instanceof OperationsError && error.status === 409 ? 0 : 1;
  });
}
