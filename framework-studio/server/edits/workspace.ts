import { readFileSync } from "node:fs";
import path from "node:path";
import { EditError } from "./io";

export function assertWorkspaceDirectory(root: string, relative: string): void {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces?: readonly string[] };
  const matches = manifest.workspaces?.some(pattern => new RegExp("^" + pattern.split("/").map(part => part === "*" ? "[^/]+" : part === "**" ? ".+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$").test(relative));
  if (!matches) throw new EditError(422, "This directory is outside the declared npm workspace patterns. Register its workspace in package.json first, or choose a supported service/agent folder; no files were written.");
}

