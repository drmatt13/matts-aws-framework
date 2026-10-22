import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * What stands between a browser and the studio's ability to write source.
 *
 * - `hostGuard` answers only requests addressed to this server by a loopback
 *   name, which defeats DNS rebinding: a hostile page that points its own name
 *   at 127.0.0.1 still sends its own name as Host.
 * - `apiGuard` demands the per-process token, which only the page this server
 *   served can read, and for anything that changes state, an Origin of this
 *   server.
 */

export function hostGuard(port: number) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!allowed.has(request.headers.host ?? "")) {
      response.status(421).type("text/plain").send("This server answers only to 127.0.0.1 and localhost.");
      return;
    }
    next();
  };
}

function equalTokens(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function apiGuard(token: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.get("x-studio-token") ?? (request.path === "/events" ? request.query.token : undefined);
    if (!equalTokens(token, supplied)) {
      response.status(401).json({ error: "Missing or wrong studio token. Reload the page the studio served." });
      return;
    }
    if (request.method !== "GET" && request.get("origin") !== `http://${request.headers.host}`) {
      response.status(403).json({ error: "Changes are accepted only from the studio's own page." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    next();
  };
}
