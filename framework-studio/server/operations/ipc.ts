import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { OPERATIONS_VERSION } from "../../shared/operations";

export class OperationsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Filesystem access is the IPC authentication boundary. No TCP listener exists. */
export function privateEndpoint(root: string, state: string): { directory: string; socket: string } {
  if (process.platform === "win32" || !process.getuid) throw new OperationsError(503, "The independent operations runner currently requires macOS or Linux private Unix sockets.");
  const uid = process.getuid();
  const key = createHash("sha256").update(realpathSync(root)).update("\0").update(path.resolve(state)).digest("hex").slice(0, 24);
  // macOS sockaddr_un limits paths to 104 bytes; os.tmpdir() can already exceed that.
  const directory = path.join(realpathSync("/tmp"), `studio-ops-${uid}-${key}`);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new OperationsError(503, "The operations IPC directory must be a private directory owned by this user.");
  }
  return { directory, socket: path.join(directory, "runner.sock") };
}

export function secureSocket(socket: string): void {
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new OperationsError(503, "The operations socket has an unexpected owner or type.");
  chmodSync(socket, 0o600);
}

export function callIpc<T>(socket: string, route: string, body?: unknown, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ socketPath: socket, path: route, method: encoded === undefined ? "GET" : "POST", headers: {
      "x-operations-version": String(OPERATIONS_VERSION),
      ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }),
    } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { response.destroy(new OperationsError(502, "The operations response exceeds its replay page limit.")); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) reject(new OperationsError(response.statusCode ?? 500, typeof result.error === "string" ? result.error : "The operations request failed."));
          else resolve(result as T);
        } catch { reject(new OperationsError(502, "The operations runner returned unreadable evidence.")); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new OperationsError(504, "The operations runner did not answer. Accepted operations may still be running; retry with the same request key.")));
    request.once("error", reject);
    request.end(encoded);
  });
}

export interface CoordinatorInfo {
  readonly version: typeof OPERATIONS_VERSION;
  readonly pid: number;
  readonly root: string;
  readonly state: string;
}
