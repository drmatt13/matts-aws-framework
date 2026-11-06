import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertWorkspaceBaseline, loadAgentProposal, prepareAgentWorkspace, readProposalBlob, type AgentProposal, type AgentWorkspace, type SourceFileEntry } from "./workspace";

const execute = promisify(execFile);
const equal = (a: SourceFileEntry | null, b: SourceFileEntry | null): boolean => a === null ? b === null : b !== null && a.hash === b.hash && a.mode === b.mode;
const text = (bytes: Buffer): boolean => !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes);
export interface CandidateRefresh { readonly workspace: AgentWorkspace; readonly conflicts: readonly { path: string; reason: string }[] }

/** Prepare C + (P - B) privately. Git's standalone merge-file is only a text
 * algorithm: no repository, refs, index, hooks, attributes or commits are used. */
export async function refreshAgentCandidate(previous: AgentWorkspace, input: AgentProposal, storageDirectory: string, copyDependencies = true): Promise<CandidateRefresh> {
  const proposal = loadAgentProposal(input.directory);
  if (proposal.digest !== input.digest || proposal.taskId !== previous.taskId || proposal.baselineDigest !== previous.baseline.digest || proposal.repositoryRoot !== previous.repositoryRoot) throw new Error("Refresh requires the current immutable proposal and its captured baseline.");
  const workspace = await prepareAgentWorkspace(previous.repositoryRoot, { storageDirectory: path.join(storageDirectory, randomUUID()), taskId: previous.taskId, copyDependencies });
  const conflicts: { path: string; reason: string }[] = [];
  const mergeDirectory = path.join(workspace.directory, "merge-inputs"); await mkdir(mergeDirectory, { mode: 0o700 });
  for (const [index, change] of proposal.changes.entries()) {
    const current = workspace.baseline.files[change.path] ?? null;
    if (equal(current, change.after)) continue; // Another writer already made these exact bytes/mode.
    let bytes: Buffer | undefined, mode = change.after?.mode;
    if (equal(current, change.before)) bytes = change.after ? readProposalBlob(proposal, change.after.hash) : undefined;
    else {
      if (!current || !change.before || !change.after) { conflicts.push({ path: change.path, reason: "Concurrent creation, deletion or replacement needs explicit resolution." }); continue; }
      if (current.mode !== change.before.mode && change.after.mode !== change.before.mode && current.mode !== change.after.mode) { conflicts.push({ path: change.path, reason: "Both versions changed file permissions differently." }); continue; }
      mode = change.after.mode === change.before.mode ? current.mode : change.after.mode;
      const base = readProposalBlob(proposal, change.before.hash), agent = readProposalBlob(proposal, change.after.hash), saved = await readFile(path.join(workspace.workingDirectory, change.path));
      if (![base, agent, saved].every(text) || Math.max(base.length, agent.length, saved.length) > 2 * 1024 * 1024) { conflicts.push({ path: change.path, reason: "Overlapping binary or large-file edits require exact-byte resolution." }); continue; }
      const files = [saved, base, agent].map((_bytes, part) => path.join(mergeDirectory, `${index}-${part}`));
      for (let part = 0; part < files.length; part++) await writeFile(files[part]!, [saved, base, agent][part]!, { flag: "wx", mode: 0o600 });
      try {
        const merged = await execute("git", ["--no-pager", "merge-file", "--stdout", "--diff3", "-L", "saved source", "-L", "task baseline", "-L", "agent proposal", "--", ...files], {
          cwd: mergeDirectory, env: { PATH: "/usr/bin:/bin", HOME: mergeDirectory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", LC_ALL: "C" }, encoding: "buffer", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
        });
        bytes = merged.stdout;
      } catch { conflicts.push({ path: change.path, reason: "Text edits overlap, or the bounded merge tool is unavailable. Neither version was applied." }); continue; }
    }
    const file = path.join(workspace.workingDirectory, change.path);
    if (bytes === undefined) { if (current) await unlink(file); }
    else { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: mode! }); await chmod(file, mode!); }
  }
  assertWorkspaceBaseline(workspace);
  await writeFile(path.join(workspace.directory, "refresh.json"), JSON.stringify({ previousProposal: proposal.digest, currentBaseline: workspace.baseline.digest, conflicts }), { flag: "wx", mode: 0o400 });
  return { workspace, conflicts };
}
