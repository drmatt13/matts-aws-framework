#!/usr/bin/env node
// Fails when package-lock.json lacks registry integrity data or a native binding
// a supported platform needs.
//
// npm records a package's platform binaries as optional dependencies, and a
// lockfile written on one machine can silently lack another platform's entries.
// `npm ci` then succeeds everywhere and the tool fails at runtime on the
// platform that lost its binary.
import { readFileSync } from "node:fs";

// Where this repository is developed and run: macOS hosts, the Linux (glibc,
// node:24-bookworm-slim) containers on arm64 and x64, and Windows hosts.
const PLATFORMS = {
  "darwin-arm64": /darwin-arm64$/,
  "linux-arm64-gnu": /linux-arm64(-gnu)?$/,
  "linux-x64-gnu": /linux-(x64|64)(-gnu)?$/,
  "win32-x64": /(win32-x64(-msvc)?|windows-64)$/,
};

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const present = new Set(
  Object.keys(lock.packages).map((path) => path.replace(/^.*node_modules\//, "")),
);

const missing = [];
const missingRegistryMetadata = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  // Bundled dependencies are covered by their parent's tarball integrity. Links
  // and file/git sources do not have registry tarballs to pin.
  const registryPackage = path.includes("node_modules/") && !entry.link && !entry.inBundle &&
    (!entry.resolved || entry.resolved.startsWith("https://registry.npmjs.org/"));
  if (registryPackage && (!entry.resolved || !entry.integrity)) {
    missingRegistryMetadata.push(`${path}@${entry.version}`);
  }
  const optional = Object.keys(entry.optionalDependencies ?? {});
  for (const [platform, pattern] of Object.entries(PLATFORMS)) {
    for (const dependency of optional.filter((name) => pattern.test(name))) {
      if (!present.has(dependency)) {
        const owner = path.replace(/^.*node_modules\//, "") || "(root)";
        missing.push(`${owner}@${entry.version}: ${dependency} (${platform})`);
      }
    }
  }
}

if (missingRegistryMetadata.length > 0) {
  console.error(`package-lock.json lacks registry URLs or integrity hashes for ${missingRegistryMetadata.length} package(s):`);
  for (const line of missingRegistryMetadata) console.error(`  ${line}`);
  console.error("Restore metadata with npm 11 in a clean install before approving version-pinned scripts.");
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`package-lock.json lacks ${missing.length} native binding(s):`);
  for (const line of missing) console.error(`  ${line}`);
  console.error(
    "Add each entry (resolved and integrity from `npm view <name>@<version> dist`), then run `npm install --package-lock-only` with npm 11 until it reports no change.",
  );
  process.exit(1);
}
console.log(`package-lock.json has native bindings for ${Object.keys(PLATFORMS).join(", ")}.`);
