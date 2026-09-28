import type { FrameworkDefaults as Defaults } from "@repo/framework/config";

/**
 * Compute defaults, before a section's overrides and anything an entry declares.
 */
export const defaults = {
  lambda: {
    runtime: "nodejs24",
    packaging: "zip",
    architecture: "arm64",
    memorySize: 128,
    timeoutSeconds: 10,
    bundling: { minify: true, sourceMap: true },
    logRetentionDays: 30,
  },
  // Preserve the existing container runtime until the ARM migration is chosen.
  // Tasks and services may override cloud.architecture in their declarations.
  container: { architecture: "x86_64" },
  // Connection-lifecycle handlers should fail fast rather than hold a socket
  // open.
  webSocket: { timeoutSeconds: 3 },
} satisfies Defaults;
