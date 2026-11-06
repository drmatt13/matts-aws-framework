import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BatchPlanResponse } from "../../shared/api";
import { AgentWorkspaceError, assertAgentSourcePath, assertWorkspaceBaseline, freezeAgentProposal, readSourceManifest, type AgentProposal, type AgentWorkspace } from "./workspace";

/** Internal planner contract. Browser diff strings are never accepted as source bytes. */
export interface ReviewedStructuredSource {
  readonly planId: string;
  readonly revision: string;
  readonly changes: readonly { readonly path: string; readonly before: string | null; readonly after: string | null }[];
  readonly preflight: BatchPlanResponse["preflight"];
  readonly select?: string;
  readonly entityRemap?: Readonly<Record<string, string>>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Converts trusted framework-editor plans into the same immutable source artifact. */
export async function freezeStructuredProposal(workspace: AgentWorkspace, reviewed: ReviewedStructuredSource): Promise<AgentProposal> {
  if (!reviewed.planId || !reviewed.revision || !Array.isArray(reviewed.changes) || !reviewed.changes.length || reviewed.changes.length > 1000) throw new AgentWorkspaceError(422, "A current structured source review is required.");
  for (const mode of ["dev", "prod"] as const) {
    const check = reviewed.preflight?.[mode];
    if (!check || check.mode !== mode || !check.ok || check.diagnostics.some(diagnostic => diagnostic.severity === "error")) throw new AgentWorkspaceError(422, "Both declaration modes must accept the structured edit before common review.");
  }
  assertWorkspaceBaseline(workspace);
  if (readSourceManifest(workspace.workingDirectory).digest !== workspace.baseline.digest) throw new AgentWorkspaceError(409, "Use a fresh private workspace for a structured source proposal.");
  const names = new Set<string>(); let bytes = 0;
  for (const change of reviewed.changes) {
    assertAgentSourcePath(change.path);
    const folded = change.path.normalize("NFC").toLowerCase();
    if (names.has(folded) || change.before === null && change.after === null || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string") throw new AgentWorkspaceError(422, "The structured proposal contains duplicate or invalid source changes.");
    names.add(folded);
    const original = Object.hasOwn(workspace.baseline.files, change.path) ? workspace.baseline.files[change.path]! : null;
    if (change.before === null ? original !== null : original?.hash !== hash(change.before)) throw new AgentWorkspaceError(409, `${change.path} changed since the structured review. Review current saved source again.`);
    if (change.after !== null) bytes += Buffer.byteLength(change.after);
    if (bytes > 32 * 1024 * 1024) throw new AgentWorkspaceError(413, "The structured proposal exceeds the source transfer limit.");
    // Refuse directory/file shape changes here; general coding proposals retain
    // their separate importer behavior. Literal planner edits do not need them.
    const target = path.join(workspace.workingDirectory, change.path);
    let parent = path.dirname(target);
    while (parent !== workspace.workingDirectory) {
      try { if (!lstatSync(parent).isDirectory()) throw new AgentWorkspaceError(422, "A structured source parent is not a directory."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      parent = path.dirname(parent);
    }
    try { if (!lstatSync(target).isFile()) throw new AgentWorkspaceError(422, "A structured source target is not a file."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Preflight all bytes before changing even the private candidate. A failed
  // staging operation retains the directory and never imports into live source.
  for (const change of reviewed.changes) {
    const target = path.join(workspace.workingDirectory, change.path);
    if (change.after === null) await unlink(target);
    else {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const mode = workspace.baseline.files[change.path]?.mode ?? 0o644;
      await writeFile(target, change.after, { flag: change.before === null ? "wx" : "w", mode });
      if (hash(readFileSync(target, "utf8")) !== hash(change.after)) throw new AgentWorkspaceError(409, "Structured source changed while staging the proposal.");
    }
  }
  const proposal = await freezeAgentProposal(workspace);
  await writeFile(path.join(proposal.directory, "structured-review.json"), JSON.stringify({ version: 1, planId: reviewed.planId, revision: reviewed.revision, proposalDigest: proposal.digest, select: reviewed.select, entityRemap: reviewed.entityRemap }), { flag: "wx", mode: 0o400 });
  // Planner preflight remains separate from host final validation. This artifact
  // grants no permission to apply, migrate, deploy, or operate infrastructure.
  return proposal;
}
