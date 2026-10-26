import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DomainHealthService, publicAddress, publicHostname } from "../server/identity/domain-health";
import { DomainDnsService } from "../server/identity/domain-dns";
import { readDomainDnsRequest } from "../server/identity/domain-routes";
import type { VerifiedDomainContext } from "../shared/domain-operations";
import type { CommandSpec, Runner } from "../server/deploy/process";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/domain-operation-tests"); mkdirSync(cache, { recursive: true });
const selection = { profile: "dev", deployment: "campaign-prod", region: "us-east-1" };
const certificateArn = "arn:aws:acm:us-east-1:111122223333:certificate/abcd";
const verified: VerifiedDomainContext = { context: { ...selection, account: "111122223333", observedAt: "2026-10-23T08:00:00Z" }, stacks: ["campaign-prod-Website"], sourceHash: "source-1", domains: [{ purpose: "frontend", hostname: "app.example.com", certificateArn }] };
const authority = { verifiedDomainContext: async () => structuredClone(verified) };

test("health refuses private/reserved/IP-literal/internal destinations including IPv6 and IPv4-mapped forms", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.1.1", "203.0.113.1", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fe80::1", "fc00::1", "2001:db8::1", "2002:0a00:0001::1"]) assert.equal(publicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "54.1.2.3", "2001:4860:4860::8888", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
  for (const hostname of ["127.0.0.1", "localhost", "host.localhost", "metadata.google.internal", "host.local", "[::1]"]) assert.equal(publicHostname(hostname), false, hostname);
  assert.equal(publicHostname("app.example.com"), true);
});
test("mixed DNS answers block all outbound probes; a public-only answer is resolved once and pinned", async () => {
  let calls = 0;
  const mixed = new DomainHealthService(authority, async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], async () => { calls++; throw new Error("must not dial"); });
  const blocked = await mixed.inspect(selection, "frontend"); assert.equal(blocked.dns.status, "blocked"); assert.equal(calls, 0); assert.equal(blocked.http.status, "unverified");
  let lookups = 0;
  const safe = new DomainHealthService(authority, async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; }, async (hostname, address) => { calls++; assert.equal(hostname, "app.example.com"); assert.deepEqual(address, { address: "8.8.8.8", family: 4 }); return { tls: { status: "valid", detail: "fixture verified certificate" }, http: { status: "observed", code: 503, cloudFrontHeaders: true, detail: "fixture response" }, application: { status: "other-response", detail: "Sign-in unverified" } }; });
  const observed = await safe.inspect(selection, "frontend"); assert.equal(observed.dns.pinnedAddress, "8.8.8.8"); assert.equal(observed.tls.status, "valid"); assert.equal(observed.http.code, 503); assert.equal(observed.application.status, "other-response"); assert.equal(lookups, 1); assert.equal(calls, 1);
});
test("health derives only a configured source purpose and leaves DNS failures separate from TLS/HTTP", async () => {
  const service = new DomainHealthService(authority, async () => { throw new Error("DNS missing"); });
  await assert.rejects(service.inspect(selection, "cognito"), /Enable and save/);
  const result = await service.inspect(selection, "frontend"); assert.equal(result.dns.status, "failed"); assert.equal(result.tls.status, "unverified"); assert.equal(result.http.status, "unverified");
});

function fixture() {
  const root = mkdtempSync(path.join(cache, "case-")); const calls: CommandSpec[] = [];
  let source = structuredClone(verified); let current: any = { Name: "app.example.com.", Type: "CNAME", TTL: 600, ResourceRecords: [{ Value: "old.cloudfront.net." }] }; let failMutation = false; let alias = "app.example.com"; let ns = ["ns1.example.net", "ns2.example.net"]; let delegated = false;
  const run: Runner = async spec => {
    calls.push(spec); const operation = spec.args[1]; let value: unknown;
    switch (operation) {
      case "list-hosted-zones": value = [{ id: "/hostedzone/ZOWNED123", name: "example.com." }]; break;
      case "list-stack-resources": value = [{ type: "AWS::CloudFront::Distribution", id: "EOWNED123" }]; break;
      case "get-distribution": value = { arn: "arn:aws:cloudfront::111122223333:distribution/EOWNED123", status: "Deployed", target: "downed123.cloudfront.net", enabled: true, aliases: [alias], certificate: certificateArn, etag: "etag1" }; break;
      case "describe-certificate": value = { status: "ISSUED", names: ["*.example.com", "*.sub.example.com", "example.com"], expires: "2030-01-01T00:00:00Z" }; break;
      case "get-hosted-zone": value = { id: "/hostedzone/ZOWNED123", name: "example.com.", private: false, nameservers: ["ns1.example.net.", "ns2.example.net."] }; break;
      case "list-resource-record-sets": { const input = JSON.parse(spec.args[spec.args.indexOf("--cli-input-json") + 1]!); value = { ResourceRecordSets: input.StartRecordType === "NS" ? (delegated ? [{ Name: "sub.example.com.", Type: "NS", TTL: 300, ResourceRecords: [{ Value: "ns.child.example.net." }] }] : []) : current ? [current] : [] }; break; }
      case "change-resource-record-sets": if (failMutation) throw new Error("transport uncertain secret-sentinel"); value = { ChangeInfo: { Id: "/change/COWNED123", Status: "PENDING" } }; break;
      case "get-change": value = "INSYNC"; break;
      default: throw new Error(`Unexpected operation ${operation}`);
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  const service = new DomainDnsService(root, { verifiedDomainContext: async () => structuredClone(source) }, run, {}, async () => ns);
  return { root, calls, service, request: { selection, purpose: "frontend" as const, zoneId: "ZOWNED123" }, source: (value: VerifiedDomainContext) => { source = value; }, current: (value: unknown) => { current = value; }, fail: () => { failMutation = true; }, alias: (value: string) => { alias = value; }, ns: (value: string[]) => { ns = value; }, delegate: () => { delegated = true; }, cleanup: () => { assert.ok(path.resolve(root).startsWith(cache + path.sep)); rmSync(root, { recursive: true }); } };
}
test("managed DNS review derives exact owned/deployed target, zone/account/current/desired records without writes", async () => {
  const f = fixture(); try {
    const discovery = await f.service.discover(selection); assert.deepEqual(discovery.zones[0]?.matching, ["frontend"]);
    const plan = await f.service.review(f.request); assert.equal(plan.hostname, "app.example.com"); assert.equal(plan.context.account, "111122223333"); assert.equal(plan.desired.ResourceRecords[0]?.Value, "downed123.cloudfront.net."); assert.deepEqual(plan.changeBatch.Changes.map(change => change.Action), ["DELETE", "CREATE"]); assert.equal(plan.current?.TTL, 600);
    assert.ok(f.calls.every(call => call.args[1] !== "change-resource-record-sets"));
    await assert.rejects(f.service.apply(plan.id, "yes"), /exact production/); assert.ok(f.calls.every(call => call.args[1] !== "change-resource-record-sets"));
    const result = await f.service.apply(plan.id, plan.confirmation); assert.equal(result.status, "accepted-pending"); assert.equal(result.changeId, "/change/COWNED123");
    const mutation = f.calls.find(call => call.args[1] === "change-resource-record-sets")!;
    assert.equal(mutation.env?.AWS_MAX_ATTEMPTS, "1", "the AWS CLI cannot retry an unconfirmed mutation");
    const batch = JSON.parse(mutation.args[mutation.args.indexOf("--change-batch") + 1]!); assert.deepEqual(batch.Changes[0].ResourceRecordSet, plan.current); assert.deepEqual(batch.Changes[1].ResourceRecordSet, plan.desired);
    assert.equal((await f.service.observe(plan.id)).status, "insync"); await assert.rejects(f.service.apply(plan.id, plan.confirmation), /expired/);
    assert.match(readFileSync(path.join(f.root, ".cache/framework-studio/domain-dns", `${plan.id}.json`), "utf8"), /insync/);
  } finally { f.cleanup(); }
});

test("a publicly delegated parent zone cannot change routing beneath an intervening child delegation", async () => {
  const f = fixture(); try {
    f.source({ ...structuredClone(verified), domains: [{ ...verified.domains[0]!, hostname: "auth.sub.example.com" }] }); f.alias("auth.sub.example.com"); f.current(null);
    const reviewed = await f.service.review(f.request); assert.ok(reviewed.dependencies.some(item => item.includes("sub.example.com")));
    f.delegate(); await assert.rejects(f.service.apply(reviewed.id, reviewed.confirmation), /delegates sub.example.com to a child zone/);
    assert.ok(f.calls.every(call => call.args[1] !== "change-resource-record-sets"));
    await assert.rejects(f.service.review(f.request), /authoritative child zone/);
  } finally { f.cleanup(); }
});
test("source/record changes, undelegated zone and stale distribution alias block before DNS mutation", async () => {
  const f = fixture(); try {
    const plan = await f.service.review(f.request); f.source({ ...verified, sourceHash: "new-source" });
    await assert.rejects(f.service.apply(plan.id, plan.confirmation), /changed after review/);
    f.source(verified); f.current({ Name: "app.example.com.", Type: "CNAME", TTL: 900, ResourceRecords: [{ Value: "concurrent.example.net." }] });
    await assert.rejects(f.service.apply(plan.id, plan.confirmation), /changed after review/);
    f.ns(["ns-other.example.net"]); await assert.rejects(f.service.review(f.request), /do not match public delegation/);
    f.ns(["ns1.example.net", "ns2.example.net"]); f.alias("unrelated.example.com"); await assert.rejects(f.service.review(f.request), /not deployed and identical/);
    assert.ok(f.calls.every(call => call.args[1] !== "change-resource-record-sets"));
  } finally { f.cleanup(); }
});
test("uncertain DNS submission records unconfirmed durable outcome, consumes review and never automatically retries", async () => {
  const f = fixture(); try {
    const plan = await f.service.review(f.request); f.fail(); const result = await f.service.apply(plan.id, plan.confirmation);
    assert.equal(result.status, "unconfirmed"); assert.doesNotMatch(JSON.stringify(result), /sentinel/);
    assert.equal(f.service.receipt(plan.id).status, "unconfirmed"); await assert.rejects(f.service.apply(plan.id, plan.confirmation), /expired/);
    assert.equal(f.calls.filter(call => call.args[1] === "change-resource-record-sets").length, 1);
  } finally { f.cleanup(); }
});
test("managed DNS refuses advanced/non-CNAME routing, apex records and caller-supplied DNS payloads", async () => {
  const f = fixture(); try {
    f.current({ Name: "app.example.com.", Type: "A", AliasTarget: { DNSName: "existing.cloudfront.net" } }); await assert.rejects(f.service.review(f.request), /advanced routing/);
    f.source({ ...verified, domains: [{ ...verified.domains[0]!, hostname: "example.com" }] }); f.alias("example.com"); await assert.rejects(f.service.review(f.request), /non-apex/);
    assert.throws(() => readDomainDnsRequest({ ...f.request, changeBatch: { Changes: [] } }), /derived on the server/);
    assert.throws(() => readDomainDnsRequest({ zoneId: "ZOWNED123", purpose: "frontend" }), /explicit profile/);
    assert.ok(f.calls.every(call => call.args[1] !== "change-resource-record-sets"));
  } finally { f.cleanup(); }
});
