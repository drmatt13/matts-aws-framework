import type { Response } from "express";
import { EditError } from "./edits/io";

/** Validation can throw before it returns a Promise. Both paths share one JSON contract. */
export function sendJson(response: Response, run: () => unknown | Promise<unknown>): void {
  Promise.resolve().then(run).then(
    body => response.json(body),
    (error: unknown) => {
      const candidate = error instanceof EditError ? error.status : (error as { status?: unknown })?.status;
      const status = typeof candidate === "number" && candidate >= 400 && candidate <= 599 ? candidate : 500;
      response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    },
  );
}
