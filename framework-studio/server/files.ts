import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The files the studio may write, and how it recognizes them unchanged.
 *
 * Exactly the composition root and the section modules beside it. Anything
 * else — CDK, handlers, generated output, env files — is refused before a
 * write is attempted, whatever a request asks for.
 */

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toRelative(repositoryRoot: string, file: string): string {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

/** Every file a plan may touch, repository-relative. */
export function editableFiles(repositoryRoot: string): string[] {
  const files = ["framework.config.ts"];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(toRelative(repositoryRoot, absolute));
    }
  };
  const configDirectory = path.join(repositoryRoot, "framework-config");
  if (existsSync(configDirectory)) visit(configDirectory);
  return files.sort();
}

export function hashEditableFiles(repositoryRoot: string): Record<string, string> {
  return Object.fromEntries(
    editableFiles(repositoryRoot).map((file) => [file, sha256(readFileSync(path.join(repositoryRoot, file), "utf8"))]),
  );
}

/**
 * The absolute path of a file the studio may write, or an error saying why not.
 *
 * Checked by real path, so a symlink or junction cannot carry a write outside
 * the repository, and against the allowlist, so nothing outside
 * framework.config.ts and framework-config/ is ever a destination.
 */
export function assertWritable(repositoryRoot: string, relativeFile: string): string {
  const normalized = relativeFile.replaceAll("\\", "/");
  const allowed =
    normalized === "framework.config.ts" ||
    (/^framework-config\/[A-Za-z0-9._/-]+\.ts$/.test(normalized) && !normalized.split("/").includes(".."));
  if (!allowed) {
    throw new Error(`${relativeFile} is not a file the studio writes. It edits framework.config.ts and framework-config/*.ts only.`);
  }
  const absolute = path.resolve(repositoryRoot, normalized);
  if (!existsSync(absolute)) throw new Error(`${normalized} does not exist.`);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${normalized} is a symbolic link; the studio does not write through links.`);
  const root = realpathSync(repositoryRoot);
  const real = realpathSync(absolute);
  const inside = path.relative(root, real);
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`${normalized} resolves outside the repository.`);
  return absolute;
}
