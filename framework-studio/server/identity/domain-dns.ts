import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveNs } from "node:dns/promises";
import type { DomainDnsDiscovery, DomainDnsReceipt, DomainDnsRequest, DomainDnsReview, DomainIntent, DnsRecord, VerifiedDomainContext } from "../../shared/domain-operations";
import type { IdentitySelection } from "../../shared/identity";
import { certificateCovers, certificateProblem } from "../../shared/domain-settings";
import { EditError } from "../edits/io";
import { sha256 } from "../files";
import { runCommand, studioEnvironment, Tools, type Runner } from "../deploy/process";
import { publicHostname } from "./domain-health";

const normalized = (name: string) => name.toLowerCase().replace(/\.$/, "");
const zoneId = (id: string) => id.replace(/^\/hostedzone\//, "");
interface Pending { readonly request: DomainDnsRequest; readonly view: DomainDnsReview; readonly fingerprint: string }
/** Managed DNS is a separate exact production operation; source edits never call it. */
export class DomainDnsService {
  private readonly tools: Tools;
  private readonly plans = new Map<string, Pending>();
  private busy = false;
  constructor(private readonly root: string, private readonly authority: { verifiedDomainContext(selection: IdentitySelection): Promise<VerifiedDomainContext> }, private readonly run: Runner = runCommand, private readonly env = process.env, private readonly nameservers: (name: string) => Promise<string[]> = resolveNs) { this.tools = new Tools(root, env); }
  private async aws(selection: IdentitySelection, service: string, operation: string, args: readonly string[], query?: string, region = selection.region): Promise<any> {
    const environment = { ...studioEnvironment(this.env, { profile: selection.profile }), AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard" };
    const result = await this.run(this.tools.aws([service, operation, ...args, "--profile", selection.profile, "--region", region, "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "10", "--cli-read-timeout", "20", ...(query ? ["--query", query] : [])], environment), { timeoutMs: 35_000 });
    if (result.code !== 0) throw new EditError(422, `AWS ${service} ${operation} did not return confirmed success. Check the selected account/profile and permissions. Raw AWS output is withheld.`);
    try { return JSON.parse(result.stdout); } catch { throw new EditError(502, `AWS ${service} ${operation} returned unreadable evidence.`); }
  }
  async discover(selection: IdentitySelection): Promise<DomainDnsDiscovery> {
    const verified = await this.authority.verifiedDomainContext(selection);
    const zones = await this.aws(selection, "route53", "list-hosted-zones", [], "HostedZones[?Config.PrivateZone==`false`].{id:Id,name:Name}");
    if (!Array.isArray(zones)) throw new EditError(502, "Route53 public hosted-zone evidence was unavailable.");
    return { context: verified.context, sourceHash: verified.sourceHash, domains: verified.domains, zones: zones.filter(zone => typeof zone.id === "string" && /^Z[A-Z0-9]+$/.test(zoneId(zone.id)) && typeof zone.name === "string").map(zone => ({ id: zoneId(zone.id), name: normalized(zone.name), matching: verified.domains.filter(domain => normalized(domain.hostname).endsWith(`.${normalized(zone.name)}`)).map(domain => domain.purpose) })) };
  }
  private async deployedTarget(verified: VerifiedDomainContext, intent: DomainIntent): Promise<{ target: string; fingerprint: unknown; dependencies: string[] }> {
    if (!publicHostname(intent.hostname)) throw new EditError(422, "Managed DNS supports only the configured public hostname.");
    const invalid = certificateProblem(intent.certificateArn, verified.context.account);
    if (invalid) throw new EditError(422, invalid);
    const inventories = await Promise.all(verified.stacks.map(stack => this.aws(verified.context, "cloudformation", "list-stack-resources", ["--stack-name", stack], "StackResourceSummaries[].{type:ResourceType,id:PhysicalResourceId}")));
    const resources = inventories.flat();
    let target: string; let deployment: unknown;
    const dependencies = [`Production inputs hash ${verified.sourceHash}`, ...verified.stacks.map(stack => `Verified owned stack ${stack}`)];
    if (intent.purpose === "cognito") {
      const pools = resources.filter(resource => resource.type === "AWS::Cognito::UserPool" && typeof resource.id === "string");
      if (pools.length !== 1) throw new EditError(422, "Managed Cognito DNS requires exactly one application user pool in the verified stack inventory.");
      const domain = await this.aws(verified.context, "cognito-idp", "describe-user-pool-domain", ["--domain", intent.hostname], "DomainDescription.{domain:Domain,pool:UserPoolId,account:AWSAccountId,status:Status,target:CloudFrontDistribution,certificate:CustomDomainConfig.CertificateArn}");
      if (normalized(domain.domain ?? "") !== intent.hostname || domain.pool !== pools[0].id || domain.account !== verified.context.account || domain.status !== "ACTIVE" || domain.certificate !== intent.certificateArn) throw new EditError(422, "The deployed Cognito custom domain/pool/account/certificate is not ACTIVE and identical to the source intent. Deploy/review the domain first; DNS targets are never guessed.");
      target = domain.target; deployment = domain; dependencies.push(`Active Cognito custom domain for owned pool ${domain.pool}`);
    } else {
      const distributions = resources.filter(resource => resource.type === "AWS::CloudFront::Distribution" && typeof resource.id === "string");
      if (distributions.length !== 1) throw new EditError(422, "Managed frontend DNS requires exactly one owned CloudFront distribution.");
      const distribution = await this.aws(verified.context, "cloudfront", "get-distribution", ["--id", distributions[0].id], "{etag:ETag,arn:Distribution.ARN,status:Distribution.Status,target:Distribution.DomainName,enabled:Distribution.DistributionConfig.Enabled,aliases:Distribution.DistributionConfig.Aliases.Items,certificate:Distribution.DistributionConfig.ViewerCertificate.ACMCertificateArn}");
      if (distribution.arn !== `arn:aws:cloudfront::${verified.context.account}:distribution/${distributions[0].id}` || distribution.status !== "Deployed" || distribution.enabled !== true || !distribution.aliases?.includes(intent.hostname) || distribution.certificate !== intent.certificateArn) throw new EditError(422, "Owned CloudFront domain/certificate settings are not deployed and identical to the source hostname. Review and deploy infrastructure before changing DNS.");
      target = distribution.target; deployment = distribution; dependencies.push(`Deployed CloudFront ${distributions[0].id} with exact configured alternate domain and certificate`);
    }
    if (typeof target !== "string" || !/^d[a-z0-9]+\.cloudfront\.net$/.test(target)) throw new EditError(422, "The verified deployment returned no supported CloudFront DNS target.");
    const certificate = await this.aws(verified.context, "acm", "describe-certificate", ["--certificate-arn", intent.certificateArn], "Certificate.{status:Status,names:SubjectAlternativeNames,expires:NotAfter}", "us-east-1");
    if (certificate.status !== "ISSUED" || !certificateCovers(intent.hostname, certificate.names ?? []) || !Number.isFinite(Date.parse(certificate.expires)) || Date.parse(certificate.expires) <= Date.now()) throw new EditError(422, "The configured certificate must be ISSUED, unexpired and cover this hostname before a managed routing change.");
    dependencies.push(`Issued unexpired certificate ${intent.certificateArn}`);
    return { target, dependencies, fingerprint: { resources, deployment, certificate } };
  }
  private async prepare(input: DomainDnsRequest): Promise<Pending> {
    if (!input || !["frontend", "cognito"].includes(input.purpose) || !/^Z[A-Z0-9]+$/.test(input.zoneId)) throw new EditError(400, "Select the configured domain purpose and an explicit public Route53 hosted zone.");
    const verified = await this.authority.verifiedDomainContext(input.selection);
    const intent = verified.domains.find(domain => domain.purpose === input.purpose);
    if (!intent) throw new EditError(422, "Save this enabled production domain intent before reviewing managed DNS.");
    const deployed = await this.deployedTarget(verified, intent);
    const zone = await this.aws(verified.context, "route53", "get-hosted-zone", ["--id", input.zoneId], "{id:HostedZone.Id,name:HostedZone.Name,private:HostedZone.Config.PrivateZone,nameservers:DelegationSet.NameServers}");
    const zoneName = normalized(zone.name ?? "");
    if (zoneId(zone.id ?? "") !== input.zoneId || zone.private !== false || !zoneName || intent.hostname === zoneName || !intent.hostname.endsWith(`.${zoneName}`)) throw new EditError(422, "Choose a public hosted zone containing this non-apex configured hostname. Apex/alias and cross-zone changes require a separate supported DNS process.");
    const expectedNs = Array.isArray(zone.nameservers) ? zone.nameservers.map((name: string) => normalized(name)).sort() : [];
    let actualNs: string[]; let timer: ReturnType<typeof setTimeout> | undefined;
    try { actualNs = (await Promise.race([this.nameservers(zoneName), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Nameserver lookup timeout")), 5_000); })])).map(normalized).sort(); } catch { throw new EditError(422, "Public nameserver delegation could not be verified. Keep the exact external-DNS instructions; no managed change was prepared."); }
    finally { if (timer) clearTimeout(timer); }
    if (!expectedNs.length || JSON.stringify(expectedNs) !== JSON.stringify(actualNs)) throw new EditError(422, "This hosted zone's nameservers do not match public delegation. Do not change a similarly named undelegated zone.");
    const checkedAncestors: string[] = [];
    let ancestor = intent.hostname.substring(intent.hostname.indexOf(".") + 1);
    while (ancestor !== zoneName && ancestor.endsWith(`.${zoneName}`)) {
      const evidence = await this.aws(verified.context, "route53", "list-resource-record-sets", ["--cli-input-json", JSON.stringify({ HostedZoneId: input.zoneId, StartRecordName: ancestor, StartRecordType: "NS", MaxItems: "1" }), "--no-paginate"]);
      if (!Array.isArray(evidence.ResourceRecordSets)) throw new EditError(422, "Intermediate DNS delegation evidence was unavailable; no managed change was prepared.");
      if (evidence.ResourceRecordSets.some((record: any) => normalized(record.Name ?? "") === ancestor && record.Type === "NS")) throw new EditError(422, `The selected zone delegates ${ancestor} to a child zone. Select the authoritative child zone; a parent-zone CNAME would not control this hostname.`);
      checkedAncestors.push(ancestor); ancestor = ancestor.substring(ancestor.indexOf(".") + 1);
    }
    const page = await this.aws(verified.context, "route53", "list-resource-record-sets", ["--cli-input-json", JSON.stringify({ HostedZoneId: input.zoneId, StartRecordName: intent.hostname, MaxItems: "20" }), "--no-paginate"]);
    if (!Array.isArray(page.ResourceRecordSets) || (page.IsTruncated && normalized(page.NextRecordName ?? "") === intent.hostname)) throw new EditError(422, "The complete current record set could not be bounded. Inspect this hostname in Route53; no change was prepared.");
    const matching = page.ResourceRecordSets.filter((record: any) => normalized(record.Name ?? "") === intent.hostname);
    if (matching.length > 1 || matching.some((record: any) => record.Type !== "CNAME" || Object.keys(record).some(key => !["Name", "Type", "TTL", "ResourceRecords"].includes(key)) || !Number.isInteger(record.TTL) || !Array.isArray(record.ResourceRecords) || record.ResourceRecords.length !== 1 || typeof record.ResourceRecords[0]?.Value !== "string")) throw new EditError(422, "Existing alias, non-CNAME or advanced routing records require manual review. This editor never removes competing records or widens routing policy.");
    const current: DnsRecord | null = matching.length ? { Name: `${intent.hostname}.`, Type: "CNAME", TTL: matching[0].TTL, ResourceRecords: [{ Value: matching[0].ResourceRecords[0].Value }] } : null;
    const desired: DnsRecord = { Name: `${intent.hostname}.`, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: `${deployed.target}.` }] };
    if (current && current.TTL === desired.TTL && normalized(current.ResourceRecords[0]!.Value) === deployed.target) throw new EditError(422, "The managed CNAME already matches the reviewed target and TTL. No DNS change is needed.");
    const id = randomUUID(); const createdAt = new Date().toISOString();
    const view: DomainDnsReview = { id, context: verified.context, sourceHash: verified.sourceHash, createdAt, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), purpose: input.purpose, zone: { id: input.zoneId, name: zoneName, nameservers: expectedNs }, hostname: intent.hostname, target: deployed.target, current, desired,
      confirmation: `Change production DNS ${intent.hostname} in ${input.zoneId} account ${verified.context.account}`,
      dependencies: [...deployed.dependencies, `Public delegation matches hosted zone ${input.zoneId}`, `No intermediate child-zone NS delegation${checkedAncestors.length ? ` at ${checkedAncestors.join(", ")}` : " (direct zone child)"}`],
      risks: ["This changes production DNS routing for this hostname. Cached old answers can persist for the previous TTL; Route53 INSYNC does not prove application health.", "Existing simple CNAME replacement uses an atomic exact DELETE plus CREATE transaction. A concurrent changed record refuses the batch instead of being silently overwritten.", "No certificate, infrastructure, account settings, other records or ACM validation records are changed. Rollback requires a new review of the previous record and cannot erase already cached answers.", "Existing hosted-zone and query charges continue. This operation does not create a hosted zone, distribution or certificate."],
      changeBatch: { Comment: `Framework Studio reviewed production DNS ${id}`, Changes: [...(current ? [{ Action: "DELETE" as const, ResourceRecordSet: current }] : []), { Action: "CREATE", ResourceRecordSet: desired }] } };
    return { request: input, view, fingerprint: sha256(JSON.stringify({ sourceHash: verified.sourceHash, account: verified.context.account, region: verified.context.region, stacks: verified.stacks, deployed: deployed.fingerprint, zone: { id: input.zoneId, name: zoneName, nameservers: expectedNs, checkedAncestors }, current })) };
  }
  async review(input: DomainDnsRequest): Promise<DomainDnsReview> {
    if (this.busy) throw new EditError(409, "Wait for the current DNS operation.");
    const plan = await this.prepare(input); if (this.plans.size >= 20) this.plans.clear(); this.plans.set(plan.view.id, plan); return plan.view;
  }
  private recordPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new EditError(400, "Choose a saved DNS operation ID.");
    let directory = this.root;
    for (const segment of [".cache", "framework-studio", "domain-dns"]) { directory = path.join(directory, segment); try { if (lstatSync(directory).isSymbolicLink()) throw new EditError(422, "DNS operation storage must not traverse symbolic links."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, `${id}.json`);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new EditError(422, "DNS operation receipts must be regular files.");
    return file;
  }
  private save(receipt: DomainDnsReceipt): void { const file = this.recordPath(receipt.id); const temporary = `${file}.${randomUUID()}.tmp`; const fd = openSync(temporary, "wx", 0o600); try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, file); let directory: number | undefined; try { directory = openSync(path.dirname(file), "r"); fsyncSync(directory); } catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EISDIR", "EBADF", "EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } finally { if (directory !== undefined) closeSync(directory); } }
  receipt(id: string): DomainDnsReceipt {
    const file = this.recordPath(id); if (!existsSync(file)) throw new EditError(404, "No saved DNS receipt was found.");
    const result = JSON.parse(readFileSync(file, "utf8")) as DomainDnsReceipt;
    if (result.id !== id || !["submitting-unconfirmed", "accepted-pending", "insync", "unconfirmed"].includes(result.status) || !result.context || typeof result.hostname !== "string") throw new EditError(422, "The saved DNS operation cannot be read safely. Preserve its file and inspect the exact zone before further changes.");
    return result;
  }
  history(): DomainDnsReceipt[] {
    const directory = path.dirname(this.recordPath("00000000-0000-0000-0000-000000000000"));
    return readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => this.receipt(name.slice(0, -5))).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 20);
  }
  async apply(id: string, confirmation: string): Promise<DomainDnsReceipt> {
    if (this.busy) throw new EditError(409, "A managed DNS operation is already in progress.");
    const plan = this.plans.get(id);
    if (!plan || Date.parse(plan.view.expiresAt) <= Date.now()) throw new EditError(409, "This production DNS review expired. Inspect and review again.");
    if (confirmation !== plan.view.confirmation) throw new EditError(400, "Type the exact production hostname, zone and account confirmation from this review.");
    this.busy = true;
    try {
      const current = await this.prepare(plan.request);
      if (current.fingerprint !== plan.fingerprint) throw new EditError(409, "Source inputs, deployment, certificate, zone delegation or current record changed after review. Nothing was submitted; review again.");
      let receipt: DomainDnsReceipt = { id, context: current.view.context, hostname: plan.view.hostname, zoneId: plan.view.zone.id, submittedAt: new Date().toISOString(), status: "submitting-unconfirmed", message: "The exact reviewed production DNS request is being submitted; an interrupted response can leave its outcome unknown. Never retry automatically." };
      this.save(receipt); this.plans.delete(id);
      try {
        const result = await this.aws(plan.request.selection, "route53", "change-resource-record-sets", ["--hosted-zone-id", plan.view.zone.id, "--change-batch", JSON.stringify(plan.view.changeBatch)]);
        if (typeof result.ChangeInfo?.Id !== "string" || !/^\/change\/[A-Z0-9]+$/.test(result.ChangeInfo.Id)) throw new Error("No confirmed change identity");
        receipt = { ...receipt, status: "accepted-pending", changeId: result.ChangeInfo.Id, message: "Route53 accepted this exact DNS change. Authoritative propagation, recursive caches, TLS/HTTP and application behavior need separate observation." }; this.save(receipt); return receipt;
      } catch { receipt = { ...receipt, status: "unconfirmed", message: "The DNS request's outcome is unconfirmed. Inspect the exact hosted zone and Route53 change history before a new review. No automatic retry or rollback ran." }; this.save(receipt); return receipt; }
    } finally { this.busy = false; }
  }
  async observe(id: string): Promise<DomainDnsReceipt> {
    const receipt = this.receipt(id); if (!receipt.changeId) return receipt;
    const verified = await this.authority.verifiedDomainContext(receipt.context);
    if (verified.context.account !== receipt.context.account) throw new EditError(422, "DNS receipt account and current credentials differ.");
    const result = await this.aws(receipt.context, "route53", "get-change", ["--id", receipt.changeId], "ChangeInfo.Status");
    if (result !== "INSYNC") return receipt;
    const updated: DomainDnsReceipt = { ...receipt, status: "insync", message: "Route53 authoritative servers report INSYNC. Recursive DNS caches, served TLS/HTTP/application behavior and sign-in remain separate checks." }; this.save(updated); return updated;
  }
}
