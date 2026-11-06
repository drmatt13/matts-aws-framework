import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, lstat, realpath, statfs, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** These records describe saved bytes, independently of Git HEAD or the index. */
export interface SourceFileEntry { readonly type: "file"; readonly hash: string; readonly size: number; readonly mode: number }
export interface SourceManifest { readonly version: 1; readonly digest: string; readonly files: Readonly<Record<string, SourceFileEntry>> }
export interface AgentWorkspace {
  readonly version: 1;
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly directory: string;
  readonly workingDirectory: string;
  readonly baseline: SourceManifest;
  readonly createdAt: string;
  readonly exclusions: readonly string[];
  /** Private installed code, distinct from regenerated database output and known tool caches. */
  readonly dependencyDigest?: string;
  readonly storageEstimate?: { readonly requiredBytes: number; readonly availableBytes: number };
}
export interface AgentFileChange { readonly path: string; readonly before: SourceFileEntry | null; readonly after: SourceFileEntry | null }
export interface AgentProposal {
  readonly version: 1;
  readonly digest: string;
  readonly id: string;
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly directory: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly createdAt: string;
  readonly changes: readonly AgentFileChange[];
}
export class AgentWorkspaceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const OMIT_DIRECTORIES = new Set([".git", ".cache", ".framework", ".aws", ".ssh", ".gnupg", "node_modules", "cdk.out", ".cdk.staging", "dist", "dist-ssr", "coverage", "test-results", "playwright-report", "blob-report", ".playwright-mcp", ".playwright-cli", ".tanstack", ".vite", ".npm", "__pycache__"]);
const PRIVATE_FILES = new Set([".npmrc", ".netrc", ".pypirc", "credentials", "id_rsa", "id_ed25519"]);
const PRIVATE_EXTENSIONS = /\.(?:pem|key|p12|pfx)$/i;
const TRANSIENT_FILES = /(?:\.tsbuildinfo|\.log|\.py[co]|\.pid|\.pid\.lock)$/;
const VALID_ID = /^[A-Za-z0-9_-]{1,100}$/;
const VALID_HASH = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_FILES = 30_000;
export const AGENT_MAX_COPY_BYTES = 8 * 1024 * 1024 * 1024;
export const AGENT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

/** Admission is conservative logical allocation, not an OS disk quota. */
export function assertAgentStorageCapacity(requiredBytes: number, availableBytes: number): void {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || !Number.isFinite(availableBytes) || availableBytes < 0) throw new AgentWorkspaceError(507, "Private workspace storage capacity could not be established.");
  if (requiredBytes > AGENT_MAX_COPY_BYTES) throw new AgentWorkspaceError(507, "The private copy exceeds the 8 GiB task allocation limit. Reduce project runtime inputs before retrying.");
  if (availableBytes - requiredBytes < AGENT_MIN_FREE_BYTES) throw new AgentWorkspaceError(507, "Private workspace preparation requires its estimated copy size plus 1 GiB of free space. Existing source and retained task files were preserved.");
}
const allocatedBytes = (bytes: number) => Math.max(4096, Math.ceil(bytes / 4096) * 4096);
async function storageAdmission(root: string, storage: string, source: SourceManifest, copies: number, includeDependencies: boolean, preview = false) {
  let requiredBytes = Object.values(source.files).reduce((sum, entry) => sum + allocatedBytes(entry.size) * copies, 0);
  const visit = async (file: string): Promise<void> => {
    const name = relative(root, file);
    if (preview && /(?:^|\/)node_modules\/\.(?:cache|vite)(?:\/|$)/.test(name)) return;
    const info = await lstat(file);
    requiredBytes += info.isFile() ? allocatedBytes(info.size) : 4096;
    if (requiredBytes > AGENT_MAX_COPY_BYTES) assertAgentStorageCapacity(requiredBytes, Number.MAX_SAFE_INTEGER);
    if (info.isSymbolicLink()) {
      if (!within(root, await realpath(file))) throw new AgentWorkspaceError(422, `Dependency link leaves the project: ${name}.`);
    } else if (info.isDirectory()) for (const child of await readdir(file)) await visit(path.join(file, child));
    else if (!info.isFile()) throw new AgentWorkspaceError(422, "Private copy inputs include an unsupported special file.");
  };
  if (includeDependencies) for (const directory of dependencyRoots(root).filter(file => !preview || path.basename(file) === "node_modules")) await visit(directory);
  const capacity = await statfs(storage, { bigint: true });
  const availableBytes = Number(capacity.bavail * capacity.bsize);
  assertAgentStorageCapacity(requiredBytes, availableBytes);
  return { requiredBytes, availableBytes };
}

function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function within(root: string, file: string): boolean { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join("/"); }
export function assertAgentSourcePath(name: string): void {
  if (!name || name.includes("\\") || name.includes("\0") || path.posix.isAbsolute(name) || name.split("/").some(part => !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part))) throw new AgentWorkspaceError(422, "The proposal contains an invalid source path.");
  if (excluded(name)) throw new AgentWorkspaceError(422, `${name} is private or runtime state and cannot enter a source proposal.`);
}
function excluded(name: string): boolean {
  const parts = name.split("/"), base = parts.at(-1)!;
  return parts.some(part => OMIT_DIRECTORIES.has(part)) || name === "output/playwright" || name.startsWith("output/playwright/")
    || name === "packages/database/src/generated" || name.startsWith("packages/database/src/generated/")
    || [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml"].includes(name)
    || name === ".claude/hooks" || name.startsWith(".claude/hooks/") || name === ".codex/hooks" || name.startsWith(".codex/hooks/")
    || PRIVATE_FILES.has(base) || PRIVATE_EXTENSIONS.test(base) || TRANSIENT_FILES.test(base) || base === ".DS_Store"
    || base.startsWith(".env") && !/^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|template)$/.test(base);
}
function assertNoLinkedAncestors(file: string): void {
  const absolute = path.resolve(file), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new AgentWorkspaceError(422, "Agent storage must not contain symbolic-link ancestors."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function manifest(files: Record<string, SourceFileEntry>): SourceManifest {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { version: 1, digest: hash(JSON.stringify(sorted)), files: sorted };
}
function validEntry(value: unknown): value is SourceFileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as SourceFileEntry;
  return entry.type === "file" && typeof entry.hash === "string" && VALID_HASH.test(entry.hash) && Number.isSafeInteger(entry.size) && entry.size >= 0 && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777;
}
function validateManifest(value: unknown): asserts value is SourceManifest {
  if (!value || typeof value !== "object") throw new AgentWorkspaceError(422, "Invalid captured source manifest.");
  const candidate = value as SourceManifest;
  if (candidate.version !== 1 || !candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files) || typeof candidate.digest !== "string" || !VALID_HASH.test(candidate.digest)) throw new AgentWorkspaceError(422, "Invalid captured source manifest.");
  const names = new Set<string>(); let bytes = 0;
  for (const [name, entry] of Object.entries(candidate.files)) {
    assertAgentSourcePath(name);
    const folded = name.normalize("NFC").toLowerCase();
    if (names.has(folded) || !validEntry(entry)) throw new AgentWorkspaceError(422, "Invalid captured source file metadata.");
    names.add(folded); bytes += entry.size;
  }
  if (names.size > MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES || manifest({ ...candidate.files }).digest !== candidate.digest) throw new AgentWorkspaceError(422, "The captured source manifest is incomplete or changed.");
}
function readMetadata(file: string): unknown {
  assertNoLinkedAncestors(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new AgentWorkspaceError(422, "Invalid agent metadata file.");
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new AgentWorkspaceError(422, "Agent metadata is incomplete. Preserve the task for recovery."); }
}
/** Refuses linked/special source; ordinary ignored-but-authored files are included. */
export function readSourceManifest(root: string): SourceManifest {
  const canonical = realpathSync(root), files: Record<string, SourceFileEntry> = Object.create(null), names = new Set<string>();
  let bytes = 0, count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = relative(canonical, file);
      if (excluded(name)) continue;
      assertAgentSourcePath(name);
      // Case-folding prevents accepting a tree whose paths collide on macOS/Windows.
      const folded = name.normalize("NFC").toLowerCase();
      if (names.has(folded)) throw new AgentWorkspaceError(422, `Source paths collide on a case-insensitive filesystem: ${name}.`);
      names.add(folded);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new AgentWorkspaceError(422, `Linked or special source is unsupported: ${name}.`);
      if (stat.isDirectory()) { visit(file); continue; }
      if (stat.nlink > 1) throw new AgentWorkspaceError(422, `Hard-linked source is unsupported: ${name}.`);
      if (stat.mode & 0o7000) throw new AgentWorkspaceError(422, `Special source permission bits are unsupported: ${name}.`);
      if (bytes + stat.size > MAX_SOURCE_BYTES || ++count > MAX_SOURCE_FILES) throw new AgentWorkspaceError(413, "The source capture exceeds the agent workspace limit.");
      const contents = readFileSync(file);
      bytes += contents.length;
      if (bytes > MAX_SOURCE_BYTES) throw new AgentWorkspaceError(413, "The source capture exceeds the agent workspace limit.");
      files[name] = { type: "file", hash: hash(contents), size: contents.length, mode: stat.mode & 0o777 };
    }
  };
  visit(canonical);
  return manifest(files);
}

async function cloneFile(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  // COPYFILE_FICLONE falls back to an independent copy when reflinks are unavailable.
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, mode);
}
async function putBlob(directory: string, bytes: Buffer, digest: string): Promise<void> {
  if (hash(bytes) !== digest) throw new AgentWorkspaceError(409, "Source changed during workspace capture. Retry from current saved source.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(path.join(directory, digest), bytes, { flag: "wx", mode: 0o400 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const file = path.join(directory, digest); assertNoLinkedAncestors(file);
    if (lstatSync(file).nlink !== 1 || hash(await readFile(file)) !== digest) throw new AgentWorkspaceError(409, "Stored source bytes changed. This workspace cannot be trusted.");
  }
}
async function copyPrivateTree(source: string, destination: string, sourceRoot: string, workingRoot: string, omitCaches = false): Promise<void> {
  if (omitCaches && /(?:^|\/)node_modules\/\.(?:cache|vite)(?:\/|$)/.test(relative(sourceRoot, source))) return;
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) {
    const resolved = await realpath(source).catch(() => { throw new AgentWorkspaceError(422, "A dependency link has a missing destination."); });
    if (!within(sourceRoot, resolved)) throw new AgentWorkspaceError(422, `Dependency link leaves the project: ${relative(sourceRoot, source)}.`);
    const mapped = path.join(workingRoot, relative(sourceRoot, resolved));
    // Rebase both absolute and relative links; no link can retain a live-checkout target.
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(path.relative(path.dirname(destination), mapped), destination, process.platform === "win32" && (await lstat(resolved)).isDirectory() ? "junction" : undefined);
  } else if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) await copyPrivateTree(path.join(source, name), path.join(destination, name), sourceRoot, workingRoot, omitCaches);
  } else if (stat.isFile()) await cloneFile(source, destination, stat.mode & 0o777);
  else throw new AgentWorkspaceError(422, "Dependencies contain an unsupported special file.");
}
function dependencyRoots(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = relative(root, file);
      if (entry.name === "node_modules") { found.push(file); continue; }
      if (!excluded(name) && entry.isDirectory()) visit(file);
    }
  };
  visit(root);
  const generated = path.join(root, "packages/database/src/generated");
  if (existsSync(generated)) found.push(generated);
  return found;
}

/** No package code is omitted: only the conventional node_modules/.cache and .vite caches. */
export async function readDependencyDigest(rootInput: string): Promise<string> {
  const root = await realpath(rootInput), records: unknown[] = [];
  const pending: { file: string; name: string; stat: Stats; index: number }[] = [];
  const flush = async () => {
    // Bounded parallel reads avoid one stream lifecycle per tiny package file.
    // Record slots retain the original traversal order for stored v1 digests.
    const batch = pending.splice(0);
    await Promise.all(batch.map(async ({ file, name, stat, index }) => {
      const digest = createHash("sha256");
      const unchanged = (observed: Stats) => observed.isFile() && observed.ino === stat.ino && observed.dev === stat.dev && observed.nlink === stat.nlink && observed.size === stat.size && observed.mtimeMs === stat.mtimeMs && observed.mode === stat.mode;
      // NONBLOCK prevents an lstat→open FIFO swap from hanging the host. Confirm
      // the opened descriptor before reading, then bound reads to captured size.
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!unchanged(await handle.stat())) throw new AgentWorkspaceError(409, "Dependencies changed while capturing their identity. Finish the installation and retry.");
        if (stat.size <= 2 * 1024 * 1024) {
          const buffer = Buffer.alloc(stat.size + 1); let length = 0;
          while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
          if (length !== stat.size) throw new AgentWorkspaceError(409, "Dependencies changed while capturing their identity. Finish the installation and retry.");
          digest.update(buffer.subarray(0, length));
        } else {
          let length = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 512 * 1024, start: 0, end: stat.size })) { digest.update(chunk as Buffer); length += (chunk as Buffer).length; }
          if (length !== stat.size) throw new AgentWorkspaceError(409, "Dependencies changed while capturing their identity. Finish the installation and retry.");
        }
        if (!unchanged(await handle.stat())) throw new AgentWorkspaceError(409, "Dependencies changed while capturing their identity. Finish the installation and retry.");
      } finally { await handle.close(); }
      const after = await lstat(file);
      if (!unchanged(after)) throw new AgentWorkspaceError(409, "Dependencies changed while capturing their identity. Finish the installation and retry.");
      records[index] = [name, "file", digest.digest("hex"), stat.mode & 0o777];
    }));
  };
  const visit = async (file: string): Promise<void> => {
    const name = relative(root, file), stat = await lstat(file);
    if (/(?:^|\/)node_modules\/\.(?:cache|vite)(?:\/|$)/.test(name)) return;
    if (stat.isSymbolicLink()) {
      const target = await realpath(file);
      if (!within(root, target)) throw new AgentWorkspaceError(422, `Dependency link leaves the project: ${name}.`);
      records.push([name, "link", relative(root, target)]);
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(file)).sort()) await visit(path.join(file, child));
    } else if (stat.isFile()) {
      pending.push({ file, name, stat, index: records.length }); records.push(null);
      if (pending.length === 8) await flush();
    } else throw new AgentWorkspaceError(422, `Unsupported dependency file: ${name}.`);
  };
  for (const directory of dependencyRoots(root).filter(file => path.basename(file) === "node_modules").sort()) await visit(directory);
  await flush();
  return hash(JSON.stringify(records));
}
export async function assertWorkspaceDependencies(workspace: AgentWorkspace): Promise<void> {
  if (workspace.dependencyDigest !== undefined && await readDependencyDigest(workspace.workingDirectory) !== workspace.dependencyDigest) throw new AgentWorkspaceError(409, "The task changed installed dependency code. Restore or provision dependencies from the reviewed lockfile before final validation.");
}

/** Reconstructs frozen bytes for read-only evaluation; never reads the live checkout. */
export async function materializeAgentRevision(workspace: AgentWorkspace, directory: string, proposal?: AgentProposal): Promise<SourceManifest> {
  validateManifest(workspace.baseline);
  const destination = path.resolve(directory);
  if (!within(workspace.directory, destination) || destination === workspace.directory || within(workspace.workingDirectory, destination)) throw new AgentWorkspaceError(422, "Frozen revisions must have private task storage outside the writable candidate.");
  assertNoLinkedAncestors(destination);
  const files: Record<string, SourceFileEntry> = { ...workspace.baseline.files }, changed = new Map<string, SourceFileEntry>();
  if (proposal) {
    if (proposal.taskId !== workspace.taskId || proposal.repositoryRoot !== workspace.repositoryRoot || proposal.baselineDigest !== workspace.baseline.digest || proposal.digest !== agentProposalDigest(proposal)) throw new AgentWorkspaceError(409, "The frozen revision does not belong to this workspace.");
    for (const change of proposal.changes) {
      assertAgentSourcePath(change.path);
      if (JSON.stringify(Object.hasOwn(files, change.path) ? files[change.path] : null) !== JSON.stringify(change.before)) throw new AgentWorkspaceError(409, "The proposal baseline does not match captured source.");
      if (change.after) { files[change.path] = change.after; changed.set(change.path, change.after); }
      else delete files[change.path];
    }
  }
  const selected = manifest(files); validateManifest(selected);
  if (selected.digest !== (proposal?.candidateDigest ?? workspace.baseline.digest)) throw new AgentWorkspaceError(409, "The frozen revision is incomplete.");
  await storageAdmission(workspace.workingDirectory, workspace.directory, selected, 1, true, true);
  await mkdir(destination, { mode: 0o700 });
  for (const [name, entry] of Object.entries(selected.files)) {
    const blob = changed.has(name) ? path.join(proposal!.directory, "blobs", entry.hash) : path.join(workspace.directory, "baseline-blobs", entry.hash);
    assertNoLinkedAncestors(blob);
    const stat = lstatSync(blob), bytes = await readFile(blob);
    if (!stat.isFile() || stat.nlink !== 1 || bytes.length !== entry.size || hash(bytes) !== entry.hash) throw new AgentWorkspaceError(409, "Frozen source bytes changed. Preserve this task for inspection.");
    await cloneFile(blob, path.join(destination, name), entry.mode);
  }
  // Generated database artifacts and caches are not declaration-preview inputs.
  for (const source of dependencyRoots(workspace.workingDirectory).filter(file => path.basename(file) === "node_modules")) await copyPrivateTree(source, path.join(destination, relative(workspace.workingDirectory, source)), workspace.workingDirectory, destination, true);
  if (workspace.dependencyDigest !== undefined && await readDependencyDigest(destination) !== workspace.dependencyDigest) throw new AgentWorkspaceError(409, "Frozen revision dependency identity changed.");
  if (readSourceManifest(destination).digest !== selected.digest) throw new AgentWorkspaceError(409, "Frozen revision source identity changed.");
  return selected;
}

/** Materializes a saved-source baseline without consulting or modifying Git. */
export async function prepareAgentWorkspace(repositoryRoot: string, options: { readonly storageDirectory: string; readonly taskId?: string; readonly copyDependencies?: boolean }): Promise<AgentWorkspace> {
  const root = realpathSync(repositoryRoot), taskId = options.taskId ?? randomUUID();
  if (!VALID_ID.test(taskId)) throw new AgentWorkspaceError(422, "Invalid agent task identity.");
  const storage = path.resolve(options.storageDirectory);
  // Canonicalize the existing ancestor first (macOS /tmp aliases are normal).
  let ancestor = storage;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalStorage = path.join(realpathSync(ancestor), path.relative(ancestor, storage));
  if (within(root, canonicalStorage) || within(canonicalStorage, root)) throw new AgentWorkspaceError(422, "Agent workspace storage must be outside the authoritative checkout and cannot contain it.");
  assertNoLinkedAncestors(canonicalStorage);
  const directory = path.join(canonicalStorage, taskId), workingDirectory = path.join(directory, "working");
  await mkdir(canonicalStorage, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(workingDirectory, { mode: 0o700 });
  const baseline = readSourceManifest(root), blobs = path.join(directory, "baseline-blobs");
  const storageEstimate = await storageAdmission(root, directory, baseline, 2, options.copyDependencies !== false);
  for (const [name, entry] of Object.entries(baseline.files)) {
    await putBlob(blobs, await readFile(path.join(root, name)), entry.hash);
    await cloneFile(path.join(blobs, entry.hash), path.join(workingDirectory, name), entry.mode);
  }
  if (readSourceManifest(root).digest !== baseline.digest) throw new AgentWorkspaceError(409, "Saved source changed during capture. The incomplete workspace was retained; create a new attempt.");
  let dependencyDigest: string | undefined;
  if (options.copyDependencies !== false) {
    for (const source of dependencyRoots(root)) await copyPrivateTree(source, path.join(workingDirectory, relative(root, source)), root, workingDirectory);
    const [current, copied] = await Promise.all([readDependencyDigest(root), readDependencyDigest(workingDirectory)]);
    if (current !== copied) throw new AgentWorkspaceError(409, "Dependencies changed during workspace preparation. Finish the installation and create a new attempt.");
    dependencyDigest = copied;
  }
  if (readSourceManifest(root).digest !== baseline.digest) throw new AgentWorkspaceError(409, "Saved source changed while preparing dependencies. Create a new attempt.");
  const workspace: AgentWorkspace = { version: 1, taskId, repositoryRoot: root, directory, workingDirectory, baseline, ...(dependencyDigest ? { dependencyDigest } : {}), storageEstimate, createdAt: new Date().toISOString(), exclusions: [...OMIT_DIRECTORIES, "private environment/credential files", "packages/database/src/generated (private validation copy)", "output/playwright"] };
  await writeFile(path.join(directory, "workspace.json"), JSON.stringify(workspace), { flag: "wx", mode: 0o600 });
  return workspace;
}
export function assertWorkspaceBaseline(workspace: AgentWorkspace): void {
  if (readSourceManifest(workspace.repositoryRoot).digest !== workspace.baseline.digest) throw new AgentWorkspaceError(409, "Saved project source changed since this task started. Refresh the candidate and validate it again before approval.");
}
export function loadAgentWorkspace(directory: string): AgentWorkspace {
  const canonical = realpathSync(directory); assertNoLinkedAncestors(canonical);
  const workspace = readMetadata(path.join(canonical, "workspace.json")) as AgentWorkspace;
  if (!workspace || workspace.version !== 1 || workspace.directory !== canonical || workspace.workingDirectory !== path.join(canonical, "working") || typeof workspace.taskId !== "string" || !VALID_ID.test(workspace.taskId) || typeof workspace.repositoryRoot !== "string" || !path.isAbsolute(workspace.repositoryRoot) || realpathSync(workspace.repositoryRoot) !== workspace.repositoryRoot || within(workspace.repositoryRoot, canonical) || within(canonical, workspace.repositoryRoot) || workspace.dependencyDigest !== undefined && !VALID_HASH.test(workspace.dependencyDigest)) throw new AgentWorkspaceError(422, "Invalid agent workspace metadata.");
  assertNoLinkedAncestors(workspace.workingDirectory);
  validateManifest(workspace.baseline);
  return workspace;
}

export function agentProposalDigest(proposal: Omit<AgentProposal, "digest">): string {
  return hash(JSON.stringify({ version: proposal.version, id: proposal.id, taskId: proposal.taskId, repositoryRoot: proposal.repositoryRoot, baselineDigest: proposal.baselineDigest, candidateDigest: proposal.candidateDigest, changes: proposal.changes }));
}

/** Caller must first stop task writers. Hash rechecks detect ordinary late writes. */
export async function freezeAgentProposal(workspace: AgentWorkspace): Promise<AgentProposal> {
  validateManifest(workspace.baseline);
  assertNoLinkedAncestors(workspace.workingDirectory);
  const candidate = readSourceManifest(workspace.workingDirectory), id = randomUUID(), directory = path.join(workspace.directory, "proposals", id);
  const changes: AgentFileChange[] = [];
  await mkdir(path.join(directory, "blobs"), { recursive: true, mode: 0o700 });
  for (const name of [...new Set([...Object.keys(workspace.baseline.files), ...Object.keys(candidate.files)])].sort()) {
    const before = Object.hasOwn(workspace.baseline.files, name) ? workspace.baseline.files[name]! : null, after = Object.hasOwn(candidate.files, name) ? candidate.files[name]! : null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before) await putBlob(path.join(directory, "blobs"), await readFile(path.join(workspace.directory, "baseline-blobs", before.hash)), before.hash);
    if (after) await putBlob(path.join(directory, "blobs"), await readFile(path.join(workspace.workingDirectory, name)), after.hash);
    changes.push({ path: name, before, after });
  }
  if (readSourceManifest(workspace.workingDirectory).digest !== candidate.digest) throw new AgentWorkspaceError(409, "Task files changed while freezing the proposal. Stop all task writers and review again.");
  const content = { version: 1 as const, id, taskId: workspace.taskId, repositoryRoot: workspace.repositoryRoot, directory, baselineDigest: workspace.baseline.digest, candidateDigest: candidate.digest, createdAt: new Date().toISOString(), changes };
  const proposal: AgentProposal = { ...content, digest: agentProposalDigest(content) };
  await writeFile(path.join(directory, "proposal.json"), JSON.stringify(proposal), { flag: "wx", mode: 0o400 });
  return proposal;
}
export function readProposalBlob(proposal: AgentProposal, digest: string): Buffer {
  if (!VALID_HASH.test(digest)) throw new AgentWorkspaceError(422, "Invalid proposal blob identity.");
  const file = path.join(proposal.directory, "blobs", digest); assertNoLinkedAncestors(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AgentWorkspaceError(422, "Invalid proposal blob file.");
  const bytes = readFileSync(file);
  if (hash(bytes) !== digest) throw new AgentWorkspaceError(409, "The approved proposal blob changed. Review is invalid.");
  return bytes;
}
export function loadAgentProposal(directory: string): AgentProposal {
  const canonical = realpathSync(directory); assertNoLinkedAncestors(canonical);
  const proposal = readMetadata(path.join(canonical, "proposal.json")) as AgentProposal;
  if (!proposal || proposal.version !== 1 || proposal.directory !== canonical || typeof proposal.id !== "string" || !VALID_ID.test(proposal.id) || typeof proposal.taskId !== "string" || !VALID_ID.test(proposal.taskId) || typeof proposal.repositoryRoot !== "string" || !path.isAbsolute(proposal.repositoryRoot) || !VALID_HASH.test(proposal.baselineDigest) || !VALID_HASH.test(proposal.candidateDigest) || !Array.isArray(proposal.changes) || proposal.changes.length > MAX_SOURCE_FILES || proposal.digest !== agentProposalDigest(proposal)) throw new AgentWorkspaceError(422, "Invalid agent proposal metadata.");
  const names = new Set<string>();
  for (const change of proposal.changes) {
    if (!change || typeof change.path !== "string" || change.before === null && change.after === null || change.before === undefined || change.after === undefined) throw new AgentWorkspaceError(422, "Invalid proposal change metadata.");
    assertAgentSourcePath(change.path);
    const folded = change.path.normalize("NFC").toLowerCase();
    if (names.has(folded)) throw new AgentWorkspaceError(422, "Duplicate source paths in proposal.");
    names.add(folded);
    for (const entry of [change.before, change.after]) if (entry) {
      if (!validEntry(entry) || readProposalBlob(proposal, entry.hash).length !== entry.size) throw new AgentWorkspaceError(422, "Invalid proposal file metadata.");
    }
  }
  return proposal;
}
