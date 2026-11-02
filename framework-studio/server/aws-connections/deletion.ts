import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAwsDocument } from "../../../scripts/aws-connections";
import { isAwsProfileName } from "../../shared/aws-connections";
import type { AwsProfileDeletionReview } from "../../shared/aws-connection-management";
import { authority, awsPaths, ConnectionInputError, iniSections, safeParent, type FileAuthority } from "./configuration";

type FileKind = "config" | "credentials";
interface DeletionFile { kind: FileKind; file: string; before: FileAuthority; after: string }
interface StoredDeletion {
  view: AwsProfileDeletionReview;
  paths: ReturnType<typeof awsPaths>;
  originals: Record<FileKind, FileAuthority>;
  files: DeletionFile[];
}
interface PreparedFile extends DeletionFile { temporary: string; restore: string; replaced?: boolean; writtenIdentity?: string }
interface DeletionOptions {
  /** Host-only injection for filesystem-failure fixtures; never supplied by HTTP callers. */
  readonly replace?: typeof renameSync;
}
const kinds = ["config", "credentials"] as const;
const expired = () => new ConnectionInputError(409, "This deletion review expired. Review the profile again.");
const changed = () => new ConnectionInputError(409, "AWS configuration changed after review. Refresh and review deletion again; nothing was written.");

function profileName(header: string, kind: FileKind): string | undefined {
  return kind === "credentials" || header === "default" ? header : /^profile[ \t]+(.+)$/.exec(header)?.[1]?.trim();
}
/** Remove only this profile's header/settings. Preserve standalone comments and blank lines. */
export function removeProfileSection(text: string, profile: string, kind: FileKind): { text: string; found: boolean } {
  const sections = iniSections(text).filter(section => profileName(section.name, kind) === profile);
  if (sections.length > 1) throw new ConnectionInputError(422, "The selected profile has duplicate sections. Resolve them outside Studio before deletion.");
  const section = sections[0];
  if (!section) return { text, found: false };
  const body = text.slice(section.body, section.end);
  const comments = [...body.matchAll(/([^\r\n]*)(\r?\n|$)/g)].filter(line => line[0] && (!line[1]!.trim() || /^[ \t]*[;#]/.test(line[1]!))).map(line => line[0]).join("");
  return { text: text.slice(0, section.start) + comments + text.slice(section.end), found: true };
}
function managed(text: string): boolean {
  return /^[ \t]*[;#][^\r\n]*(?:\b(?:auto[ -]?)?generated\b|\bmanaged by\b|\bexternally managed\b|\bdo not (?:edit|modify)\b)/im.test(text);
}
function dependents(profile: string, originals: Record<FileKind, FileAuthority>): string[] {
  // Inspect every source declaration, including duplicates, rather than trusting a
  // winning value from a loader to hide a relationship that deletion would break.
  const edges: { name: string; source: string }[] = [];
  for (const kind of kinds) for (const section of iniSections(originals[kind].text)) {
    const name = profileName(section.name, kind);
    if (!name || !isAwsProfileName(name)) continue;
    const body = originals[kind].text.slice(section.body, section.end);
    let nested = false;
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim() || /^[ \t]*[;#]/.test(line)) continue;
      if (nested && /^[ \t]/.test(line)) continue;
      const setting = /^[ \t]*([^=\s]+)[ \t]*=[ \t]*(.*)$/.exec(line);
      if (!setting) continue;
      const value = setting[2]!.replace(/\s+[;#].*$/, "").trim();
      nested = !value;
      if (setting[1]!.toLowerCase() === "source_profile" && value) edges.push({ name, source: value });
    }
  }
  const affected = new Set([profile]);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) if (affected.has(edge.source) && !affected.has(edge.name)) { affected.add(edge.name); changed = true; }
  }
  return [...affected].filter(name => name !== profile).sort((a, b) => a.localeCompare(b));
}
function writePrivate(file: string, text: string, original: FileAuthority): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    // Match the original only at replacement time. Staged credentials/backups are
    // always private, even if the original shared configuration is world-readable.
    if (process.platform !== "win32" && original.uid !== undefined && original.gid !== undefined) fchownSync(fd, original.uid, original.gid);
    writeFileSync(fd, text, "utf8"); fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function preparePermissions(file: string, original: FileAuthority): void {
  const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try { fchmodSync(fd, original.mode ?? 0o600); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Machine-local reviewed deletion; never signs out or changes native caches/cloud resources. */
export class ProfileDeletion {
  private readonly reviews = new Map<string, StoredDeletion>();
  private readonly replace: typeof renameSync;
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly busy: (profiles: readonly string[]) => boolean = () => false, options: DeletionOptions = {}) {
    this.replace = options.replace ?? renameSync;
  }
  review(profile: string): AwsProfileDeletionReview {
    if (!isAwsProfileName(profile)) throw new ConnectionInputError(400, "Choose an AWS profile to delete.");
    for (const [id, stored] of this.reviews) if (Date.parse(stored.view.expiresAt) <= Date.now()) this.reviews.delete(id);
    const paths = awsPaths(this.env);
    const originals = { config: authority(paths.config), credentials: authority(paths.credentials) };
    const blockers: string[] = [];
    const files: DeletionFile[] = [];
    for (const kind of kinds) {
      const before = originals[kind];
      const parsed = parseAwsDocument(before.text, kind);
      const selected = iniSections(before.text).filter(section => profileName(section.name, kind) === profile);
      if (parsed.diagnostics.some(issue => ["invalid-file", "invalid-section", "invalid-setting"].includes(issue.code))) blockers.push(`The AWS ${kind} file contains unsupported or malformed syntax. Repair it outside Studio before deletion.`);
      if (!selected.length) continue;
      if (selected.length > 1 || parsed.ambiguousProfiles.has(profile)) blockers.push(`The profile has duplicate definitions in the AWS ${kind} file. Resolve them outside Studio before deletion.`);
      if (managed(before.text)) blockers.push(`The AWS ${kind} file declares that another tool manages it. Delete this profile through that tool.`);
      try { safeParent(paths[kind]); authority(paths[kind], true); }
      catch { blockers.push(`The AWS ${kind} file is linked, read-only, or cannot be safely replaced. Delete this profile outside Studio.`); }
      const after = selected.length === 1 ? removeProfileSection(before.text, profile, kind).text : before.text;
      files.push({ kind, file: paths[kind], before, after });
    }
    if (!files.length) throw new ConnectionInputError(409, "That AWS profile no longer exists. Refresh the profile list.");
    if (paths.config === paths.credentials) blockers.push("AWS config and credentials point to the same file. Separate them outside Studio before deletion.");
    const dependentProfiles = dependents(profile, originals);
    if (dependentProfiles.length) blockers.push("Other profiles use this profile as a credential source. Change their source profiles before deleting it.");
    if (this.busy([profile, ...dependentProfiles])) blockers.push("This profile is in use by an AWS operation or sign-in. Wait for it to finish before deleting.");
    const view: AwsProfileDeletionReview = { id: randomUUID(), name: profile, files: files.map(file => file.kind), dependentProfiles, blockers: [...new Set(blockers)], expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() };
    this.reviews.set(view.id, { view, paths, originals, files });
    return view;
  }
  get(id: string): AwsProfileDeletionReview {
    const stored = this.reviews.get(id);
    if (!stored || Date.parse(stored.view.expiresAt) <= Date.now()) throw expired();
    return stored.view;
  }
  apply(id: string): { name: string; changed: true } {
    const view = this.get(id), stored = this.reviews.get(id)!;
    if (view.blockers.length) throw new ConnectionInputError(409, "This profile cannot be deleted until its listed issues are resolved. Refresh and review it again.");
    if (this.busy([view.name, ...view.dependentProfiles])) throw new ConnectionInputError(409, "This profile is in use by an AWS operation or sign-in. Wait before deleting.");
    const currentPaths = awsPaths(this.env);
    if (kinds.some(kind => currentPaths[kind] !== stored.paths[kind])) throw changed();
    const verifyOriginals = () => {
      if (kinds.some(kind => authority(stored.paths[kind]).identity !== stored.originals[kind].identity)) throw changed();
      for (const file of stored.files) { safeParent(file.file); authority(file.file, true); }
    };
    verifyOriginals();
    const locks: { file: string; fd: number }[] = [];
    const prepared: PreparedFile[] = [];
    let preserveRestore = false;
    try {
      for (const file of [...stored.files].sort((a, b) => a.file.localeCompare(b.file))) {
        const lockFile = `${file.file}.studio-profile-lock`;
        try { locks.push({ file: lockFile, fd: openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) }); }
        catch { throw new ConnectionInputError(409, "Another AWS configuration write or an unresolved Studio lock exists. Wait or inspect the lock before reviewing deletion again."); }
      }
      verifyOriginals();
      // Prepare all replacements and protected restoration copies before any effect.
      for (const file of stored.files) {
        const prefix = path.join(path.dirname(file.file), `.studio-profile-delete-${randomUUID()}`);
        const staged = { ...file, temporary: `${prefix}.tmp`, restore: `${prefix}.restore` };
        prepared.push(staged);
        writePrivate(staged.temporary, file.after, file.before);
        writePrivate(staged.restore, file.before.text, file.before);
      }
      verifyOriginals();
      for (const file of prepared) {
        // Recheck every destination immediately before each replacement, including
        // earlier writes, so a concurrent external editor stops the transaction.
        for (const kind of kinds) {
          const prior = prepared.find(entry => entry.kind === kind);
          if (authority(stored.paths[kind]).identity !== (prior?.writtenIdentity ?? stored.originals[kind].identity)) throw changed();
        }
        safeParent(file.file);
        preparePermissions(file.temporary, file.before);
        this.replace(file.temporary, file.file);
        file.replaced = true;
        const written = authority(file.file, true);
        if (written.text !== file.after) throw changed();
        file.writtenIdentity = written.identity;
      }
      for (const kind of kinds) if (authority(stored.paths[kind]).identity !== (prepared.find(file => file.kind === kind)?.writtenIdentity ?? stored.originals[kind].identity)) throw changed();
      this.reviews.delete(id);
      return { name: view.name, changed: true };
    } catch (error) {
      let conflict = false;
      let restorationFailed = false;
      for (const file of [...prepared].reverse()) if (file.replaced) {
        try {
          // Roll back only our exact replacement, never a subsequent external edit.
          if (!file.writtenIdentity || authority(file.file, true).identity !== file.writtenIdentity) { conflict = true; continue; }
          safeParent(file.file);
          preparePermissions(file.restore, file.before);
          this.replace(file.restore, file.file);
        } catch {
          restorationFailed = true;
          // Failed restoration must not leave a previously widened staging mode.
          try { preparePermissions(file.restore, { ...file.before, mode: 0o600 }); } catch { /* The final diagnostic requires manual filesystem recovery. */ }
        }
      }
      this.reviews.delete(id);
      if (conflict || restorationFailed) {
        preserveRestore = true;
        throw new ConnectionInputError(422, "Profile deletion stopped after a concurrent edit or filesystem failure. Current external edits were preserved. Review both AWS files before continuing; protected .studio-profile-delete-*.restore files retain the original content.");
      }
      if (error instanceof ConnectionInputError) throw error;
      throw new ConnectionInputError(422, "The profile could not be deleted safely. Completed replacements were restored; no profile deletion was applied.");
    } finally {
      for (const file of prepared) for (const temporary of [file.temporary, ...(preserveRestore ? [] : [file.restore])]) try { rmSync(temporary, { force: true }); } catch { /* Keep private artifacts when the filesystem denies cleanup. */ }
      for (const lock of locks.reverse()) { closeSync(lock.fd); try { rmSync(lock.file, { force: true }); } catch { /* An unresolved lock blocks later writes. */ } }
    }
  }
  discard(id: string) { this.reviews.delete(id); }
  dispose() { this.reviews.clear(); }
}
