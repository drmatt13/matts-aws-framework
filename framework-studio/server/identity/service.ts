import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import path from "node:path";
import { parseEnv } from "node:util";
import { resolve4 } from "node:dns/promises";
import type { CognitoObservation, DomainsObservation, IdentityContext, IdentityPoolsObservation, IdentitySelection, IdentitySource } from "../../shared/identity";
import type { Mode } from "../../shared/model";
import type { VerifiedCognitoTarget } from "../../shared/identity-operations";
import type { VerifiedDomainContext } from "../../shared/domain-operations";
import { certificateCovers, certificateProblem, domainSettingsProblems, PUBLIC_IDENTITY_INPUTS } from "../../shared/domain-settings";
import { deploymentInputPath, inputText } from "../deployment-inputs";
import { sha256 } from "../files";
import { EditError } from "../edits/io";
import { runCommand, studioEnvironment, Tools, type Runner } from "../deploy/process";
import type { DeployService } from "../deploy/service";
import { validateCognitoReference } from "../../../cdk-app/lib/app/cognito-lifecycle";
import { ExternalCognitoReferenceError } from "./ownership";

/** Explicit reads only. No credential/token or secret-value API exists here. */
export class IdentityService {
  private readonly tools: Tools;
  constructor(readonly root: string, private readonly deploy: Pick<DeployService, "targets" | "observer">, private readonly run: Runner = runCommand, private readonly env = process.env, private readonly lookup: (hostname: string) => Promise<string[]> = resolve4) { this.tools = new Tools(root, env); }
  source(mode: Mode): IdentitySource {
    const text = inputText(this.root, deploymentInputPath(mode));
    const parsed = parseEnv(text ?? "");
    const source = readFileSync(path.join(this.root, "cdk-app/lib/app/cognito-stack.ts"), "utf8");
    const providerFile = path.join(this.root, "framework-config/auth-providers.ts");
    const declaredProviders: { id: string; name: string; type: string; scope: string }[] = [];
    if (existsSync(providerFile)) {
      const parsedProviders = ts.createSourceFile(providerFile, readFileSync(providerFile, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const literal = (name: string) => { const property = node.properties.find(property => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name); return property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined; };
          const id = literal("id"), name = literal("name"), type = literal("type"), scope = literal("scope");
          if (id && name && type && scope) declaredProviders.push({ id, name, type, scope });
        }
        ts.forEachChild(node, visit);
      };
      visit(parsedProviders);
    }
    const identityPool = /new\s+[\w.]*\b(?:CfnIdentityPool|IdentityPool)\s*\(/.test(source);
    return { mode, file: deploymentInputPath(mode), hash: sha256(text ?? ""), exists: text !== undefined,
      inputs: Object.fromEntries(PUBLIC_IDENTITY_INPUTS.filter(name => Object.hasOwn(parsed, name)).map(name => [name, parsed[name]!])),
      google: { clientIdPresent: Boolean(parsed.GOOGLE_CLIENT_ID?.trim()), authoredSecretPresent: Boolean(parsed.GOOGLE_CLIENT_SECRET?.trim()) },
      providers: [...source.matchAll(/new\s+[\w.]*UserPoolIdentityProvider(Google|Facebook|Amazon|Apple|Oidc|Saml)\s*\(/g)].map(match => match[1]!), declaredProviders,
      identityPools: identityPool ? "source-review-required" : "not-declared",
      problems: domainSettingsProblems(mode, parsed),
    };
  }
  private async aws(selection: IdentitySelection, service: string, operation: string, args: readonly string[], query?: string, region = selection.region): Promise<any> {
    const result = await this.run(this.tools.aws([service, operation, ...args, "--profile", selection.profile, "--region", region, "--output", "json", "--no-cli-pager", ...(query ? ["--query", query] : [])], studioEnvironment(this.env, { profile: selection.profile })), { timeoutMs: 30_000 });
    if (result.code !== 0) {
      // Never return raw command output: some AWS errors echo supplied parameters.
      const kind = /AccessDenied|Unauthorized/.test(result.stderr) ? "Access denied" : /ExpiredToken|SSO|credentials/i.test(result.stderr) ? "Credentials unavailable or expired" : "AWS read failed";
      throw new EditError(422, `${kind}: ${service} ${operation}. Check the selected profile, region and read permissions. No changes were made.`);
    }
    try { return JSON.parse(result.stdout); } catch { throw new EditError(502, `Invalid JSON from ${service} ${operation}.`); }
  }
  private async selected(selection: IdentitySelection): Promise<{ context: IdentityContext; stacks: readonly string[]; mode: Mode; actorArn?: string }> {
    if (!/^[\w+=,.@-]{1,128}$/.test(selection.profile) || !/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(selection.deployment) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(selection.region)) throw new EditError(400, "Select a valid profile, deployment and AWS region.");
    const target = this.deploy.targets().find(entry => entry.name === selection.deployment);
    if (!target) throw new EditError(422, "Select a deployment declared by this repository.");
    if (target.region && target.region !== selection.region) throw new EditError(422, "The selected region differs from the deployment target.");
    const observed = await this.deploy.observer.status(selection.profile, selection.deployment, selection.region, true);
    if (!observed.ok) throw new EditError(422, observed.problem.message);
    const status = observed.value;
    if (target.account && target.account !== status.context.account) throw new EditError(422, "The selected credentials do not match the deployment account.");
    const stacks = status.detail?.stacks.filter(stack => stack.identity?.deployment === selection.deployment && stack.identity.mode === target.mode).map(stack => stack.name) ?? [];
    if (!stacks.length) throw new EditError(422, "No verified owned stacks were found for this deployment in the selected account and region. Nothing was inspected by a guessed name.");
    return { context: { ...selection, account: status.context.account, observedAt: new Date().toISOString() }, stacks, mode: target.mode, actorArn: status.context.arn };
  }
  private async resources(selection: IdentitySelection, stacks: readonly string[], type: string): Promise<string[]> {
    const result = await Promise.all(stacks.map(stack => this.aws(selection, "cloudformation", "list-stack-resources", ["--stack-name", stack], `StackResourceSummaries[?ResourceType=='${type}'].PhysicalResourceId`)));
    return result.flat().filter((id): id is string => typeof id === "string");
  }
  /** Read references only from verified destination stack outputs, then verify
   * the original owner's live metadata. A browser-supplied pool ID is never used. */
  private async userPoolDestination(selection: IdentitySelection, context: IdentityContext, stacks: readonly string[], mode: Mode): Promise<{ poolId: string; management: "framework-managed" | "external-reference"; originalDeployment?: string; selectedClientId?: string }> {
    const ids = await this.resources(selection, stacks, "AWS::Cognito::UserPool");
    if (ids.length === 1) return { poolId: ids[0]!, management: "framework-managed" };
    if (ids.length > 1) throw new EditError(422, `Found ${ids.length} owned user pools. This view requires one application user pool; inspect multiple pools individually in AWS.`);
    const outputs = await Promise.all(stacks.map(stack => this.aws(selection, "cloudformation", "describe-stacks", ["--stack-name", stack], "Stacks[0].Outputs[].{key:OutputKey,value:OutputValue}")));
    const references = outputs.map(entries => {
      if (!Array.isArray(entries)) throw new EditError(422, "Cannot read verified stack reference outputs. Refresh deployment inspection before inspecting retained Cognito resources.");
      return Object.fromEntries(entries.filter(entry => typeof entry?.key === "string" && typeof entry?.value === "string").map(entry => [entry.key, entry.value]));
    }).filter(entry => entry.UserPoolManagement === "external-reference");
    if (references.length !== 1) throw new EditError(422, "Cognito inspection requires exactly one owned User Pool or one explicit external reference in verified deployment stack outputs. No pool was selected by a guessed name.");
    const output = references[0]!;
    const reference = { account: context.account, region: selection.region, originalDeployment: output.UserPoolOriginalDeployment ?? "", userPoolId: output.UserPoolId ?? "", userPoolClientId: output.UserPoolClientId ?? "", userPoolDomainUrl: output.UserPoolDomainUrl ?? "" };
    try { validateCognitoReference(reference, context); }
    catch (error) { throw new EditError(422, error instanceof Error ? error.message : "Invalid deployed Cognito reference outputs."); }
    const pool = await this.aws(selection, "cognito-idp", "describe-user-pool", ["--user-pool-id", reference.userPoolId], "UserPool.{id:Id,arn:Arn,tags:UserPoolTags}");
    const arn = typeof pool?.arn === "string" ? pool.arn.split(":") : [];
    if (pool?.id !== reference.userPoolId || arn[2] !== "cognito-idp" || arn[3] !== selection.region || arn[4] !== context.account || arn[5] !== `userpool/${reference.userPoolId}` || pool.tags?.["framework:owner"] !== "matts-aws-framework" || pool.tags?.["framework:deployment"] !== reference.originalDeployment || pool.tags?.["framework:mode"] !== mode) {
      throw new EditError(422, "The referenced pool's live account, region or original framework ownership differs from the deployed reference. Reinspect recovery evidence; no user operation is available.");
    }
    const client = await this.aws(selection, "cognito-idp", "describe-user-pool-client", ["--user-pool-id", reference.userPoolId, "--client-id", reference.userPoolClientId], "UserPoolClient.{id:ClientId,poolId:UserPoolId}");
    if (client?.id !== reference.userPoolClientId || client.poolId !== reference.userPoolId) throw new EditError(422, "The external reference's selected app client is missing or belongs to another pool. Reinspect and review a compatible retained client separately.");
    return { poolId: reference.userPoolId, management: "external-reference", originalDeployment: reference.originalDeployment, selectedClientId: reference.userPoolClientId };
  }
  /** Shared read-only destination proof for separately reviewed user operations.
   * Repeated at apply: the browser cannot select a pool by supplying its ID. */
  async verifiedUserPool(selection: IdentitySelection): Promise<VerifiedCognitoTarget> {
    const { context, stacks, mode, actorArn } = await this.selected(selection);
    const destination = await this.userPoolDestination(selection, context, stacks, mode);
    if (destination.management === "external-reference") throw new ExternalCognitoReferenceError();
    const poolId = destination.poolId;
    const pool = await this.aws(selection, "cognito-idp", "describe-user-pool", ["--user-pool-id", poolId], "UserPool.{id:Id,arn:Arn,created:CreationDate,modified:LastModifiedDate,policies:Policies,schema:SchemaAttributes[].{name:Name,required:Required},triggers:LambdaConfig}");
    if (pool.id !== poolId || pool.arn !== `arn:aws:cognito-idp:${selection.region}:${context.account}:userpool/${poolId}`) throw new EditError(422, "The observed Cognito pool identity does not match the selected account and region. No user operation is available.");
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
    return { ...selection, mode, account: context.account, ...(actorArn ? { actorArn } : {}), poolId, poolArn: pool.arn,
      fingerprint: sha256(JSON.stringify(canonical({ mode, account: context.account, actorArn, stacks: [...stacks].sort(), pool }))),
      requiredAttributes: (pool.schema ?? []).filter((attribute: { required?: boolean }) => attribute.required).map((attribute: { name: string }) => attribute.name).sort(),
      passwordless: (pool.policies?.SignInPolicy?.AllowedFirstAuthFactors ?? []).some((factor: string) => factor === "EMAIL_OTP" || factor === "SMS_OTP"),
      triggers: Object.entries(pool.triggers ?? {}).filter(([, value]) => typeof value === "string").map(([name]) => name).sort() };
  }
  async cognito(selection: IdentitySelection, nextToken?: string, search?: string): Promise<CognitoObservation> {
    if ((nextToken?.length ?? 0) > 4096 || (search?.length ?? 0) > 128 || /[\r\n\0]/.test(search ?? "")) throw new EditError(400, "Use a search of at most 128 characters and a valid paging token.");
    const { context, stacks, mode } = await this.selected(selection);
    const destination = await this.userPoolDestination(selection, context, stacks, mode);
    const poolId = destination.poolId;
    const [pool, clientList, providerList, groups, users] = await Promise.all([
      this.aws(selection, "cognito-idp", "describe-user-pool", ["--user-pool-id", poolId], "UserPool.{name:Name,status:Status,deletionProtection:DeletionProtection,estimatedUsers:EstimatedNumberOfUsers,domain:Domain,customDomain:CustomDomain}"),
      this.aws(selection, "cognito-idp", "list-user-pool-clients", ["--user-pool-id", poolId], "UserPoolClients[].ClientId"),
      this.aws(selection, "cognito-idp", "list-identity-providers", ["--user-pool-id", poolId, "--max-results", "60"], "Providers[].ProviderName"),
      this.aws(selection, "cognito-idp", "list-groups", ["--user-pool-id", poolId], "Groups[].{name:GroupName,precedence:Precedence,roleArn:RoleArn}"),
      this.aws(selection, "cognito-idp", "list-users", ["--user-pool-id", poolId, "--limit", "20", "--no-paginate", ...(nextToken ? ["--pagination-token", nextToken] : []), ...(search ? ["--filter", `username ^= ${JSON.stringify(search)}`] : [])], "{users:Users[].{username:Username,status:UserStatus,enabled:Enabled,createdAt:UserCreateDate},nextToken:PaginationToken}"),
    ]);
    const [clients, providers] = await Promise.all([
      Promise.all(clientList.map((id: string) => this.aws(selection, "cognito-idp", "describe-user-pool-client", ["--user-pool-id", poolId, "--client-id", id], "UserPoolClient.{id:ClientId,name:ClientName,callbacks:CallbackURLs,logout:LogoutURLs,providers:SupportedIdentityProviders}"))),
      Promise.all(providerList.map((name: string) => this.aws(selection, "cognito-idp", "describe-identity-provider", ["--user-pool-id", poolId, "--provider-name", name], "IdentityProvider.{name:ProviderName,type:ProviderType,settings:{client_id:ProviderDetails.client_id,issuer:ProviderDetails.oidc_issuer,scopes:ProviderDetails.authorize_scopes,metadataUrl:ProviderDetails.MetadataURL},mappedAttributes:keys(AttributeMapping)}"))),
    ]);
    return { context, ...destination, pool, clients: clients.map(client => ({ ...client, callbacks: client.callbacks ?? [], logout: client.logout ?? [], providers: client.providers ?? [] })), providers: providers.map(provider => ({ ...provider, settings: Object.fromEntries(Object.entries(provider.settings ?? {}).filter(([, value]) => typeof value === "string")), providerSide: "unverified", signIn: "unverified" })), groups, users: users.users ?? [], ...(users.nextToken ? { nextToken: users.nextToken } : {}), warnings: [...(destination.management === "external-reference" ? ["This deployment references the original pool and selected app client. Their configuration, users, providers, triggers, groups and Identity Pool roles remain externally managed. Studio user/group mutations are unavailable for this reference ownership scope."] : []), "Deployed metadata is an observation, not proof of provider-side credentials or successful sign-in.", "Secret existence/access and external provider application configuration have not been tested. Secret values are never requested."] };
  }
  async identityPools(selection: IdentitySelection): Promise<IdentityPoolsObservation> {
    const { context, stacks } = await this.selected(selection);
    const ids = await this.resources(selection, stacks, "AWS::Cognito::IdentityPool");
    const pools = await Promise.all(ids.map(async id => {
      const [pool, roles] = await Promise.all([
        this.aws(selection, "cognito-identity", "describe-identity-pool", ["--identity-pool-id", id], "{name:IdentityPoolName,guests:AllowUnauthenticatedIdentities,providers:CognitoIdentityProviders[].{name:ProviderName,clientId:ClientId}}"),
        this.aws(selection, "cognito-identity", "get-identity-pool-roles", ["--identity-pool-id", id], "{roles:Roles,mappings:RoleMappings}"),
      ]);
      return { id, ...pool, providers: pool.providers ?? [], roles: roles.roles ?? {}, mappings: roles.mappings ?? {} };
    }));
    return { context, pools, warnings: ["Only identity pools still listed in verified owned stacks are included. An empty result does not rule out retained or external pools.", "Role mapping is configuration evidence. IAM policies, explicit denies, boundaries, SCPs and actual API authorization have not been tested."] };
  }
  async verifiedDomainContext(selection: IdentitySelection): Promise<VerifiedDomainContext> {
    const verified = await this.selected(selection);
    const target = this.deploy.targets().find(entry => entry.name === selection.deployment)!;
    if (target.mode !== "prod") throw new EditError(422, "Domain operations apply only to an explicitly selected production target.");
    if (target.inputs && target.inputs !== deploymentInputPath("prod")) throw new EditError(422, "This target uses a custom inputs path. Domain operations require the authoritative cdk-app/.env.prod input file.");
    const source = this.source("prod");
    if (!source.exists || source.problems.length) throw new EditError(422, source.problems.join(" ") || "Create production inputs before domain operations.");
    const domains: VerifiedDomainContext["domains"][number][] = [];
    const values = source.inputs;
    if (values.USE_COGNITO_CUSTOM_DOMAIN?.toLowerCase() !== "false" && values.COGNITO_DOMAIN_NAME) domains.push({ purpose: "cognito", hostname: values.COGNITO_DOMAIN_NAME, certificateArn: values.COGNITO_DOMAIN_CERTIFICATE_ARN ?? "" });
    if (values.USE_FRONTEND_CUSTOM_DOMAIN?.toLowerCase() !== "false" && values.FRONTEND_URL) domains.push({ purpose: "frontend", hostname: new URL(values.FRONTEND_URL).hostname, certificateArn: values.FRONTEND_CLOUDFRONT_CERTIFICATE_ARN ?? "" });
    return { ...verified, sourceHash: source.hash, domains };
  }
  async domains(selection: IdentitySelection): Promise<DomainsObservation> {
    const { context, stacks } = await this.selected(selection);
    const target = this.deploy.targets().find(entry => entry.name === selection.deployment)!;
    if (target.mode !== "prod") throw new EditError(422, "Custom domain controls and their domain inspection apply to production targets only.");
    if (target.inputs && target.inputs !== deploymentInputPath("prod")) throw new EditError(422, "This target uses a custom inputs path. The domain editor supports cdk-app/.env.prod only; inspect the target's actual inputs in source before domain operations.");
    const source = this.source("prod");
    const values = source.inputs;
    const certificates: DomainsObservation["certificates"][number][] = [];
    const records: DomainsObservation["records"][number][] = [];
    const dns: DomainsObservation["dns"][number][] = [];
    const outputs = (await Promise.all(stacks.map(stack => this.aws(selection, "cloudformation", "describe-stacks", ["--stack-name", stack], "Stacks[0].Outputs[].{key:OutputKey,value:OutputValue}")))).flat();
    for (const [purpose, toggle, domainKey, certKey, outputKey] of [["Cognito", "USE_COGNITO_CUSTOM_DOMAIN", "COGNITO_DOMAIN_NAME", "COGNITO_DOMAIN_CERTIFICATE_ARN", "UserPoolDomainCloudFrontEndpoint"], ["Frontend", "USE_FRONTEND_CUSTOM_DOMAIN", "FRONTEND_URL", "FRONTEND_CLOUDFRONT_CERTIFICATE_ARN", "CloudFrontDomainName"]] as const) {
      if (values[toggle]?.toLowerCase() === "false" || !values[domainKey]) continue;
      let hostname = values[domainKey]!;
      if (purpose === "Frontend") { try { hostname = new URL(hostname).hostname; } catch { continue; } }
      const arn = values[certKey] ?? "";
      const invalid = certificateProblem(arn, context.account);
      if (invalid) certificates.push({ purpose, arn, names: [], problems: [invalid], validation: [] });
      else {
        try {
          const cert = await this.aws(selection, "acm", "describe-certificate", ["--certificate-arn", arn], "Certificate.{status:Status,names:SubjectAlternativeNames,expires:NotAfter,validation:DomainValidationOptions[].{domain:DomainName,status:ValidationStatus,name:ResourceRecord.Name,type:ResourceRecord.Type,value:ResourceRecord.Value}}", "us-east-1");
          const problems = [...(cert.status !== "ISSUED" ? [`Certificate status is ${cert.status ?? "unknown"}; domain deployment requires ISSUED.`] : []), ...(!certificateCovers(hostname, cert.names ?? []) ? [`Certificate names do not cover ${hostname}.`] : []), ...(cert.expires && Date.parse(cert.expires) <= Date.now() ? ["Certificate has expired."] : [])];
          certificates.push({ purpose, arn, ...cert, names: cert.names ?? [], validation: cert.validation ?? [], problems });
        } catch (error) { certificates.push({ purpose, arn, names: [], validation: [], problems: [error instanceof Error ? error.message : "Certificate read unavailable."] }); }
      }
      try { dns.push({ hostname, addresses: await this.lookup(hostname) }); } catch { dns.push({ hostname, addresses: [], problem: "No A-record answer was observed. This is not a complete DNS or website-health check." }); }
      if (purpose === "Cognito") { const parent = hostname.split(".").slice(1).join("."); try { dns.push({ hostname: parent, addresses: await this.lookup(parent) }); } catch { dns.push({ hostname: parent, addresses: [], problem: "Cognito requires an A record for this immediate parent domain." }); } }
      const targetValue = outputs.find((output: any) => output.key === outputKey)?.value;
      records.push({ hostname, ...(targetValue ? { target: targetValue } : {}), instruction: targetValue ? `Create an external DNS alias/ANAME to ${targetValue}, or a CNAME for a non-apex hostname. Keep ACM validation CNAMEs. Review ownership before any DNS write.` : `No deployed ${purpose} DNS target output was observed. Deploy the reviewed domain configuration first; do not guess a CloudFront target.` });
    }
    return { context, certificates, dns, records, health: ["TLS validity at the served hostname", "CloudFront HTTP routing", "Actual application response"].map(check => ({ check, status: "unverified", detail: "No external application request or browser sign-in has been performed by this inspection." })), warnings: ["This reads intended production inputs and deployed outputs independently. It does not establish that deployed domain settings match the inputs.", "Route 53 ownership/records are not inspected. Certificate requests, DNS writes and deployment remain separate authorized actions."] };
  }
}
