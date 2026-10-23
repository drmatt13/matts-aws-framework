import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import type { DomainHealth, DomainIntent, DomainPurpose, VerifiedDomainContext } from "../../shared/domain-operations";
import type { IdentitySelection } from "../../shared/identity";
import { hostnameProblem } from "../../shared/domain-settings";
import { EditError } from "../edits/io";

export interface PublicAddress { readonly address: string; readonly family: number }
/** Conservative global-unicast allowlist. Reserved/documentation/tunnel ranges are refused. */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family === 6 && !address.includes("%")) {
    const lower = address.toLowerCase(); const first = Number.parseInt(lower.split(":")[0] ?? "", 16);
    if (!(first >= 0x2000 && first <= 0x3fff) || first === 0x2002 || (first >= 0x3ff0 && first <= 0x3fff)) return false;
    const second = Number.parseInt(lower.split(":")[1] || "0", 16);
    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
    return true;
  }
  return false;
}
export function publicHostname(hostname: string): boolean {
  return !hostnameProblem(hostname) && !isIP(hostname) && !/(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname);
}
type Probe = { -readonly [Key in "tls" | "http" | "application"]: DomainHealth[Key] };
const unknown = (): Probe => ({ tls: { status: "unverified", detail: "No TLS connection was made." }, http: { status: "unverified", detail: "No HTTP request was made." }, application: { status: "unverified", detail: "No application content was observed. Sign-in and browser runtime are unverified." } });

/** No redirects, proxy env, alternate ports, DNS callback or caller-provided URL. */
export function probePinned(hostname: string, address: PublicAddress): Promise<Probe> {
  if (!publicHostname(hostname) || !publicAddress(address.address)) return Promise.reject(new EditError(422, "Only configured public DNS hostnames and public destination addresses may be probed."));
  return new Promise(resolve => {
    const evidence = unknown(); let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(evidence); };
    const req = request({ hostname: address.address, family: address.family, port: 443, servername: hostname, path: "/", method: "GET", agent: false, rejectUnauthorized: true, checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate), headers: { Host: hostname, "User-Agent": "FrameworkStudio-DomainHealth/1", Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" } }, response => {
      const code = response.statusCode;
      evidence.http = { status: "observed", ...(code ? { code } : {}), cloudFrontHeaders: /cloudfront/i.test(`${String(response.headers.via ?? "")} ${String(response.headers["x-cache"] ?? "")} ${String(response.headers.server ?? "")}`), detail: code && code >= 200 && code < 300 ? "An HTTPS response was observed. This status alone does not prove a working application." : "HTTP routing returned this status; redirects are not followed and sign-in was not tested." };
      if (response.headers.location) { try { evidence.http = { ...evidence.http, redirectOrigin: new URL(response.headers.location, `https://${hostname}`).origin }; } catch { /* Never display arbitrary Location text. */ } }
      const chunks: Buffer[] = []; let bytes = 0; let truncated = false; const limit = 65_536;
      const complete = () => {
        const body = Buffer.concat(chunks).toString("utf8"); const html = /(?:text\/html|application\/xhtml\+xml)/i.test(String(response.headers["content-type"] ?? "")) && /<(?:!doctype\s+html|html|head|body|title)\b/i.test(body);
        const title = html ? /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(body)?.[1]?.replace(/<[^>]*>/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120) : undefined;
        evidence.application = { status: html ? "html-document" : "other-response", ...(title ? { title } : {}), sampledBytes: bytes, sampleTruncated: truncated, detail: html ? "HTML document bytes were observed. JavaScript execution, application APIs and authentication remain unverified." : "Response bytes do not establish an application page or authentication outcome." };
        finish();
      };
      response.on("data", (chunk: Buffer) => { const remaining = limit - bytes; chunks.push(chunk.subarray(0, Math.max(remaining, 0))); bytes += Math.min(chunk.length, Math.max(remaining, 0)); if (chunk.length > remaining) { truncated = true; complete(); req.destroy(); } });
      response.once("end", complete); response.once("error", () => { if (!settled) { evidence.application = { status: "unverified", detail: "Response body ended unexpectedly. HTTP headers were observed, application content was not verified." }; finish(); } });
    });
    req.once("socket", socket => { const tls = socket as TLSSocket; tls.once("secureConnect", () => { const cert = tls.getPeerCertificate(); evidence.tls = { status: "valid", detail: "The public pinned destination completed trusted TLS with hostname validation.", ...(cert.valid_to ? { expires: cert.valid_to } : {}), ...(typeof cert.issuer?.CN === "string" ? { issuer: cert.issuer.CN } : {}), ...(cert.fingerprint256 ? { fingerprint: cert.fingerprint256 } : {}) }; }); });
    req.once("error", error => { if (evidence.tls.status !== "valid") evidence.tls = { status: "failed", detail: `TLS/hostname/certificate connection failed (${String((error as NodeJS.ErrnoException).code ?? "connection error")}).` }; else if (evidence.http.status !== "observed") evidence.http = { status: "failed", detail: "TLS succeeded but no HTTP response completed." }; finish(); });
    timer = setTimeout(() => { if (evidence.tls.status !== "valid") evidence.tls = { status: "failed", detail: "TLS/HTTP probe timed out after 10 seconds." }; else if (evidence.http.status !== "observed") evidence.http = { status: "failed", detail: "HTTP probe timed out after TLS completed." }; finish(); req.destroy(); }, 10_000);
    req.end();
  });
}

export class DomainHealthService {
  constructor(private readonly authority: { verifiedDomainContext(selection: IdentitySelection): Promise<VerifiedDomainContext> }, private readonly lookup: (hostname: string) => Promise<readonly PublicAddress[]> = hostname => dnsLookup(hostname, { all: true, verbatim: true }), private readonly probe: (hostname: string, address: PublicAddress) => Promise<Probe> = probePinned) {}
  async inspect(selection: IdentitySelection, purpose: DomainPurpose): Promise<DomainHealth> {
    const verified = await this.authority.verifiedDomainContext(selection);
    const intent: DomainIntent | undefined = verified.domains.find(domain => domain.purpose === purpose);
    if (!intent) throw new EditError(422, "Enable and save this production domain in the authoritative inputs before health inspection.");
    const base = { context: verified.context, purpose, hostname: intent.hostname, sourceHash: verified.sourceHash, observedAt: new Date().toISOString() };
    if (!publicHostname(intent.hostname)) return { ...base, ...unknown(), dns: { status: "blocked", addresses: [], detail: "Local, private, IP-literal and invalid destination hostnames are refused." } };
    let addresses: readonly PublicAddress[]; let timer: ReturnType<typeof setTimeout> | undefined;
    try { addresses = await Promise.race([this.lookup(intent.hostname), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 5_000); })]); }
    catch { return { ...base, ...unknown(), dns: { status: "failed", addresses: [], detail: "No DNS address answer was observed within the bounded lookup. No TLS/HTTP connection was made." } }; }
    finally { if (timer) clearTimeout(timer); }
    if (!addresses.length || addresses.some(address => !publicAddress(address.address) || ![4, 6].includes(address.family))) return { ...base, ...unknown(), dns: { status: "blocked", addresses: addresses.map(address => address.address), detail: "The DNS answer contains a non-public/reserved destination or no addresses. Mixed public/private answers are refused; no HTTP/TLS connection was made." } };
    const pinned = addresses.find(address => address.family === 4) ?? addresses[0]!;
    const evidence = await this.probe(intent.hostname, pinned);
    return { ...base, ...evidence, dns: { status: "resolved", addresses: addresses.map(address => address.address), pinnedAddress: pinned.address, detail: "The connection used this resolved public address directly with the configured hostname for TLS SNI/verification and Host. DNS is not resolved again during the connection." } };
  }
}
