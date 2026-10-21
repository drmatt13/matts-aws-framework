/**
 * The network's egress rule, held on a laptop.
 *
 * A Lambda in the VPC (`subnet: "private"` or `"isolated"`, or `database:
 * true`) reaches, in AWS, only what its subnet routes to: IPv6 through the
 * egress-only internet gateway when the selected VPC declaration has one, and
 * the network's endpoints. A host beyond that is unreachable from there: the
 * connection is not refused, it simply never answers until the function times
 * out. Locally the same call would succeed over the laptop's IPv4, and "works
 * in dev" would stop meaning "works in prod".
 *
 * So the child process that runs such a handler resolves every name through
 * this guard first. A name whose addresses are all private (Compose services,
 * localhost) passes, as it would inside the VPC. So does an AWS hostname one of
 * the network's endpoints answers. Where IPv6 leaves, a public name passes if
 * it publishes an IPv6 address — asked of DNS directly, because a laptop with
 * no IPv6 of its own has those records hidden from `getaddrinfo`. Anything else
 * fails at once, with the reason and the fix, instead of hanging.
 *
 * A subnet with IPv4 out (a NAT gateway) reaches everything, and runs no guard.
 */
import dns from "node:dns";
import net from "node:net";
import { endpointServiceForHost, formatMonthlyCost, NETWORK_PRICES } from "../config/network";

/** What leaves the subnet a Lambda runs in, when it is not everything. */
export interface EgressPolicy {
  /** The Lambda's subnet. */
  readonly subnet: "private" | "isolated";
  /** Whether IPv6 leaves it, through the egress-only internet gateway. */
  readonly ipv6: boolean;
  /** The services the network's endpoints reach, such as "s3" or "secretsmanager". */
  readonly endpoints: readonly string[];
}

/** Addresses a Lambda reaches inside the VPC, or a laptop reaches on its own network. */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (net.isIPv4(mapped)) {
    const [a = 0, b = 0] = mapped.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const lower = mapped.toLowerCase();
  return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

export interface EgressResolver {
  /** Every address the system resolver returns for a name. */
  readonly lookupAll: (hostname: string) => Promise<readonly string[]>;
  /** Whether DNS publishes an IPv6 address for a name. */
  readonly hasIpv6: (hostname: string) => Promise<boolean>;
}

/** Why a host is unreachable from the Lambda's subnet, or undefined when it is reachable. */
export async function egressRefusal(
  hostname: string,
  policy: EgressPolicy,
  resolver: EgressResolver,
): Promise<string | undefined> {
  const beyond = policy.ipv6
    ? "only IPv6 and the network's endpoints leave the VPC's private subnets"
    : `nothing leaves the VPC's ${policy.subnet} subnets but the network's endpoints`;
  if (net.isIPv6(hostname)) {
    return policy.ipv6 || isPrivateAddress(hostname) ? undefined : `${hostname} is outside the VPC, and ${beyond}.`;
  }
  if (net.isIPv4(hostname)) {
    return isPrivateAddress(hostname) ? undefined : `${hostname} is a public IPv4 address, and ${beyond}.`;
  }
  const service = endpointServiceForHost(hostname);
  if (service && policy.endpoints.includes(service)) return undefined;
  const addresses = await resolver.lookupAll(hostname);
  if (addresses.length > 0 && addresses.every(isPrivateAddress)) return undefined;
  if (policy.ipv6) {
    if (addresses.some((address) => net.isIPv6(address) && !isPrivateAddress(address))) return undefined;
    if (await resolver.hasIpv6(hostname)) return undefined;
    return `${hostname} has no IPv6 address, and ${beyond}.`;
  }
  return `${hostname} is outside the VPC, and ${beyond}.`;
}

/** How to reach a host the guard refused, from where the Lambda runs. */
export function egressFix(hostname: string, policy: EgressPolicy): string {
  const service = endpointServiceForHost(hostname);
  const endpoint = service === "s3" || service === "dynamodb"
    ? `turn on gatewayEndpoints.${service} in the selected VPC declaration (free)`
    : service
      ? `add "${service}" to interfaceEndpoints in the selected VPC declaration (about ${formatMonthlyCost(NETWORK_PRICES.interfaceEndpointMonthlyPerZone)} a month per zone)`
      : undefined;
  const route = policy.subnet === "isolated"
    ? `give it subnet: "private"`
    : policy.ipv6
      ? `give the private subnets IPv4 with natGateway: true in the selected VPC declaration (about $33 a month)`
      : `turn on egressOnlyInternetGateway (free) or natGateway in the selected VPC declaration`;
  return endpoint
    ? `${endpoint[0]!.toUpperCase()}${endpoint.slice(1)}, or ${route}.`
    : `Call it from a Lambda outside the VPC (subnet: "none"), or ${route}.`;
}

type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

const systemResolver = (lookup: typeof dns.lookup): EgressResolver => ({
  lookupAll: (hostname) =>
    new Promise((resolve) => {
      (lookup as unknown as LookupAll)(hostname, { all: true }, (error, addresses) =>
        resolve(error ? [] : addresses.map((entry) => entry.address)));
    }),
  hasIpv6: (hostname) =>
    new Promise((resolve) => {
      dns.resolve6(hostname, (error, addresses) => resolve(!error && addresses.length > 0));
    }),
});

let installed = false;

/**
 * Holds this process to its subnet's egress. Installed once, before the
 * handler module is imported, so every client the handler builds goes through
 * it.
 */
export function installEgressGuard(functionName: string, policy: EgressPolicy): void {
  if (installed) return;
  installed = true;
  const original = dns.lookup;
  const resolver = systemResolver(original);
  const verdicts = new Map<string, Promise<string | undefined>>();
  const verdict = (hostname: string): Promise<string | undefined> => {
    let pending = verdicts.get(hostname);
    if (!pending) {
      pending = egressRefusal(hostname, policy, resolver);
      verdicts.set(hostname, pending);
    }
    return pending;
  };
  const refusal = (hostname: string, reason: string): NodeJS.ErrnoException =>
    Object.assign(
      new Error(
        `${reason} ${functionName} has subnet: "${policy.subnet}", so in AWS it cannot reach ${hostname}. ${egressFix(hostname, policy)}`,
      ),
      { code: "ENETUNREACH", syscall: "getaddrinfo", hostname },
    );

  const guarded = function lookup(hostname: string, options: unknown, callback?: unknown): void {
    const done = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const settings = typeof options === "function" ? {} : options;
    void verdict(hostname).then((reason) => {
      if (reason) {
        done(refusal(hostname, reason));
        return;
      }
      (original as (...args: unknown[]) => void).call(dns, hostname, settings, done);
    });
  };
  dns.lookup = guarded as typeof dns.lookup;
  const originalPromise = dns.promises.lookup;
  dns.promises.lookup = (async (hostname: string, options?: unknown) => {
    const reason = await verdict(hostname);
    if (reason) throw refusal(hostname, reason);
    return (originalPromise as (...args: unknown[]) => Promise<unknown>).call(dns.promises, hostname, options);
  }) as typeof dns.promises.lookup;
}
