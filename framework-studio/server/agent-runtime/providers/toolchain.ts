import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

interface MachImage { libraries: string[]; rpaths: string[] }
export function parseMachImage(libraries: string, loadCommands: string): MachImage {
  const names = libraries.split("\n").slice(1).map(line => /^\s+(.+?) \(compatibility version/.exec(line)?.[1]).filter((value): value is string => !!value);
  const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\r?\n\s+cmdsize \d+\r?\n\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
  return { libraries: names, rpaths };
}

function inspect(file: string, args: string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" }, windowsHide: true });
  if (result.error || result.status !== 0) {
    // Fixed trusted tools inspect binary metadata only. Report OS classifications
    // to distinguish contention/timeouts from denied execution, without raw
    // stderr, library paths or inherited configuration contents.
    const code = result.error && "code" in result.error && typeof result.error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(result.error.code) ? result.error.code : "none";
    const signal = result.signal && /^SIG[A-Z0-9]{1,20}$/.test(result.signal) ? result.signal : "none";
    throw new Error(`Cannot inspect Node toolchain (${path.basename(file)}; code=${code}; exit=${result.status ?? "none"}; signal=${signal}). Coding remains disabled.`);
  }
  return result.stdout;
}

let cached: { key: string; paths: string[] } | undefined;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Read-only launchers re-establish audited dyld paths after SIP-protected shells
 * strip DYLD_* variables. They live outside both candidate and writable scratch.
 */
export function createToolchainLaunchers(scratchDir: string, readPaths: string[]): { directory: string; environment: Record<string, string> } {
  const directory = mkdtempSync(path.join(path.dirname(scratchDir), "provider-runtime-"));
  const libraryPaths = [...new Set(readPaths.map(value => realpathSync(value)))];
  // macOS /bin/sh consults an extra selector symlink before loading its shell.
  // Use the inspected system executable directly, without granting /var reads.
  const shell = realpathSync(process.platform === "darwin" ? "/private/var/select/sh" : "/bin/sh");
  if (!shell.startsWith("/bin/") && !shell.startsWith("/usr/bin/")) throw new Error("The system shell resolves outside trusted platform binaries.");
  const environment: Record<string, string> = { PATH: [directory, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter), OPENSSL_CONF: "/dev/null",
    npm_config_script_shell: shell, npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
  if (process.platform === "darwin") environment.DYLD_LIBRARY_PATH = libraryPaths.join(path.delimiter);
  const exports = Object.entries(environment).filter(([key]) => key !== "PATH").map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  const node = realpathSync(process.execPath), npm = installedNpm();
  for (const [name, prefix] of [["node", []], ["npm", [npm.entry]]] as const) {
    writeFileSync(path.join(directory, name), `#!${shell}\n${exports}\nexec ${[node, ...prefix].map(shellQuote).join(" ")} "$@"\n`, { flag: "wx", mode: 0o500 });
  }
  chmodSync(directory, 0o700);
  return { directory, environment };
}
export function installedNpm(): { entry: string; directory: string } {
  const nodeBin = path.dirname(realpathSync(process.execPath));
  const candidates = [path.join(nodeBin, "npm"), path.join(nodeBin, "../lib/node_modules/npm/bin/npm-cli.js"),
    ...[process.env.npm_execpath, ...(process.env.PATH ?? "").split(path.delimiter).filter(item => path.isAbsolute(item)).map(item => path.join(item, "npm"))].filter((item): item is string => !!item)];
  for (const candidate of candidates) {
    try {
      const entry = realpathSync(candidate);
      if (path.basename(entry) !== "npm-cli.js") continue;
      const directory = path.dirname(path.dirname(entry));
      const relative = path.relative(realpathSync(process.cwd()), directory);
      if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      if (JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name !== "npm") continue;
      return { entry, directory };
    } catch { /* Try the next installed executable. */ }
  }
  throw new Error("An installed npm CLI outside project source is required for validation.");
}
/** Inspect only the trusted Node executable already running Studio, never candidate binaries.
 * Dynamic libraries remain read-only. No PATH directory or whole Homebrew prefix is granted.
 */
export function nodeToolchainReadPaths(executable = process.execPath, platform = process.platform): string[] {
  const canonical = realpathSync(executable), stat = statSync(canonical);
  const key = `${platform}:${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (cached?.key === key) return [...cached.paths];
  const paths = new Set([path.dirname(canonical), path.dirname(executable)]);
  const addLibraryPath = (file: string, resolved: string) => {
    paths.add(path.dirname(file)); paths.add(path.dirname(resolved));
    let ancestor = path.dirname(file);
    while (ancestor !== path.dirname(ancestor)) {
      if (lstatSync(ancestor).isSymbolicLink()) {
        const target = realpathSync(ancestor), relative = path.relative(target, resolved);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || target === "/" || target === process.env.HOME)
          throw new Error("A toolchain symlink does not lead to its inspected library.");
        // Grant the specific installed package alias, never every package in opt/.
        paths.add(ancestor);
      }
      ancestor = path.dirname(ancestor);
    }
  };
  if (platform === "darwin") {
    const inspected = new Set<string>();
    const executableDirectory = path.dirname(canonical);
    const expand = (value: string, owner: string) => value.replace(/^@loader_path(?=\/|$)/, path.dirname(owner)).replace(/^@executable_path(?=\/|$)/, executableDirectory);
    const visit = (file: string, inheritedRpaths: string[]) => {
      if (file.startsWith("/usr/lib/") || file.startsWith("/System/Library/")) return; // macOS shared cache; covered by minimal platform policy.
      const resolved = realpathSync(file);
      addLibraryPath(file, resolved);
      if (inspected.has(resolved)) return;
      if (inspected.size >= 256) throw new Error("The Node dynamic library closure exceeds the sandbox policy limit.");
      inspected.add(resolved);
      const image = parseMachImage(inspect("/usr/bin/otool", ["-L", resolved]), inspect("/usr/bin/otool", ["-l", resolved]));
      const rpaths = [...image.rpaths.map(value => expand(value, resolved)), ...inheritedRpaths];
      for (const library of image.libraries) {
        let target = expand(library, resolved);
        if (target.startsWith("@rpath/")) {
          const suffix = target.slice(7);
          const found = rpaths.map(root => path.resolve(root, suffix)).find(candidate => existsSync(candidate));
          if (!found) throw new Error("A Node dynamic library cannot be resolved without broad filesystem access.");
          target = found;
        }
        if (!path.isAbsolute(target)) throw new Error("The Node toolchain contains an unsupported dynamic library reference.");
        visit(target, rpaths);
      }
    };
    visit(canonical, []);
  } else if (platform === "linux") {
    const result = spawnSync("/usr/bin/ldd", [canonical], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0 && !/not a dynamic executable|statically linked/.test(result.stdout + result.stderr)) throw new Error("Cannot inspect Node's Linux runtime libraries.");
    for (const line of result.stdout.split("\n")) {
      const library = /(?:=>\s+|^\s*)(\/\S+)\s+\(/.exec(line)?.[1];
      if (library) addLibraryPath(library, realpathSync(library));
      if (/=>\s+not found/.test(line)) throw new Error("The installed Node toolchain has a missing runtime library.");
    }
  }
  const sorted = [...paths].sort();
  // A malformed toolchain must not accidentally grant the host filesystem.
  if (sorted.some(value => value === "/" || value === process.env.HOME)) throw new Error("Unsafe Node toolchain read root.");
  cached = { key, paths: sorted };
  return [...sorted];
}
