import type { FrameworkDefaults as Defaults } from "@repo/framework/config";

/**
 * Compute defaults, before a section's overrides and anything an entry declares.
 */
export const defaults = {
  // One pool per execution environment and connection target. Reduce maxConnections
  // for highly concurrent Lambdas; Proxy pools the underlying writer connections.
  database: { pool: { maxConnections: 10, connectionTimeoutMs: 20_000, idleTimeoutMs: 30_000 } },
  lambda: {
    runtime: "nodejs24",
    packaging: "zip",
    architecture: "arm64",
    memorySize: 128,
    timeoutSeconds: 10,
    bundling: { minify: true, sourceMap: true },
    logRetentionDays: 30,
    // Where a Lambda runs; any section or entry may say otherwise.
    //   "none"     outside the VPC, with the whole internet.
    //   "private"  the network's private subnets, leaving as network.ts
    //              allows: IPv6 through its egress-only gateway, IPv4 only
    //              with its NAT gateway, and its endpoints.
    //   "isolated" the isolated subnets: the database and the network's
    //              endpoints, nothing else.
    // database: true puts a Lambda that would be "none" in "private".
    subnet: "none",
  },
  container: {
    // Preserve the existing container runtime until the ARM migration is
    // chosen. Tasks and services may override cloud.architecture.
    architecture: "x86_64",
    // Fargate always runs in the VPC; this is which subnet. Tasks and services
    // may override cloud.subnet.
    //   "public"   a public IPv4 address per running task (about $3.65 a
    //              month while it runs) and no inbound rules. Starts with
    //              nothing else from network.ts.
    //   "private"  no public address. Fargate pulls the image over IPv4, so it
    //              needs network.ts's NAT gateway (about $33 a month) or its
    //              "ecr.api", "ecr.dkr" and "logs" interface endpoints.
    subnet: "public",
  },
  // Connection-lifecycle handlers should fail fast rather than hold a socket
  // open.
  webSocket: { timeoutSeconds: 3 },
} satisfies Defaults;
