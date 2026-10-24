import path from "node:path";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { PreflightResult } from "../../shared/api";
import type { ModeModel } from "../../shared/model";
import type { StudioState } from "../snapshot";
import { EvaluatorPool, type EvaluatorLifetime } from "../evaluator/pool";
import { sha256, toRelative } from "../files";
import { SourceFiles } from "../source";
import { formatLiteral } from "./splice";
import { diffOf } from "./plan";

export interface RouteChange {
  readonly before: string;
  readonly after: string;
  readonly target: string;
}

export function planHttpRoute(root: string, state: StudioState, id: string, nextPath: string) {
  const route = state.snapshot.models.dev.routes.find((route) => route.id === id) ?? state.snapshot.models.prod.routes.find((route) => route.id === id);
  if (!route || route.kind !== "http") throw new Error("Select an HTTP Lambda route.");
  if (!nextPath.startsWith("/") || nextPath.trim() !== nextPath || /[\r\n\0]/.test(nextPath)) throw new Error("A route is a literal path beginning with /, without whitespace at its ends.");
  if (route.path === nextPath) throw new Error("This route already has that path.");
  if ([state.snapshot.models.dev, state.snapshot.models.prod].some((model) => model.routes.some((other) => other.id !== id && other.kind === "http" && other.path === nextPath))) throw new Error("An HTTP route already uses that path.");
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root });
  const entry = located.sections.http.find((entry) => entry.key === route.path);
  if (!entry) throw new Error("This route could not be located in its section module.");
  const files = new SourceFiles();
  const before = files.text(entry.file);
  const relativeFile = toRelative(root, entry.file);
  if (sha256(before) !== state.snapshot.files[relativeFile]) throw new Error("This route's source changed. Wait for refresh before previewing it again.");
  const key = before.slice(entry.keySpan.start, entry.keySpan.end);
  if (key[0] !== '"' && key[0] !== "'") throw new Error("This route key is computed. Edit it in source.");
  const after = before.slice(0, entry.keySpan.start) + formatLiteral(nextPath, key[0]) + before.slice(entry.keySpan.end);
  const readback = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: new SourceFiles(new Map([[entry.file, after]])).host() });
  if (!readback.sections.http.some((entry) => entry.key === nextPath) || readback.sections.http.some((entry) => entry.key === route.path)) throw new Error("The route rename could not be verified in source.");
  return { file: entry.file, relativeFile, before, after, beforeHash: sha256(before), afterHash: sha256(after), diff: diffOf(relativeFile, before, after), change: { before: route.path, after: nextPath, target: route.target } satisfies RouteChange };
}

/** Validate the real candidate source in two isolated module graphs. Lambda identities
 * must match the current graph exactly; changing a public path must not replace a function. */
export async function validateHttpRoute(root: string, state: StudioState, file: string, text: string, change: RouteChange, lifetime?: EvaluatorLifetime): Promise<{ dev: PreflightResult; prod: PreflightResult }> {
  const pool = new EvaluatorPool(root, undefined, lifetime);
  try {
    const evaluation = await pool.evaluate({ [file]: text });
    const result = (model: ModeModel): PreflightResult => {
      const previous = state.snapshot.models[model.mode];
      const diagnostics = [...model.diagnostics];
      const identity = (model: ModeModel) => model.targets.map((target) => [target.ref, target.constructId]).sort((a, b) => a[0]!.localeCompare(b[0]!));
      if (JSON.stringify(identity(previous)) !== JSON.stringify(identity(model))) diagnostics.push({ severity: "error", stage: "validate", message: "Renaming a public route must preserve Lambda target and construct identities." });
      if (!model.routes.some((route) => route.kind === "http" && route.path === change.after && route.target === change.target)) diagnostics.push({ severity: "error", stage: "validate", message: "The renamed route no longer reaches the same Lambda." });
      return { mode: model.mode, ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"), diagnostics };
    };
    return { dev: result(evaluation.dev), prod: result(evaluation.prod) };
  } finally { await pool.dispose(); }
}
