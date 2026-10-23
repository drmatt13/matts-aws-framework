import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let flagProfile;
let detach = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--detach") {
    // Start the stack in the background and return: Framework Studio runs it
    // this way, then watches the running stack with docker compose watch --no-up.
    detach = true;
    continue;
  }
  if (arg === "--profile") {
    flagProfile = args[++index];
  } else if (arg.startsWith("--profile=")) {
    flagProfile = arg.slice("--profile=".length);
  } else {
    console.error(`Unknown dev option: ${arg}`);
    process.exit(1);
  }
  if (!flagProfile?.trim()) {
    console.error("--profile needs a nonempty AWS profile name.");
    process.exit(1);
  }
}

// npm 11 treats `npm run dev:containers --profile=name` as an npm config option instead
// of passing it to this script. Support it alongside the standard `--` form.
const profile = flagProfile ?? process.env.npm_config_profile ?? process.env.AWS_PROFILE ?? "default";
if (!profile.trim()) {
  console.error("AWS profile must be nonempty.");
  process.exit(1);
}

// FRAMEWORK_DOCKER_CLI names a Node script to run in place of docker: the
// tests' simulated engine. Everything here runs from the repository root, where
// docker-compose.yml is, whatever directory the command was started in.
const dockerCommand = process.env.FRAMEWORK_DOCKER_CLI
  ? { file: process.execPath, prefix: [process.env.FRAMEWORK_DOCKER_CLI] }
  : { file: "docker", prefix: [] };
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Removes the development images this Compose project no longer runs.
 *
 * `up --build` tags a new image for each service whenever the source changed,
 * and the image the tag named before is left untagged. Those, and the images of
 * services this file no longer declares, are what this removes; the invocation
 * runner reclaims the task and container-Lambda images it builds itself.
 *
 * It runs before Compose builds, so the previous start's images are still held
 * by that start's stopped containers and survive until the next start: the
 * debt is bounded at one generation, without hooking into a running `up`.
 * Nothing is forced, so an image any container uses is skipped. Build cache is
 * left alone: it is what keeps the next build fast. Best effort: nothing here
 * stops the stack from starting.
 */
function reclaimComposeImages(env) {
  const docker = (...args) => {
    const result = spawnSync(dockerCommand.file, [...dockerCommand.prefix, ...args], { cwd: repositoryRoot, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
  };
  const lines = (output) => (output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let project;
  let services;
  try {
    const config = JSON.parse(docker("compose", "config", "--format", "json") ?? "null");
    project = config?.name;
    services = new Set(Object.keys(config?.services ?? {}));
  } catch {
    // `up` reports a configuration problem in its own words.
  }
  if (!project) return;
  const ownImages = `label=com.docker.compose.project=${project}`;

  let removed = 0;
  const tagged = [...new Set(lines(docker("image", "ls", "--quiet", "--no-trunc", "--filter", ownImages)))];
  const inspected = tagged.length > 0
    ? docker("image", "inspect", "--format", '{{json .RepoTags}}\t{{index .Config.Labels "com.docker.compose.service"}}', ...tagged)
    : undefined;
  for (const line of lines(inspected)) {
    const [tags, service] = line.split("\t");
    if (!service || services.has(service)) continue;
    for (const tag of JSON.parse(tags) ?? []) {
      if (docker("image", "rm", tag) !== undefined) removed += 1;
    }
  }

  let pruned = 0;
  let reclaimed;
  // Listed explicitly: `image ls` leaves untagged images out unless asked.
  const superseded = new Set(lines(docker("image", "ls", "--quiet", "--no-trunc", "--filter", "dangling=true", "--filter", ownImages)));
  if (superseded.size > 0) {
    const output = docker("image", "prune", "--force", "--filter", ownImages);
    // The output lists each image's layers too; count only the images.
    const deleted = new Set(lines(output).filter((line) => line.startsWith("deleted:")).map((line) => line.slice("deleted:".length).trim()));
    pruned = [...superseded].filter((id) => deleted.has(id)).length;
    reclaimed = /Total reclaimed space:\s*(\S+)/.exec(output ?? "")?.[1];
  }

  if (removed > 0 || pruned > 0) {
    const parts = [];
    if (pruned > 0) parts.push(`${pruned} superseded development image(s)${reclaimed ? ` (${reclaimed})` : ""}`);
    if (removed > 0) parts.push(`${removed} image(s) of services no longer in docker-compose.yml`);
    console.log(`Removed ${parts.join(" and ")}.`);
  }
}

const env = { ...process.env, LOCAL_AWS_PROFILE: profile };

// Generated files follow framework.config.ts before anything starts, among
// them docker-compose.services.yml, the container of each declared service. A
// config that cannot boot, or a service with no container, stops here with its
// own message rather than in every container at once.
const generation = spawnSync(
  process.execPath,
  ["--import", "tsx", path.join("packages", "framework", "scripts", "generate-contracts.ts")],
  { cwd: repositoryRoot, env, stdio: "inherit" },
);
if (generation.status !== 0) {
  console.error("npm run framework:generate failed, so Compose was not started.");
  process.exit(generation.status ?? 1);
}

try {
  reclaimComposeImages(env);
} catch (error) {
  console.warn(`Skipped development image cleanup: ${error instanceof Error ? error.message : String(error)}`);
}

// --remove-orphans: a container of a service this file no longer declares is
// removed rather than left running beside the stack. The runner's own task and
// Lambda containers carry no Compose labels, so Compose never counts them.
// The default graph only verifies storage. Migration, orphan cleanup and test
// identity services have explicit profiles and never run as startup effects.
// --detach returns after creation; Studio separately verifies application readiness.
const compose = detach ? ["compose", "up", "--detach", "--build", "--remove-orphans"] : ["compose", "up", "--build", "--watch", "--remove-orphans"];
const child = spawn(dockerCommand.file, [...dockerCommand.prefix, ...compose], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env,
});
child.on("error", (error) => {
  console.error(`Unable to start Docker Compose: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (code !== 0 && !signal) console.error("Local startup is incomplete. PostgreSQL or other containers already started may remain running. No startup migrations, orphan cleanup or test identity writes were requested. Open Studio Database → Database status, inspect Local PostgreSQL, then separately review initialization or pending migrations. Retry Start local services after resolving the failed prerequisite; container logs identify other failures.");
  process.exitCode = code ?? (signal ? 1 : 0);
});
