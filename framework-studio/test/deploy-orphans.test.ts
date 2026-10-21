import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { clientCommand, composePlugin, systemPluginDirectories } from "../server/deploy/local-commands";

/**
 * Studio's own local processes must end with Studio. On Windows a Node parent
 * takes its Node descendants with it, but not past a program such as cmd.exe
 * (which `npm run` puts between npm and Vite) or docker.exe (which runs Compose
 * as a separate plugin). So the web client and the watch are started directly.
 */

const root = path.resolve(__dirname, "..", "..");

test("the web client runs its dev script's program directly, with no shell between Studio and Vite", () => {
  const command = clientCommand(root, process.env);
  assert.ok(command, "client-app's dev script resolves to a program");
  assert.equal(command!.file, process.execPath);
  assert.match(command!.args[0]!, /vite[\\/]bin[\\/]vite\.js$/);
  assert.deepEqual(command!.args.slice(1), ["dev", "--host", "0.0.0.0", "--port", "3000"]);
  assert.equal(path.resolve(command!.cwd), path.join(root, "client-app"));
  assert.match(command!.display, /npm --workspace client-app run dev/);
});

test("a dev script that needs a shell, or names no installed program, is not run directly", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "studio-client-"));
  try {
    mkdirSync(path.join(directory, "client-app"));
    writeFileSync(path.join(directory, "client-app", "package.json"), JSON.stringify({ scripts: { dev: "vite build && vite preview" } }));
    assert.equal(clientCommand(directory, process.env), undefined);
    writeFileSync(path.join(directory, "client-app", "package.json"), JSON.stringify({ scripts: { dev: "not-installed-anywhere --port 3000" } }));
    assert.equal(clientCommand(directory, process.env), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the Compose plugin is found where the Docker CLI looks for it", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const home = mkdtempSync(path.join(root, ".cache", "studio-home-"));
  const name = process.platform === "win32" ? "docker-compose.exe" : "docker-compose";
  // The system directories are this machine's (Docker Desktop installs one): each case names its own.
  const system = path.join(home, "system-plugins");
  try {
    assert.equal(composePlugin({ HOME: home, USERPROFILE: home, ProgramFiles: home, DOCKER_CONFIG: path.join(home, "none") }, [system]), undefined);
    mkdirSync(system, { recursive: true });
    writeFileSync(path.join(system, name), "");
    assert.equal(composePlugin({ HOME: home, USERPROFILE: home, DOCKER_CONFIG: path.join(home, "none") }, [system]), path.join(system, name), "an installed Docker's plugin is found");
    const plugins = path.join(home, ".docker", "cli-plugins");
    mkdirSync(plugins, { recursive: true });
    const binary = path.join(plugins, name);
    writeFileSync(binary, "");
    assert.equal(composePlugin({ HOME: home, USERPROFILE: home }, [system]), binary, "the user's own plugin comes first");
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.ok(systemPluginDirectories({}).length > 0, "the default looks where Docker installs");
});
