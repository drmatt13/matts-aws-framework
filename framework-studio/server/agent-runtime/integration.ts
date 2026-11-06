import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearSourceRecoveryRequired, markSourceRecoveryRequired, requireRestrictedSourceEvaluation, sourceCoordinationState, withSourceRecovery, withSourceWrite, type SourceCoordinationState } from "../edits/source-gate";
import { agentProposalDigest, assertAgentSourcePath, loadAgentProposal, readProposalBlob, readSourceManifest, type AgentProposal, type SourceFileEntry } from "./workspace";

interface StoredFile { readonly entry: SourceFileEntry; readonly bytes: string; }
interface StoredChange { readonly path: string; readonly before: StoredFile | null; readonly after: StoredFile | null; }
type IntegrationStatus = "applying" | "applied" | "restored" | "conflicted" | "kept";
interface IntegrationJournal {
  readonly version: 1;
  readonly id: string;
  readonly root: string;
  readonly proposalDigest: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly changes: readonly StoredChange[];
  readonly createdDirectories: readonly string[];
  readonly status: IntegrationStatus;
}
export interface AgentIntegrationResult {
  readonly journalId: string;
  readonly proposalDigest: string;
  readonly status: "applied" | "restored" | "conflicted" | "kept";
  readonly paths: readonly string[];
  readonly message: string;
}
export interface AgentIntegrationRecovery {
  readonly id: string;
  readonly taskId: string;
  readonly proposalDigest: string;
  readonly createdAt: string;
  readonly status: IntegrationStatus;
  readonly fingerprint: string;
  readonly files: readonly { readonly path: string; readonly state: "original" | "written" | "conflicted" }[];
}
export class AgentIntegrationError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9-]{36}$/;
const JOURNALS = ".cache/framework-studio/agent-integrations";
function hash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function equal(a: SourceFileEntry | null, b: SourceFileEntry | null): boolean { return a === null ? b === null : b !== null && a.type === b.type && a.hash === b.hash && a.size === b.size && a.mode === b.mode; }

/** No symlink following, hard links, special files, private files, or lexical escapes. */
function destination(root: string, name: string): string {
  assertAgentSourcePath(name);
  let file = realpathSync(root);
  const parts = name.split("/");
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory() || index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0)) throw new AgentIntegrationError(422, `Unsupported source path or permissions: ${name}.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return file;
}
function state(root: string, name: string): SourceFileEntry | null {
  const file = destination(root, name);
  try {
    const stat = lstatSync(file), bytes = readFileSync(file);
    return { type: "file", hash: hash(bytes), size: bytes.length, mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function safeState(root: string, name: string): SourceFileEntry | null | "unsupported" {
  try { return state(root, name); } catch { return "unsupported"; }
}
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try { fd = openSync(directory, "r"); fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "") && !(process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function journalFolder(root: string, create = false): string {
  let directory = realpathSync(root);
  for (const component of JOURNALS.split("/")) {
    directory = path.join(directory, component);
    try { const stat = lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentIntegrationError(422, "Agent recovery storage must be a regular directory inside the checkout."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (create) mkdirSync(directory, { mode: 0o700 }); }
  }
  return directory;
}
function saveJournal(journal: IntegrationJournal): void {
  const directory = journalFolder(journal.root, true), file = path.join(directory, `${journal.id}.json`), temporary = path.join(directory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file); syncDirectory(directory);
}
function checkedStored(value: StoredFile | null): void {
  if (value === null) return;
  if (!value || typeof value.bytes !== "string" || !value.entry || value.entry.type !== "file" || !HASH.test(value.entry.hash) || !Number.isSafeInteger(value.entry.size) || value.entry.size < 0 || !Number.isInteger(value.entry.mode) || value.entry.mode < 0 || value.entry.mode > 0o777) throw new AgentIntegrationError(422, "Invalid source recovery file metadata.");
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.toString("base64") !== value.bytes || bytes.length !== value.entry.size || hash(bytes) !== value.entry.hash) throw new AgentIntegrationError(422, "Source recovery bytes do not match their recorded identity.");
}
function readJournal(root: string, id: string): IntegrationJournal {
  if (!ID.test(id)) throw new AgentIntegrationError(400, "Select an existing agent integration record.");
  const file = path.join(journalFolder(root), `${id}.json`), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 768 * 1024 * 1024) throw new AgentIntegrationError(422, "Invalid agent integration record.");
  let journal: IntegrationJournal;
  try { journal = JSON.parse(readFileSync(file, "utf8")) as IntegrationJournal; } catch { throw new AgentIntegrationError(422, "Agent source recovery metadata is unreadable. Preserve the record for inspection."); }
  if (journal.version !== 1 || journal.id !== id || journal.root !== realpathSync(root) || !HASH.test(journal.proposalDigest) || !HASH.test(journal.baselineDigest) || !HASH.test(journal.candidateDigest) || !Array.isArray(journal.changes) || !Array.isArray(journal.createdDirectories) || !["applying", "applied", "restored", "conflicted", "kept"].includes(journal.status)) throw new AgentIntegrationError(422, "Agent integration record does not match this checkout.");
  const names = new Set<string>();
  for (const change of journal.changes) {
    assertAgentSourcePath(change.path);
    const normalized = change.path.normalize("NFC").toLowerCase();
    if (names.has(normalized)) throw new AgentIntegrationError(422, "Duplicate source recovery paths.");
    names.add(normalized); checkedStored(change.before); checkedStored(change.after);
  }
  for (const name of journal.createdDirectories) assertAgentSourcePath(`${name}/placeholder`);
  return journal;
}
function journals(root: string): IntegrationJournal[] {
  const directory = journalFolder(root);
  return existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readJournal(root, name.slice(0, -5))) : [];
}
function ensureLegacySourceIdle(root: string): void {
  const directory = path.join(root, ".cache/framework-studio/transactions");
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new AgentIntegrationError(409, "Existing source recovery storage needs inspection before agent integration.");
  for (const name of readdirSync(directory)) {
    if (name === "source.lock" || name === "recovery.lock") throw new AgentIntegrationError(409, "Another source transaction is active or needs recovery. Agent source was not applied.");
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    if (lstatSync(file).isSymbolicLink()) throw new AgentIntegrationError(409, "Existing source recovery metadata needs inspection.");
    let record: { status?: string };
    try { record = JSON.parse(readFileSync(file, "utf8")); } catch { throw new AgentIntegrationError(409, "Existing source recovery metadata is unreadable."); }
    if (!["complete", "restored"].includes(record.status ?? "")) throw new AgentIntegrationError(409, "Resolve the existing source recovery record before agent integration.");
  }
}
function writeChange(root: string, change: StoredChange, reverse = false): void {
  const before = reverse ? change.after : change.before, after = reverse ? change.before : change.after;
  const file = destination(root, change.path);
  if (!equal(state(root, change.path), before?.entry ?? null)) throw new AgentIntegrationError(409, `${change.path} changed at the source write boundary.`);
  if (!after) { if (before) { unlinkSync(file); syncDirectory(path.dirname(file)); } return; }
  mkdirSync(path.dirname(file), { recursive: true });
  destination(root, change.path);
  const temporary = path.join(path.dirname(file), `.studio-agent-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, Buffer.from(after.bytes, "base64")); fchmodSync(fd, after.entry.mode); fsyncSync(fd); } finally { closeSync(fd); }
    destination(root, change.path);
    if (!equal(state(root, change.path), before?.entry ?? null)) throw new AgentIntegrationError(409, `${change.path} changed before replacement.`);
    if (before) renameSync(temporary, file);
    else linkSync(temporary, file); // Exclusive creation: a concurrent new path wins.
    if (existsSync(temporary)) unlinkSync(temporary);
    syncDirectory(path.dirname(file));
    if (!equal(state(root, change.path), after.entry)) throw new AgentIntegrationError(409, `${change.path} changed after replacement.`);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function result(journal: IntegrationJournal, status: AgentIntegrationResult["status"]): AgentIntegrationResult {
  return { journalId: journal.id, proposalDigest: journal.proposalDigest, status, paths: journal.changes.map(change => change.path), message: status === "applied" ? "Applied exactly the approved source. Validation and deployment remain separate evidence and actions." : status === "restored" ? "Integration stopped; its written files were restored. Concurrent edits outside the proposal were preserved." : status === "kept" ? "Kept the inspected current source. This does not assert that it matches or passed validation for the agent proposal." : "Integration needs recovery. Later user edits were preserved; inspect the conflicting paths before further Studio writes." };
}
function restore(journal: IntegrationJournal): AgentIntegrationResult {
  let conflict = false;
  for (const change of [...journal.changes].reverse()) {
    const actual = safeState(journal.root, change.path);
    if (actual !== "unsupported" && equal(actual, change.before?.entry ?? null)) continue;
    if (actual === "unsupported" || !equal(actual, change.after?.entry ?? null)) { conflict = true; continue; }
    try { writeChange(journal.root, change, true); } catch { conflict = true; }
  }
  for (const name of [...journal.createdDirectories].sort((a, b) => b.length - a.length)) {
    try {
      destination(journal.root, `${name}/.source-recovery-check`);
      const directory = path.join(journal.root, name);
      if (!lstatSync(directory).isSymbolicLink()) rmdirSync(directory);
    } catch { /* Only remove our still-empty directories; keep later user files. */ }
  }
  const status = conflict ? "conflicted" : "restored";
  saveJournal({ ...journal, status });
  if (!conflict) clearSourceRecoveryRequired(journal.root, journal.id);
  return result(journal, status);
}

/** Optimistic, recoverable integration; per-file rename is not a checkout transaction. */
export async function integrateAgentProposal(input: AgentProposal, approvedDigest: string, options: {
  /** Fault injection for disposable integration tests; never supplied by an HTTP request. */
  readonly afterWrite?: (index: number, name: string) => void;
  /** Trusted server validation only. Throws to restore guarded source before publication. */
  readonly afterInstall?: () => Promise<void>;
} = {}): Promise<AgentIntegrationResult> {
  const proposal = loadAgentProposal(input.directory);
  if (proposal.digest !== input.digest || approvedDigest !== proposal.digest || agentProposalDigest(proposal) !== approvedDigest) throw new AgentIntegrationError(409, "Approval does not identify the exact frozen proposal. Review it again.");
  const root = realpathSync(proposal.repositoryRoot);
  if (root !== proposal.repositoryRoot || !proposal.changes.length) throw new AgentIntegrationError(422, "The proposal has no source changes or names a different checkout identity.");
  return withSourceWrite(root, async () => {
    ensureLegacySourceIdle(root);
    const previous = journals(root);
    if (previous.some(record => record.status === "applying" || record.status === "conflicted")) throw new AgentIntegrationError(409, "Resolve interrupted agent source integration before applying another proposal.");
    if (previous.some(record => record.proposalDigest === proposal.digest && record.status === "kept")) throw new AgentIntegrationError(409, "This proposal was settled by keeping inspected source. Start a new task; it will not be replayed.");
    const completed = previous.find(record => record.proposalDigest === proposal.digest && record.status === "applied");
    const baseline = readSourceManifest(root);
    if (completed) {
      if (baseline.digest !== completed.candidateDigest) throw new AgentIntegrationError(409, "This proposal was already applied and source has changed since then. It will not be replayed.");
      return result(completed, "applied");
    }
    if (baseline.digest !== proposal.baselineDigest) throw new AgentIntegrationError(409, "Saved source changed since the task started. Refresh the candidate, rerun validation and review again; nothing was written.");
    const proposed: Record<string, SourceFileEntry> = Object.assign(Object.create(null), baseline.files);
    const changes: StoredChange[] = proposal.changes.map(change => {
      destination(root, change.path);
      if (!equal(Object.hasOwn(baseline.files, change.path) ? baseline.files[change.path]! : null, change.before)) throw new AgentIntegrationError(409, "Proposal before-state differs from the current captured source.");
      if (change.after) proposed[change.path] = change.after; else delete proposed[change.path];
      return { path: change.path, before: change.before && { entry: change.before, bytes: readProposalBlob(proposal, change.before.hash).toString("base64") }, after: change.after && { entry: change.after, bytes: readProposalBlob(proposal, change.after.hash).toString("base64") } };
    });
    const candidate = hash(JSON.stringify(Object.fromEntries(Object.entries(proposed).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
    if (candidate !== proposal.candidateDigest) throw new AgentIntegrationError(422, "The proposal changes do not reconstruct its reviewed candidate.");
    const directories = new Set<string>();
    for (const change of changes.filter(change => change.after)) for (let directory = path.dirname(path.join(root, change.path)); directory !== root && !existsSync(directory); directory = path.dirname(directory)) directories.add(path.relative(root, directory).split(path.sep).join("/"));
    const journal: IntegrationJournal = { version: 1, id: randomUUID(), root, proposalDigest: proposal.digest, taskId: proposal.taskId, createdAt: new Date().toISOString(), baselineDigest: proposal.baselineDigest, candidateDigest: proposal.candidateDigest, changes, createdDirectories: [...directories], status: "applying" };
    saveJournal(journal);
    markSourceRecoveryRequired(root, journal.id);
    requireRestrictedSourceEvaluation(root);
    // The complete manifest is rechecked after durable preparation; each file is
    // also guarded at its write boundary. External editor check/rename races remain.
    try {
      if (readSourceManifest(root).digest !== proposal.baselineDigest) throw new AgentIntegrationError(409, "Saved source changed while preparing integration.");
      for (const [index, change] of changes.entries()) { writeChange(root, change); options.afterWrite?.(index, change.path); }
      if (readSourceManifest(root).digest !== proposal.candidateDigest) throw new AgentIntegrationError(409, "Source changed while integration was completing.");
      await options.afterInstall?.();
      if (readSourceManifest(root).digest !== proposal.candidateDigest) throw new AgentIntegrationError(409, "Source changed during post-integration validation.");
      saveJournal({ ...journal, status: "applied" });
      clearSourceRecoveryRequired(root, journal.id);
      return result(journal, "applied");
    } catch { return restore(journal); }
  });
}

export function listAgentIntegrationRecovery(root: string): readonly AgentIntegrationRecovery[] {
  const recoveryId = sourceCoordinationState(root).recoveryId;
  return journals(root).filter(journal => journal.status === "applying" || journal.status === "conflicted" || journal.id === recoveryId).map(journal => {
    const actual = journal.changes.map(change => [change.path, safeState(root, change.path)] as const);
    return { id: journal.id, taskId: journal.taskId, proposalDigest: journal.proposalDigest, createdAt: journal.createdAt, status: journal.status, fingerprint: hash(JSON.stringify(actual)), files: journal.changes.map((change, index) => ({ path: change.path, state: actual[index]![1] !== "unsupported" && equal(actual[index]![1] as SourceFileEntry | null, change.before?.entry ?? null) ? "original" : actual[index]![1] !== "unsupported" && equal(actual[index]![1] as SourceFileEntry | null, change.after?.entry ?? null) ? "written" : "conflicted" })) };
  });
}
/** One response gives routes the gate and its import records, including commit/ack crash gaps. */
export function agentIntegrationState(root: string): { readonly coordination: SourceCoordinationState; readonly recoveries: readonly AgentIntegrationRecovery[] } {
  return { coordination: sourceCoordinationState(root), recoveries: listAgentIntegrationRecovery(root) };
}
/** The host reconciles durable import receipts after crashing before its task-store update. */
export function agentIntegrationReceipt(root: string, proposalDigest: string): AgentIntegrationResult | undefined {
  const record = journals(root).filter(journal => journal.proposalDigest === proposalDigest).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!record) return;
  return result(record, record.status === "applying" ? "conflicted" : record.status);
}
export async function recoverAgentIntegration(root: string, id: string, approval: string, fingerprint?: string): Promise<AgentIntegrationResult> {
  if (approval !== "RESTORE SOURCE" && approval !== "KEEP CURRENT SOURCE") throw new AgentIntegrationError(422, "Type RESTORE SOURCE or KEEP CURRENT SOURCE after reviewing the interrupted integration.");
  readJournal(root, id); // Reject an unknown record before taking an abandoned lease.
  return withSourceRecovery(root, async () => {
    const journal = readJournal(root, id);
    if (journal.status !== "applying" && journal.status !== "conflicted" && sourceCoordinationState(root).recoveryId !== id) throw new AgentIntegrationError(409, "This source integration no longer needs recovery.");
    if (approval === "RESTORE SOURCE") return restore(journal);
    const current = listAgentIntegrationRecovery(root).find(record => record.id === id);
    if (!fingerprint || current?.fingerprint !== fingerprint) throw new AgentIntegrationError(409, "Source changed since recovery review. Inspect the current paths again.");
    saveJournal({ ...journal, status: "kept" });
    clearSourceRecoveryRequired(root, id);
    return result(journal, "kept");
  });
}
