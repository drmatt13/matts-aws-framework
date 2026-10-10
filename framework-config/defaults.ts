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
    // Outside the VPC, with the whole internet. A Lambda with vpc: true runs in
    // the network's private subnets instead: IPv6 out only, unless network.ts
    // turns on its NAT gateway. database: true implies it.
    vpc: false,
  },
  // Preserve the existing container runtime until the ARM migration is chosen.
  // Tasks and services may override cloud.architecture in their declarations.
  //
  // "private" containers leave through the network's NAT gateway, so a
  // deployed one needs nat: true in network.ts (about $33 a month). "public"
  // gives each task a public IPv4 address instead (about $3.65 a month always
  // on) and needs no NAT. Tasks and services may override cloud.subnet in
  // their declarations.
  container: { architecture: "x86_64", subnet: "private" },
  // Connection-lifecycle handlers should fail fast rather than hold a socket
  // open.
  webSocket: { timeoutSeconds: 3 },
} satisfies Defaults;
