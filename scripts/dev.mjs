import { spawn } from "node:child_process";

let flagProfile;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
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

// npm 11 treats `npm run dev --profile=name` as an npm config option instead
// of passing it to this script. Support it alongside the standard `--` form.
const profile = flagProfile ?? process.env.npm_config_profile ?? process.env.AWS_PROFILE ?? "default";
if (!profile.trim()) {
  console.error("AWS profile must be nonempty.");
  process.exit(1);
}

const child = spawn("docker", ["compose", "up", "--build", "--watch"], {
  stdio: "inherit",
  env: { ...process.env, LOCAL_AWS_PROFILE: profile },
});
child.on("error", (error) => {
  console.error(`Unable to start Docker Compose: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
