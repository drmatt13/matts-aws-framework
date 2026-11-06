import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentProvider } from "./providers/types";
import { createToolchainLaunchers, installedNpm, nodeToolchainReadPaths } from "./providers/toolchain";

export interface ExecutionPolicy { cwd: string; scratchDir: string; profile: string; environment: NodeJS.ProcessEnv; commandEnvironment: Record<string, string>; runtimeDirectory: string; config: Record<string, unknown>; toolchainReadPaths: string[]; readOnlyCwd?: boolean }
export interface PolicyOptions { readOnlyCwd?: boolean; readPaths?: string[] }

export function providerExecutable(provider: AgentProvider, env = process.env): string {
  const directories = (env.PATH ?? "").split(path.delimiter).filter(value => path.isAbsolute(value));
  if (env.HOME) directories.push(path.join(env.HOME, ".local/bin"));
  for (const directory of directories) {
    try {
      const file = realpathSync(path.join(directory, process.platform === "win32" ? `${provider}.exe` : provider));
      if (/(?:^|[\\/])(?:\.vscode(?:-insiders)?|\.cursor|\.windsurf)[\\/]extensions[\\/]/.test(file)) continue;
      accessSync(file, constants.X_OK);
      if (lstatSync(file).isFile()) return file;
    } catch { /* Try the next standalone install. */ }
  }
  throw new Error(`Standalone ${provider} CLI is unavailable. Sign in through its terminal application first.`);
}

/** CLI owns saved authentication. Never copy tokens or inherit AWS/application secrets. */
export function providerEnvironment(scratchDir: string, source = process.env): NodeJS.ProcessEnv {
  // Candidate commands must not load host OpenSSL engines/configuration. The
  // default providers work without it; no network/TLS verification is bypassed.
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, OPENSSL_CONF: "/dev/null" };
  for (const key of ["PATH", "HOME", "USER", "USERPROFILE", "SYSTEMROOT", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
    if (source[key]) env[key] = source[key];
  return env;
}

export function executionPolicy(cwd: string, scratchDir: string, options: PolicyOptions = {}): ExecutionPolicy {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Coding execution requires a verified macOS or Linux sandbox. Native Windows execution is unavailable.");
  cwd = realpathSync(cwd);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  scratchDir = realpathSync(scratchDir);
  if (cwd === scratchDir || scratchDir.startsWith(`${cwd}${path.sep}`)) throw new Error("Provider scratch storage must be outside candidate source.");
  const profile = `studio_${randomUUID().replaceAll("-", "")}`;
  const filesystem: Record<string, unknown> = { ":minimal": "read", [cwd]: options.readOnlyCwd ? "read" : "write", [scratchDir]: "write" };
  const extra = (options.readPaths ?? []).map(value => {
    if (!path.isAbsolute(value)) throw new Error("Trusted runtime read paths must be absolute.");
    const resolved = realpathSync(value);
    if ([path.parse(resolved).root, process.env.HOME, realpathSync(process.cwd())].includes(resolved)) throw new Error("Broad host runtime read grants are prohibited.");
    return resolved;
  });
  const nodeReads = nodeToolchainReadPaths();
  const runtime = createToolchainLaunchers(scratchDir, nodeReads);
  const commandEnvironment = { ...runtime.environment, HOME: scratchDir, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, LANG: "en_US.UTF-8" };
  const toolchainReadPaths = [...nodeReads, installedNpm().directory, runtime.directory, ...extra];
  for (const directory of toolchainReadPaths) filesystem[directory] = "read";
  for (const relative of [".git", ".codex", ".claude", ".mcp.json"]) filesystem[path.join(cwd, relative)] = "deny";
  return { cwd, scratchDir, profile, environment: { ...providerEnvironment(scratchDir), PATH: runtime.environment.PATH }, commandEnvironment, runtimeDirectory: runtime.directory, toolchainReadPaths, readOnlyCwd: options.readOnlyCwd, config: {
    default_permissions: profile,
    permissions: { [profile]: { filesystem, network: { enabled: false } } },
    approval_policy: "never", approvals_reviewer: "user", web_search: "disabled",
    mcp_servers: {}, hooks: {}, notify: [],
    shell_environment_policy: { inherit: "none", set: commandEnvironment },
  } };
}

export const DISABLED_CODEX_FEATURES = ["hooks", "apps", "enable_mcp_apps", "plugins", "remote_plugin", "mcp_connection_sharing", "skill_mcp_dependency_install",
  "multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "memories", "shell_snapshot", "goals", "web_search_request", "web_search_cached",
  "computer_use", "browser_use", "in_app_browser", "browser_use_external", "browser_use_full_cdp_access"];

/** TOML inline values, never shell strings. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`).join(",")}}`;
  throw new Error("Unsupported provider configuration value.");
}

export function codexArguments(policy: ExecutionPolicy) {
  return ["app-server", "--listen", "stdio://", ...Object.entries(policy.config).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]),
    ...DISABLED_CODEX_FEATURES.flatMap(feature => ["--disable", feature])];
}

export function claudeArguments(policy: ExecutionPolicy, model?: string, sessionId?: string) {
  const settings = {
    disableAllHooks: true,
    permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [], autoAllowBashIfSandboxed: false,
      filesystem: { denyRead: ["/"], allowRead: [policy.cwd, policy.scratchDir, "/usr", "/bin", "/System/Library", "/Library/Apple", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", ...policy.toolchainReadPaths], allowWrite: [...(policy.readOnlyCwd ? [] : [policy.cwd]), policy.scratchDir], denyWrite: [...(policy.readOnlyCwd ? [policy.cwd] : []), ...[".git", ".codex", ".claude", ".mcp.json"].map(name => path.join(policy.cwd, name))] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] } },
  };
  // Native Claude Bash permits macOS credential Mach services; native file
  // tools also bypass the shell boundary. Expose only the host's fixed SDK MCP.
  return ["--safe-mode", "--restricted", "--add-dir", policy.scratchDir, "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{"studio_shell":{"type":"sdk","name":"studio_shell"}}}',
    "--setting-sources", "", "--settings", JSON.stringify(settings), "--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-chrome",
    ...(model ? [`--model=${model}`] : []), ...(sessionId ? [`--resume=${sessionId}`] : []), "-p"];
}
