import type { IUserPool } from "aws-cdk-lib/aws-cognito";

/**
 * Reference existing identities without transferring CloudFormation ownership.
 * The client and domain must already exist on the selected pool. No credentials
 * or provider secrets belong in this declaration.
 */
export interface CognitoReference {
  readonly account: string;
  readonly region: string;
  readonly originalDeployment: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly userPoolDomainUrl: string;
  readonly userPoolDomainCloudFrontEndpoint?: string;
}

/** Static validation is offline; availability, ownership and auth settings need live inspection. */
export function validateCognitoReference(reference: CognitoReference, target: { readonly account: string; readonly region: string }): void {
  const required = ["account", "region", "originalDeployment", "userPoolId", "userPoolClientId", "userPoolDomainUrl"] as const;
  const allowed: readonly string[] = [...required, "userPoolDomainCloudFrontEndpoint"];
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(reference, key) || typeof reference[key] !== "string") || (reference.userPoolDomainCloudFrontEndpoint !== undefined && typeof reference.userPoolDomainCloudFrontEndpoint !== "string")) {
    throw new Error("Cognito reference must contain only the required public identity fields and optional observed CloudFront endpoint. Missing fields, credentials, secrets and unknown fields are refused.");
  }
  if (!/^\d{12}$/.test(reference.account) || reference.account !== target.account) {
    throw new Error("Cognito reference account must match the explicit deployment account. Cross-account pool reuse is unsupported.");
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(reference.region) || reference.region !== target.region) {
    throw new Error("Cognito reference region must match the deployment region. Cross-region pool reuse is unsupported.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(reference.originalDeployment)) {
    throw new Error("Cognito reference originalDeployment must identify the verified original framework deployment.");
  }
  const poolPrefix = `${reference.region}_`;
  if (!reference.userPoolId.startsWith(poolPrefix) || !/^[A-Za-z0-9]+$/.test(reference.userPoolId.slice(poolPrefix.length)) || reference.userPoolId.length > 55) {
    throw new Error("Cognito reference userPoolId must be a literal pool ID in the selected region.");
  }
  if (!/^[a-z0-9]{1,128}$/.test(reference.userPoolClientId)) {
    throw new Error("Cognito reference userPoolClientId must identify one existing public app client, without a secret.");
  }
  let domain: URL;
  try { domain = new URL(reference.userPoolDomainUrl); }
  catch { throw new Error("Cognito reference userPoolDomainUrl must be the existing pool's HTTPS domain origin."); }
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.search || domain.hash || domain.port || domain.pathname !== "/" || /^(localhost|.*\.localhost|.*\.local|\[.*\]|[\d.]+)$/.test(domain.hostname) || !domain.hostname.includes(".") || reference.userPoolDomainUrl.endsWith("/")) {
    throw new Error("Cognito reference userPoolDomainUrl must be a public HTTPS domain origin without a path, port, credentials or trailing slash.");
  }
  if (reference.userPoolDomainCloudFrontEndpoint !== undefined && !/^[a-z0-9-]+\.cloudfront\.net$/.test(reference.userPoolDomainCloudFrontEndpoint)) {
    throw new Error("Cognito reference userPoolDomainCloudFrontEndpoint must be the observed CloudFront hostname, without a URL or path.");
  }
}

// Mark only the framework's explicitly selected external references. Native
// applications using their own imported constructs retain their existing API.
const externalPools = new WeakSet<IUserPool>();
export function markExternalCognitoReference(pool: IUserPool): void { externalPools.add(pool); }
export function isExternalCognitoReference(pool: IUserPool): boolean { return externalPools.has(pool); }
