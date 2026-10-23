import type { Mode } from "./model";

export const PUBLIC_IDENTITY_INPUTS = ["RETAIN_STATEFUL_RESOURCES", "USE_COGNITO_CUSTOM_DOMAIN", "COGNITO_DOMAIN_NAME", "COGNITO_DOMAIN_CERTIFICATE_ARN", "USE_FRONTEND_CUSTOM_DOMAIN", "FRONTEND_URL", "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN"] as const;
export const hostnameProblem = (value: string): string | undefined => value.length > 253 || !value.includes(".") || !value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? "Use a lowercase DNS hostname with valid labels, without a scheme, path, port or wildcard." : undefined;
export function certificateProblem(arn: string, account?: string): string | undefined {
  const match = /^arn:aws:acm:([^:]+):(\d{12}):certificate\/([a-f0-9-]+)$/i.exec(arn);
  if (!match) return "Use an ACM certificate ARN in the deployment account.";
  if (match[1] !== "us-east-1") return "Cognito custom domains and CloudFront viewer certificates require ACM in us-east-1.";
  if (account && match[2] !== account) return "The certificate must belong to the selected deployment account.";
  return undefined;
}
export function certificateCovers(hostname: string, names: readonly string[]): boolean {
  return names.some(name => name.toLowerCase() === hostname.toLowerCase() || (name.startsWith("*.") && hostname.split(".").length === name.split(".").length && hostname.toLowerCase().endsWith(name.slice(1).toLowerCase())));
}
/** Validate the resulting authoritative inputs, only when a related key changes. */
export function domainSettingsProblems(mode: Mode, values: Readonly<Record<string, string | undefined>>, changed: readonly string[] = PUBLIC_IDENTITY_INPUTS): string[] {
  const problems: string[] = [];
  const enabled = (name: string) => values[name]?.trim().toLowerCase() !== "false";
  for (const name of ["RETAIN_STATEFUL_RESOURCES", "USE_COGNITO_CUSTOM_DOMAIN", "USE_FRONTEND_CUSTOM_DOMAIN"]) if (changed.includes(name) && values[name]?.trim() && !/^(true|false)$/i.test(values[name]!.trim())) problems.push(`${name}: choose true or false.`);
  if (mode !== "prod") return problems;
  for (const [toggle, name, cert, frontend] of [["USE_COGNITO_CUSTOM_DOMAIN", "COGNITO_DOMAIN_NAME", "COGNITO_DOMAIN_CERTIFICATE_ARN", false], ["USE_FRONTEND_CUSTOM_DOMAIN", "FRONTEND_URL", "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN", true]] as const) {
    if (!changed.some(key => [toggle, name, cert].includes(key as never)) || !enabled(toggle)) continue;
    const value = values[name]?.trim() ?? "";
    const certificate = values[cert]?.trim() ?? "";
    // An enabled toggle with no domain retains the resolver's generated-domain default.
    if (!value && !certificate) continue;
    if (!value) { problems.push(`${name} is required with ${cert}.`); continue; }
    if (frontend) {
      try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || hostnameProblem(url.hostname)) problems.push(`${name}: use an HTTPS origin with a valid DNS hostname, without a path, query, credentials or port.`); }
      catch { problems.push(`${name}: use an absolute HTTPS origin.`); }
    } else { const problem = hostnameProblem(value); if (problem) problems.push(`${name}: ${problem}`); }
    const problem = certificateProblem(certificate); if (problem) problems.push(`${cert}: ${problem}`);
  }
  return problems;
}
