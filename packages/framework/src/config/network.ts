/**
 * The application's network: one VPC, built by a production deployment the
 * first time a Lambda declares `vpc: true` or `database: true`, or a container
 * needs a subnet.
 *
 * Declared once, in framework-config/network.ts, and deliberately small. The
 * layout is fixed — a public, a private and an isolated subnet in each zone —
 * so the choices are the address range, how many zones it spans, and whether
 * it pays for a NAT gateway. The first two are set once: subnets are numbered
 * in order, so changing either renumbers every subnet and replaces everything
 * inside them.
 *
 * Private subnets are dual-stack. IPv6 leaves through an egress-only internet
 * gateway, which AWS does not charge for, so a Lambda in one reaches Cognito,
 * Secrets Manager and every AWS API with a dual-stack endpoint at no cost.
 * IPv4 leaves only through a NAT gateway, which is never built unless `nat`
 * says so.
 *
 * A development deployment never builds it. What a dev deployment puts in AWS
 * is what AWS itself invokes, and the database is absent from that graph and
 * runs under Compose instead — where the local lane enforces the rules this
 * network would (see `database: true`).
 */

export const NETWORK_BRAND = "@repo/framework/network" as const;

/** What `defineNetwork` takes. */
export interface NetworkDeclaration {
  /**
   * The VPC's IPv4 range: a private /16 such as "10.0.0.0/16". The IPv6 range
   * is Amazon-provided and never written.
   */
  readonly cidr: string;
  /** Availability zones the subnets span. RDS needs at least two. */
  readonly zones: 2 | 3;
  /**
   * One NAT gateway, giving the private subnets an IPv4 route out: about $33 a
   * month plus $0.045 per GB. Off unless set. A container needs it to run in a
   * private subnet, because Fargate pulls its image over IPv4; with it, a
   * Lambda in the VPC reaches IPv4-only hosts too.
   */
  readonly nat?: boolean;
}

/** A validated network declaration. */
export interface FrameworkNetwork extends NetworkDeclaration {
  readonly $network: typeof NETWORK_BRAND;
  readonly nat: boolean;
}

/**
 * The fixed per-zone layout, in the order addresses are allocated. Appending a
 * tier keeps every existing subnet's range; inserting or removing one does not,
 * which is why the public tier is always present even when nothing uses it.
 */
export const NETWORK_SUBNET_LAYOUT = [
  { name: "public", tier: "public", cidrMask: 24 },
  { name: "private", tier: "private", cidrMask: 20 },
  { name: "isolated", tier: "isolated", cidrMask: 24 },
] as const;

const PRIVATE_SLASH_16 = /^(10\.(\d{1,3})|172\.(1[6-9]|2\d|3[01])|192\.168)\.0\.0\/16$/;

/**
 * Declares the application's network.
 *
 * ```ts
 * export const network = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: false });
 * ```
 */
export function defineNetwork(declaration: NetworkDeclaration): FrameworkNetwork {
  const { cidr, zones, nat = false } = declaration;
  const match = typeof cidr === "string" ? PRIVATE_SLASH_16.exec(cidr) : null;
  if (!match || (match[2] !== undefined && Number(match[2]) > 255)) {
    throw new Error(
      `defineNetwork() takes a private /16 for cidr, such as "10.0.0.0/16". Received ${JSON.stringify(cidr)}.`,
    );
  }
  if (zones !== 2 && zones !== 3) {
    throw new Error(
      `defineNetwork() spans 2 or 3 zones; RDS needs at least two. Received ${JSON.stringify(zones)}.`,
    );
  }
  if (typeof nat !== "boolean") {
    throw new Error(`defineNetwork() takes true or false for nat. Received ${JSON.stringify(nat)}.`);
  }
  return Object.freeze({ $network: NETWORK_BRAND, cidr, zones, nat });
}

export function isFrameworkNetwork(value: unknown): value is FrameworkNetwork {
  return typeof value === "object" && value !== null && (value as FrameworkNetwork).$network === NETWORK_BRAND;
}
