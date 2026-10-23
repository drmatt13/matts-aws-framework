import type { IdentityContext, IdentitySelection } from "./identity";

export type DomainPurpose = "frontend" | "cognito";
export interface DomainIntent { readonly purpose: DomainPurpose; readonly hostname: string; readonly certificateArn: string }
export interface VerifiedDomainContext { readonly context: IdentityContext; readonly stacks: readonly string[]; readonly sourceHash: string; readonly domains: readonly DomainIntent[] }
export interface DomainHealth {
  readonly context: IdentityContext; readonly purpose: DomainPurpose; readonly hostname: string; readonly sourceHash: string; readonly observedAt: string;
  readonly dns: { readonly status: "resolved" | "failed" | "blocked"; readonly addresses: readonly string[]; readonly pinnedAddress?: string; readonly detail: string };
  readonly tls: { readonly status: "valid" | "failed" | "unverified"; readonly detail: string; readonly expires?: string; readonly issuer?: string; readonly fingerprint?: string };
  readonly http: { readonly status: "observed" | "failed" | "unverified"; readonly code?: number; readonly cloudFrontHeaders?: boolean; readonly redirectOrigin?: string; readonly detail: string };
  readonly application: { readonly status: "html-document" | "other-response" | "unverified"; readonly title?: string; readonly sampledBytes?: number; readonly sampleTruncated?: boolean; readonly detail: string };
}
export interface DnsRecord { readonly Name: string; readonly Type: "CNAME"; readonly TTL: number; readonly ResourceRecords: readonly { readonly Value: string }[] }
export interface DomainDnsDiscovery {
  readonly context: IdentityContext; readonly sourceHash: string; readonly domains: readonly DomainIntent[];
  readonly zones: readonly { readonly id: string; readonly name: string; readonly matching: readonly DomainPurpose[] }[];
}
export interface DomainDnsReview {
  readonly id: string; readonly context: IdentityContext; readonly sourceHash: string; readonly createdAt: string; readonly expiresAt: string;
  readonly purpose: DomainPurpose; readonly zone: { readonly id: string; readonly name: string; readonly nameservers: readonly string[] };
  readonly hostname: string; readonly target: string; readonly current: DnsRecord | null; readonly desired: DnsRecord;
  readonly dependencies: readonly string[]; readonly risks: readonly string[]; readonly confirmation: string;
  readonly changeBatch: { readonly Comment: string; readonly Changes: readonly { readonly Action: "CREATE" | "DELETE"; readonly ResourceRecordSet: DnsRecord }[] };
}
export interface DomainDnsReceipt {
  readonly id: string; readonly context: IdentityContext; readonly hostname: string; readonly zoneId: string; readonly submittedAt: string;
  readonly status: "submitting-unconfirmed" | "accepted-pending" | "insync" | "unconfirmed";
  readonly changeId?: string; readonly message: string;
}
export interface DomainDnsRequest { readonly selection: IdentitySelection; readonly purpose: DomainPurpose; readonly zoneId: string }
