/**
 * The network's egress rule, held on a laptop.
 *
 * A Lambda in the VPC (`vpc: true`, or `database: true`) runs in its private
 * subnets in AWS, where the only way out is IPv6 unless the network has a NAT gateway. A host that publishes no IPv6 address
 * is unreachable from there: the connection is not refused, it simply never
 * answers until the function times out. Locally the same call would succeed
 * over the laptop's IPv4, and "works in dev" would stop meaning "works in prod".
 *
 * So the child process that runs such a handler resolves every name through
 * this guard first. A name whose addresses are all private (Compose services,
 * localhost) passes, as it would inside the VPC. A public name passes only if
 * it publishes an IPv6 address — asked of DNS directly, because a laptop with
 * no IPv6 of its own has those records hidden from `getaddrinfo`. Anything else
 * fails at once, with the reason and the fix, instead of hanging.
 */
import dns from "node:dns";
import net from "node:net";

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

/** Why a host is unreachable from the private subnets, or undefined when it is reachable. */
export async function ipv6EgressRefusal(hostname: string, resolver: EgressResolver): Promise<string | undefined> {
  if (net.isIPv6(hostname)) return undefined;
  if (net.isIPv4(hostname)) {
    return isPrivateAddress(hostname)
      ? undefined
      : `${hostname} is an IPv4 address, and only IPv6 leaves the VPC's private subnets.`;
  }
  const addresses = await resolver.lookupAll(hostname);
  if (addresses.length > 0 && addresses.every(isPrivateAddress)) return undefined;
  if (addresses.some((address) => net.isIPv6(address) && !isPrivateAddress(address))) return undefined;
  if (await resolver.hasIpv6(hostname)) return undefined;
  return `${hostname} has no IPv6 address, and only IPv6 leaves the VPC's private subnets.`;
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
 * Holds this process to IPv6-only egress. Installed once, before the handler
 * module is imported, so every client the handler builds goes through it.
 */
export function installIpv6EgressGuard(functionName: string): void {
  if (installed) return;
  installed = true;
  const original = dns.lookup;
  const resolver = systemResolver(original);
  const verdicts = new Map<string, Promise<string | undefined>>();
  const verdict = (hostname: string): Promise<string | undefined> => {
    let pending = verdicts.get(hostname);
    if (!pending) {
      pending = ipv6EgressRefusal(hostname, resolver);
      verdicts.set(hostname, pending);
    }
    return pending;
  };
  const refusal = (hostname: string, reason: string): NodeJS.ErrnoException =>
    Object.assign(
      new Error(
        `${reason} ${functionName} runs in the VPC (vpc: true or database: true), so in AWS it is in the private subnets and cannot reach ${hostname}. Call it from a Lambda outside the VPC, or give the private subnets IPv4 with defineNetwork({ ..., nat: true }) in framework-config/network.ts (about $33 a month).`,
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
