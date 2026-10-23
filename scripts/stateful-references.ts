#!/usr/bin/env node
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runAwsSync, AwsCliError, type AwsTarget } from "./aws-cli";
import { profileRegion } from "./aws-profiles";
import { readRetainedResources } from "./retained-resources";
import type { DatabaseReference, RetainedDatabaseNetwork } from "../cdk-app/lib/app/database-lifecycle";
import type { CognitoReference } from "../cdk-app/lib/app/cognito-lifecycle";
import { readCdkContext, resolveRepositoryTarget } from "@repo/framework/deploy/node";

export type StatefulKind = "database" | "cognito";
export interface StatefulDestination { readonly account: string; readonly region: string; readonly deployment: string; readonly mode: "dev" | "prod" }
export type StatefulAwsReader = (args: readonly string[], aws: AwsTarget) => any;
const root = path.resolve(__dirname, "..");
const sorted = (values: readonly string[]) => [...values].sort();
const tagsOf = (tags: any) => Array.isArray(tags) ? Object.fromEntries(tags.map((tag: any) => [tag.Key, tag.Value])) : tags ?? {};
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
// Ordinary saved-plan recovery must not evaluate application source. These
// dependency-free structural validators load only for explicit references.
const validateCognitoReference = (reference: CognitoReference, destination: StatefulDestination) => (require("../cdk-app/lib/app/cognito-lifecycle") as typeof import("../cdk-app/lib/app/cognito-lifecycle")).validateCognitoReference(reference, destination);
const assertDatabaseReference = (reference: unknown, destination: StatefulDestination) => (require("../cdk-app/lib/app/database-lifecycle") as typeof import("../cdk-app/lib/app/database-lifecycle")).assertDatabaseReference(reference, destination);

/** A name is never ownership proof. Tags must agree with durable physical evidence when present. */
function assertOwner(kind: StatefulKind, physicalId: string, arn: string, tags: Record<string, string>, originalDeployment: string, destination: StatefulDestination, read: StatefulAwsReader, aws: AwsTarget, evidenceRoot: string) {
  requireValue(tags["framework:owner"] === "matts-aws-framework" && tags["framework:deployment"] === originalDeployment, "Resource ownership is unproven or conflicts with the selected original framework deployment. Names alone cannot authorize reuse.");
  requireValue(tags["framework:mode"] === destination.mode, "The retained resource belongs to another environment mode. Select its original mode; cross-environment reuse is unsupported.");
  const ledgers = readRetainedResources(evidenceRoot, destination.account, destination.region, originalDeployment);
  requireValue(ledgers.every(ledger => ledger.mode === destination.mode), "Retained-resource ledger belongs to another environment mode. Resolve the ownership mismatch before reuse.");
  const matches = ledgers.flatMap(ledger => ledger.observations.flatMap(observation => observation.resources.filter(resource => resource.physicalId === physicalId && resource.type === (kind === "database" ? "AWS::RDS::DBInstance" : "AWS::Cognito::UserPool"))));
  let sourceStackId: string | undefined = matches.at(-1)?.stackId;
  let verifiedDeletedStackId: string | undefined;
  // CFN retains deleted-stack lookup for a limited period. Live ownership always refuses.
  try {
    const resources = read(["cloudformation", "describe-stack-resources", "--physical-resource-id", physicalId], aws).StackResources ?? [];
    const ids = [...new Set<string>(resources.filter((entry: any) => entry.PhysicalResourceId === physicalId).map((entry: any) => entry.StackId))];
    requireValue(ids.length <= 1, "Multiple stacks claim the selected physical resource. Resolve ownership before reuse.");
    if (ids[0]) {
      const stack = read(["cloudformation", "describe-stacks", "--stack-name", ids[0]], aws).Stacks?.[0];
      requireValue(stack?.StackStatus === "DELETE_COMPLETE", "The selected resource is still managed by a CloudFormation stack. Reference reuse requires explicit release/retention first; this operation never imports or detaches it.");
      const stackTags = tagsOf(stack.Tags);
      requireValue(stackTags["framework:owner"] === "matts-aws-framework" && stackTags["framework:deployment"] === originalDeployment && stackTags["framework:mode"] === destination.mode, "Original deleted stack ownership conflicts with the retained resource. Resolve the identity mismatch before reuse.");
      if (sourceStackId) requireValue(sourceStackId === ids[0], "Retained-resource ledger and current AWS stack evidence disagree. Reinspect ownership before reuse.");
      sourceStackId = ids[0];
      verifiedDeletedStackId = ids[0];
    }
  } catch (error) {
    if (!(error instanceof AwsCliError && error.kind === "not-found")) throw error;
  }
  requireValue(sourceStackId || (kind === "cognito" && tags["aws:cloudformation:stack-id"]), "No exact retained physical-resource/StackId evidence was found. Preserve or restore the teardown ledger before recovery.");
  sourceStackId ??= tags["aws:cloudformation:stack-id"];
  requireValue(sourceStackId.split(":")[3] === destination.region && sourceStackId.split(":")[4] === destination.account, "Original retained StackId belongs to another account/region.");
  if (!verifiedDeletedStackId) {
    try {
      const original = read(["cloudformation", "describe-stacks", "--stack-name", sourceStackId], aws).Stacks?.[0];
      requireValue(original?.StackStatus === "DELETE_COMPLETE", "Original stack deletion is incomplete or uncertain. Finish and reinspect the authorized teardown before reuse.");
      const originalTags = tagsOf(original.Tags);
      requireValue(originalTags["framework:owner"] === "matts-aws-framework" && originalTags["framework:deployment"] === originalDeployment && originalTags["framework:mode"] === destination.mode, "Original deleted-stack ledger evidence conflicts with AWS ownership. Resolve the mismatch before reuse.");
    } catch (error) {
      if (!(error instanceof AwsCliError && error.kind === "not-found")) throw error;
      requireValue(ledgers.some(ledger => ledger.observations.some(observation => observation.completedStackIds.includes(sourceStackId!))), "Original stack is no longer queryable and the ledger does not prove its deletion completed. Preserve evidence and investigate interrupted teardown before reuse.");
    }
  }
  requireValue(arn.split(":")[3] === destination.region && arn.split(":")[4] === destination.account, "Resource ARN account/region does not match the selected destination.");
  let nextToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = read(["cloudformation", "describe-stacks", "--no-paginate", ...(nextToken ? ["--next-token", nextToken] : [])], aws);
    for (const stack of page.Stacks ?? []) {
      if (stack.StackStatus === "DELETE_COMPLETE") continue;
      const tags = tagsOf(stack.Tags);
      if (tags["framework:owner"] !== "matts-aws-framework") continue;
      const raw = read(["cloudformation", "get-template", "--stack-name", stack.StackId, "--template-stage", "Original"], aws).TemplateBody;
      const metadata = (typeof raw === "string" ? JSON.parse(raw) : raw)?.Metadata?.["framework:stateful-reference"];
      if (metadata?.kind !== kind) continue;
      const selectedId = kind === "database" ? metadata.reference?.instanceIdentifier : metadata.reference?.userPoolId;
      if (selectedId === physicalId) requireValue(tags["framework:deployment"] === destination.deployment && tags["framework:mode"] === destination.mode && ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus), `Retained resource is referenced by deployment ${tags["framework:deployment"] ?? "(unknown)"}, stack ${stack.StackId}, status ${stack.StackStatus}. Its recovery may be incomplete or belong to another deployment. Reinspect that exact stack before reuse.`);
    }
    nextToken = page.NextToken;
    if (nextToken && seen.has(nextToken)) throw new Error("CloudFormation repeated an ownership-inventory token.");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return { sourceStackId: sourceStackId!, ownership: "framework-tags-and-physical-stack-evidence", ledger: matches.length > 0 };
}

export function discoverStatefulReference(kind: StatefulKind, physicalId: string, originalDeployment: string, aws: AwsTarget, destination: StatefulDestination, userPoolClientId?: string, read: StatefulAwsReader = runAwsSync, evidenceRoot = root) {
  requireValue(/^[a-z][a-z0-9-]{0,62}$/.test(originalDeployment), "Select a valid original framework deployment.");
  requireValue(destination.region === aws.region, "AWS inspection region differs from the destination.");
  requireValue(String(read(["sts", "get-caller-identity"], aws).Account) === destination.account, "Selected AWS profile reaches another account. No resource was changed.");
  const warnings: string[] = [];
  const checks = ["account and region match", "explicit physical identity", "original framework ownership", "resource released from CloudFormation"];
  if (kind === "cognito") {
    requireValue(physicalId.startsWith(destination.region + "_") && /^[a-z0-9_-]+$/i.test(physicalId), "Select a literal Cognito pool ID in this region.");
    requireValue(userPoolClientId && /^[a-z0-9]+$/.test(userPoolClientId), "Choose one existing public User Pool app client explicitly. Recovery never creates a duplicate client.");
    const pool = read(["cognito-idp", "describe-user-pool", "--user-pool-id", physicalId], aws).UserPool;
    requireValue(pool?.Id === physicalId && pool.Arn, "The selected User Pool no longer exists.");
    const owner = assertOwner(kind, physicalId, pool.Arn, tagsOf(pool.UserPoolTags), originalDeployment, destination, read, aws, evidenceRoot);
    const client = read(["cognito-idp", "describe-user-pool-client", "--user-pool-id", physicalId, "--client-id", userPoolClientId], aws).UserPoolClient;
    requireValue(client?.ClientId === userPoolClientId && client.UserPoolId === physicalId && !client.ClientSecret, "Selected app client is missing, belongs to another pool, or has a secret. Choose a surviving public browser app client.");
    requireValue(client.AllowedOAuthFlowsUserPoolClient === true && client.AllowedOAuthFlows?.includes("code") && ["openid", "email", "profile"].every(scope => client.AllowedOAuthScopes?.includes(scope)), "Selected client must support the authorization-code flow and openid/email/profile scopes.");
    requireValue(client.ExplicitAuthFlows?.includes("ALLOW_USER_SRP_AUTH") && client.ExplicitAuthFlows?.includes("ALLOW_USER_PASSWORD_AUTH"), "Selected client lacks the framework's SRP/password sign-in flows. Configure it separately before reuse.");
    requireValue(Array.isArray(client.CallbackURLs) && client.CallbackURLs.length && Array.isArray(client.LogoutURLs) && client.LogoutURLs.length, "Selected client has no callback/logout configuration. Configure the exact destination origins separately before deployment.");
    for (const name of client.SupportedIdentityProviders ?? []) if (name !== "COGNITO") {
      const provider = read(["cognito-idp", "describe-identity-provider", "--user-pool-id", physicalId, "--provider-name", name], aws).IdentityProvider;
      requireValue(provider?.ProviderName === name, `Selected client's provider ${name} is unavailable. Restore provider configuration separately.`);
    }
    const domainName = pool.CustomDomain ?? pool.Domain;
    requireValue(typeof domainName === "string" && domainName, "The selected pool has no hosted-login domain. Recreate or attach a domain separately before reference reuse.");
    const domain = read(["cognito-idp", "describe-user-pool-domain", "--domain", domainName], aws).DomainDescription;
    requireValue(domain?.UserPoolId === physicalId && domain.AWSAccountId === destination.account && domain.Status === "ACTIVE", "Pool domain is unavailable, not ACTIVE, or belongs to another pool/account.");
    for (const [trigger, arn] of Object.entries(pool.LambdaConfig ?? {})) {
      requireValue(trigger !== "KMSKeyID", "Custom encrypted Cognito triggers require a separate dependency recovery review; automatic reference is unsupported.");
      if (typeof arn !== "string") { requireValue(trigger === "LambdaVersion" || trigger === "KMSKeyID", "Advanced trigger configuration requires independent recovery; it cannot be safely validated here."); continue; }
      if (!arn.includes(":lambda:")) continue;
      requireValue(arn.split(":")[3] === destination.region && arn.split(":")[4] === destination.account, "Pool trigger uses an unsupported cross-account or cross-region Lambda.");
      const fn = read(["lambda", "get-function-configuration", "--function-name", arn], aws);
      requireValue(fn.State === "Active" && fn.LastUpdateStatus !== "Failed", `Pool trigger ${trigger} is missing or unavailable. Preserve/reconfigure its Lambda separately before reuse.`);
      const policy = JSON.parse(read(["lambda", "get-policy", "--function-name", arn], aws).Policy ?? "{}");
      requireValue((policy.Statement ?? []).some((statement: any) => statement.Effect === "Allow" && statement.Principal?.Service === "cognito-idp.amazonaws.com" && ["lambda:InvokeFunction"].includes(statement.Action) && (statement.Condition?.ArnLike?.["AWS:SourceArn"] ?? statement.Condition?.ArnEquals?.["AWS:SourceArn"]) === pool.Arn), `Pool trigger ${trigger} lacks an exact Cognito invoke permission. Repair it separately before reuse.`);
    }
    const reference: CognitoReference = { account: destination.account, region: destination.region, originalDeployment, userPoolId: physicalId, userPoolClientId, userPoolDomainUrl: `https://${pool.CustomDomain ?? `${domainName}.auth.${destination.region}.amazoncognito.com${destination.region.startsWith("cn-") ? ".cn" : ""}`}`, ...(pool.CustomDomain && domain.CloudFrontDistribution ? { userPoolDomainCloudFrontEndpoint: domain.CloudFrontDistribution } : {}) };
    validateCognitoReference(reference, destination);
    warnings.push("Reference mode preserves this pool and users; it does not manage clients, providers, domains, triggers, groups or Identity Pool roles. Passwords and user records were not read.");
    return { kind, reference, warnings, evidence: { ...owner, checks, observedAt: new Date().toISOString(), callbackUrls: client.CallbackURLs, logoutUrls: client.LogoutURLs, providers: client.SupportedIdentityProviders ?? [], triggers: Object.keys(pool.LambdaConfig ?? {}) } };
  }
  requireValue(destination.mode === "prod", "AWS database references require prod mode; development uses local PostgreSQL.");
  requireValue(/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(physicalId), "Select a literal RDS instance identifier.");
  const db = read(["rds", "describe-db-instances", "--db-instance-identifier", physicalId], aws).DBInstances?.[0];
  requireValue(db?.DBInstanceIdentifier === physicalId && db.DBInstanceArn && db.DBInstanceStatus === "available", "The selected database is missing or unavailable. Reinspect the exact RDS instance.");
  requireValue(db.Engine === "postgres" && !db.DBClusterIdentifier && !db.ReadReplicaSourceDBInstanceIdentifier, "Only a direct PostgreSQL writer instance can be referenced. Clusters and replicas require a separate recovery path.");
  requireValue(db.IAMDatabaseAuthenticationEnabled && db.StorageEncrypted && !db.PubliclyAccessible && (!db.PendingModifiedValues || Object.keys(db.PendingModifiedValues).length === 0), "Retained database must be private, encrypted, IAM-enabled and free of pending modifications before reuse.");
  const tags = tagsOf(read(["rds", "list-tags-for-resource", "--resource-name", db.DBInstanceArn], aws).TagList);
  const owner = assertOwner(kind, physicalId, db.DBInstanceArn, tags, originalDeployment, destination, read, aws, evidenceRoot);
  const subnetGroup = db.DBSubnetGroup;
  requireValue(subnetGroup?.SubnetGroupStatus === "Complete" && subnetGroup.VpcId && subnetGroup.Subnets?.every((subnet: any) => subnet.SubnetStatus === "Active"), "Database subnet group or its original subnets are unavailable. Restore networking independently before reuse.");
  const vpcId = subnetGroup.VpcId;
  const vpc = read(["ec2", "describe-vpcs", "--vpc-ids", vpcId], aws).Vpcs?.[0];
  requireValue(vpc?.State === "available" && vpc.OwnerId === destination.account, "Original database VPC is missing or belongs to another account.");
  for (const attribute of ["enableDnsSupport", "enableDnsHostnames"] as const) {
    const result = read(["ec2", "describe-vpc-attribute", "--vpc-id", vpcId, "--attribute", attribute], aws);
    requireValue(result[attribute[0]!.toUpperCase() + attribute.slice(1)]?.Value === true, `Original VPC ${attribute} is disabled. Restore DNS dependencies separately before reuse.`);
  }
  const subnets = read(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`], aws).Subnets ?? [];
  const routeTables = read(["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${vpcId}`], aws).RouteTables ?? [];
  const tiers = { public: "Public", private: "Private", isolated: "Isolated" } as const;
  const azs = sorted([...new Set<string>(subnets.filter((subnet: any) => tagsOf(subnet.Tags)["aws-cdk:subnet-type"] === "Isolated").map((subnet: any) => subnet.AvailabilityZone))]);
  const network: any = { vpcId, vpcCidrBlock: vpc.CidrBlock, availabilityZones: azs };
  for (const [tier, tag] of Object.entries(tiers)) {
    const selected = azs.map(az => subnets.filter((subnet: any) => subnet.AvailabilityZone === az && tagsOf(subnet.Tags)["aws-cdk:subnet-type"] === tag));
    requireValue(selected.every(matches => matches.length === 1), `Original VPC requires exactly one framework ${tier} subnet per availability zone. Ambiguous/missing subnet inventory refuses recovery.`);
    const ordered = selected.map(matches => matches[0]);
    requireValue(ordered.every(subnet => subnet.State === "available" && subnet.OwnerId === destination.account && subnet.Ipv6CidrBlockAssociationSet?.some((association: any) => association.Ipv6CidrBlockState?.State === "associated")), "Original subnets are unavailable, wrong-owner or missing IPv6; framework workloads require the retained dual-stack network.");
    network[`${tier}SubnetIds`] = ordered.map(subnet => subnet.SubnetId);
    network[`${tier}SubnetRouteTableIds`] = ordered.map(subnet => {
      const tables = routeTables.filter((table: any) => table.Associations?.some((association: any) => association.SubnetId === subnet.SubnetId));
      requireValue(tables.length === 1 && tables[0].Routes?.every((route: any) => route.State !== "blackhole"), `Retained subnet ${subnet.SubnetId} has no unambiguous healthy route table.`);
      return tables[0].RouteTableId;
    });
  }
  requireValue([network.isolatedSubnetIds, network.privateSubnetIds].some(ids => subnetGroup.Subnets.every((subnet: any) => ids.includes(subnet.SubnetIdentifier))), "Database subnet group must be confined to one original framework private/isolated subnet tier.");
  const routes = routeTables.flatMap((table: any) => table.Routes ?? []);
  const natIds = sorted([...new Set<string>(routes.map((route: any) => route.NatGatewayId).filter(Boolean))]);
  if (natIds.length) requireValue((read(["ec2", "describe-nat-gateways", "--nat-gateway-ids", ...natIds], aws).NatGateways ?? []).filter((gateway: any) => gateway.State === "available" && gateway.VpcId === vpcId).length === natIds.length, "Original NAT gateway dependency is missing or unavailable.");
  const egressIds = sorted([...new Set<string>(routes.map((route: any) => route.EgressOnlyInternetGatewayId).filter(Boolean))]);
  if (egressIds.length) requireValue((read(["ec2", "describe-egress-only-internet-gateways", "--egress-only-internet-gateway-ids", ...egressIds], aws).EgressOnlyInternetGateways ?? []).filter((gateway: any) => gateway.Attachments?.some((attachment: any) => attachment.VpcId === vpcId && attachment.State === "attached")).length === egressIds.length, "Original IPv6 egress gateway dependency is missing or unavailable.");
  const gatewayIds = sorted([...new Set<string>(routes.map((route: any) => route.GatewayId).filter((value: any) => typeof value === "string" && value.startsWith("igw-")))]);
  if (gatewayIds.length) requireValue((read(["ec2", "describe-internet-gateways", "--internet-gateway-ids", ...gatewayIds], aws).InternetGateways ?? []).filter((gateway: any) => gateway.Attachments?.some((attachment: any) => attachment.VpcId === vpcId && attachment.State === "available")).length === gatewayIds.length, "Original Internet gateway dependency is missing or unavailable.");
  const endpoints = read(["ec2", "describe-vpc-endpoints", "--filters", `Name=vpc-id,Values=${vpcId}`], aws).VpcEndpoints ?? [];
  requireValue(endpoints.every((endpoint: any) => endpoint.State === "available"), "An original VPC endpoint dependency is unavailable. Restore it separately before reuse.");
  const securityGroupIds = sorted((db.VpcSecurityGroups ?? []).map((group: any) => { requireValue(group.Status === "active", "Database security group attachment is unavailable."); return group.VpcSecurityGroupId; }));
  const groups = read(["ec2", "describe-security-groups", "--group-ids", ...securityGroupIds], aws).SecurityGroups ?? [];
  requireValue(groups.length === securityGroupIds.length && groups.every((group: any) => group.VpcId === vpcId && group.OwnerId === destination.account), "Original database security groups are missing or belong to another VPC/account.");
  const key = read(["kms", "describe-key", "--key-id", db.KmsKeyId], aws).KeyMetadata;
  requireValue(key?.Enabled === true && key.KeyState === "Enabled" && key.AWSAccountId === destination.account, "Database encryption key is unavailable or pending deletion. Resolve KMS dependencies separately.");
  const retainedSecrets = readRetainedResources(evidenceRoot, destination.account, destination.region, originalDeployment).flatMap(ledger => ledger.observations.flatMap(observation => {
    const dependencies = observation.resources.find(resource => resource.physicalId === physicalId && resource.stackId === owner.sourceStackId)?.dependencyPhysicalIds ?? [];
    return observation.resources.filter(resource => resource.stackId === owner.sourceStackId && resource.type === "AWS::SecretsManager::Secret" && ["Retain", "RetainExceptOnCreate"].includes(resource.policy) && resource.physicalId && dependencies.includes(resource.physicalId)).map(resource => resource.physicalId!);
  }));
  const distinctSecrets = [...new Set(retainedSecrets)];
  const masterSecretArn = db.MasterUserSecret?.SecretArn ?? (distinctSecrets.length === 1 ? distinctSecrets[0] : undefined);
  requireValue(masterSecretArn, "RDS does not report a managed master secret. Exact retained Secrets Manager identity is required in the teardown ledger; automatic secret-name guessing is refused.");
  const secret = read(["secretsmanager", "describe-secret", "--secret-id", masterSecretArn], aws);
  requireValue(secret?.ARN === masterSecretArn && !secret.DeletedDate && !secret.DeletionDate, "Original master secret is missing or pending deletion. Its contents were not read.");
  const secretTags = tagsOf(secret.Tags);
  requireValue(secret.ARN.split(":")[3] === destination.region && secret.ARN.split(":")[4] === destination.account && secretTags["framework:owner"] === "matts-aws-framework" && secretTags["framework:deployment"] === originalDeployment && secretTags["framework:mode"] === "prod", "Original master-secret ownership/account/region conflicts with the database. Secret values were not read.");
  const reference: DatabaseReference = { strategy: "reference", account: destination.account, region: destination.region, sourceDeployment: originalDeployment, sourceMode: "prod", sourceStackId: owner.sourceStackId, instanceIdentifier: physicalId, instanceResourceId: db.DbiResourceId, endpoint: db.Endpoint?.Address, port: db.Endpoint?.Port, databaseName: db.DBName, engine: "postgres", engineVersion: db.EngineVersion, iamAuthentication: true, storageEncrypted: true, kmsKeyArn: key.Arn, masterSecretArn, securityGroupIds, iamLogin: "app_user", network: network as RetainedDatabaseNetwork };
  assertDatabaseReference(reference, destination);
  warnings.push("Reference mode leaves database/network ownership external and uses the existing IAM app_user. Connectivity, database role existence and schema compatibility remain unverified until a separately authorized query; no migration, bootstrap or seed was run.", "Retained RDS, NAT gateways and VPC endpoints continue to incur charges.");
  return { kind, reference, warnings, evidence: { ...owner, checks: [...checks, "PostgreSQL IAM/encryption/private writer", "original VPC/subnets/routes/security groups", "KMS and master-secret identities"], observedAt: new Date().toISOString() } };
}

/** Compare exact inspected identities again at source Apply and saved-assembly deployment. */
export function inspectStatefulReference(kind: StatefulKind, reference: DatabaseReference | CognitoReference, aws: AwsTarget, destination: StatefulDestination, read: StatefulAwsReader = runAwsSync, evidenceRoot = root) {
  if (kind === "database") assertDatabaseReference(reference, destination); else validateCognitoReference(reference as CognitoReference, destination);
  const previous = reference as DatabaseReference & CognitoReference;
  const result = discoverStatefulReference(kind, kind === "database" ? previous.instanceIdentifier : previous.userPoolId, kind === "database" ? previous.sourceDeployment : previous.originalDeployment, aws, destination, kind === "cognito" ? previous.userPoolClientId : undefined, read, evidenceRoot);
  requireValue(isDeepStrictEqual(result.reference, reference), "Retained resource identity/dependencies changed since inspection. Reinspect and review the source reference again; nothing was deployed.");
  return result;
}

export function validateAssemblyStatefulReferences(stacks: readonly { template: any }[], aws: AwsTarget, destination: StatefulDestination, read: StatefulAwsReader = runAwsSync) {
  let exports: Map<string, any> | undefined;
  const ownedExports = new Map<string, string>();
  const resolveSetting = (value: any): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value?.["Fn::Join"]) && typeof value["Fn::Join"][0] === "string" && Array.isArray(value["Fn::Join"][1])) return value["Fn::Join"][1].map(resolveSetting).join(value["Fn::Join"][0]);
    if (value?.Ref === "AWS::Region") return destination.region;
    if (value?.Ref === "AWS::AccountId") return destination.account;
    if (value?.["Fn::ImportValue"] !== undefined) {
      const name = resolveSetting(value["Fn::ImportValue"]);
      if (ownedExports.has(name)) return ownedExports.get(name)!;
      if (!exports) {
        exports = new Map();
        let nextToken: string | undefined;
        const seen = new Set<string>();
        do {
          const page = read(["cloudformation", "list-exports", "--no-paginate", ...(nextToken ? ["--next-token", nextToken] : [])], aws);
          for (const entry of page.Exports ?? []) exports.set(entry.Name, entry);
          nextToken = page.NextToken;
          if (nextToken && seen.has(nextToken)) throw new Error("CloudFormation repeated a reference-prerequisite export token.");
          if (nextToken) seen.add(nextToken);
        } while (nextToken);
      }
      const exported = exports.get(name);
      requireValue(exported?.ExportingStackId && typeof exported.Value === "string", `Referenced Cognito callback prerequisite export ${name} is unavailable. Deploy its supporting website stack first, configure the external client's exact callback/logout URLs separately, then review recovery again.`);
      const stack = read(["cloudformation", "describe-stacks", "--stack-name", exported.ExportingStackId], aws).Stacks?.[0];
      const tags = tagsOf(stack?.Tags);
      requireValue(stack?.StackId === exported.ExportingStackId && ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus) && tags["framework:owner"] === "matts-aws-framework" && tags["framework:deployment"] === destination.deployment && tags["framework:mode"] === destination.mode && stack.StackId.split(":")[3] === destination.region && stack.StackId.split(":")[4] === destination.account, `Cognito callback export ${name} does not come from a stable owned stack in destination ${destination.deployment}. Reinspect its exact stack before recovery.`);
      ownedExports.set(name, exported.Value);
      return exported.Value;
    }
    const substitution = value?.["Fn::Sub"];
    if (typeof substitution === "string" || (Array.isArray(substitution) && typeof substitution[0] === "string")) {
      const template = typeof substitution === "string" ? substitution : substitution[0];
      const bindings = typeof substitution === "string" ? {} : substitution[1] ?? {};
      return template.replace(/\$\{([^}]+)\}/g, (_whole: string, name: string) => {
        requireValue(Object.prototype.hasOwnProperty.call(bindings, name) || name === "AWS::Region" || name === "AWS::AccountId", `Cognito callback prerequisite ${name} is unresolved. Deploy supporting infrastructure and review again.`);
        return resolveSetting(Object.prototype.hasOwnProperty.call(bindings, name) ? bindings[name] : { Ref: name });
      });
    }
    throw new Error("Cognito callback prerequisite cannot be resolved safely from this saved template. Deploy supporting infrastructure and use explicit reviewed callback origins before recovery.");
  };
  for (const stack of stacks) {
    const metadata = stack.template.Metadata?.["framework:stateful-reference"];
    if (!metadata) continue;
    requireValue(metadata.kind === "database" || metadata.kind === "cognito", "Unknown stateful reference metadata in assembly.");
    const inspection = inspectStatefulReference(metadata.kind, metadata.reference, aws, destination, read);
    if (metadata.kind === "cognito") {
      const evidence = inspection.evidence as { callbackUrls?: string[]; logoutUrls?: string[]; providers?: string[] };
      for (const key of ["callbackUrls", "logoutUrls", "providers"] as const) requireValue(Array.isArray(metadata[key]) && metadata[key].every((value: unknown) => evidence[key]?.includes(resolveSetting(value))), `Referenced Cognito client does not include the deployment's intended ${key}. Configure the external client separately and review again.`);
    } else {
      assertReferencedNetworkPolicy(metadata.reference, metadata.networkPolicy, aws, read);
    }
  }
}

/** Imported networking stays externally managed. Refuse a declaration that
 * promises routes/endpoints the retained network no longer provides. */
export function assertReferencedNetworkPolicy(reference: DatabaseReference, policy: any, aws: AwsTarget, read: StatefulAwsReader = runAwsSync): void {
  requireValue(policy && typeof policy.natGateway === "boolean" && typeof policy.egressOnlyInternetGateway === "boolean" && policy.gatewayEndpoints && Array.isArray(policy.interfaceEndpoints), "Saved database reference lacks its declared network policy. Resynthesize and review recovery again.");
  const tables = read(["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${reference.network.vpcId}`], aws).RouteTables ?? [];
  for (const [tier, ids] of [["public", reference.network.publicSubnetRouteTableIds], ["private", reference.network.privateSubnetRouteTableIds], ["isolated", reference.network.isolatedSubnetRouteTableIds]] as const) for (const id of ids) {
    const routes = tables.find((table: any) => table.RouteTableId === id)?.Routes;
    requireValue(Array.isArray(routes), `Retained ${tier} route table ${id} is missing.`);
    const ipv4 = routes.find((route: any) => route.DestinationCidrBlock === "0.0.0.0/0" && route.State === "active");
    const ipv6 = routes.find((route: any) => route.DestinationIpv6CidrBlock === "::/0" && route.State === "active");
    if (tier === "public") requireValue(ipv4?.GatewayId?.startsWith("igw-") && ipv6?.GatewayId?.startsWith("igw-"), `Retained public route table ${id} lacks its required IPv4/IPv6 Internet gateway route.`);
    if (tier === "private") {
      requireValue(policy.natGateway ? ipv4?.NatGatewayId : !ipv4, `Retained private route table ${id} disagrees with the declared NAT gateway setting. Restore external networking or correct the reviewed declaration.`);
      requireValue(policy.egressOnlyInternetGateway ? ipv6?.EgressOnlyInternetGatewayId : !ipv6, `Retained private route table ${id} disagrees with the declared IPv6 egress gateway setting. Restore external networking or correct the reviewed declaration.`);
    }
    if (tier === "isolated") requireValue(!ipv4 && !ipv6, `Retained isolated route table ${id} has an unexpected Internet default route.`);
  }
  const endpoints = read(["ec2", "describe-vpc-endpoints", "--filters", `Name=vpc-id,Values=${reference.network.vpcId}`], aws).VpcEndpoints ?? [];
  const allTables = [...reference.network.publicSubnetRouteTableIds, ...reference.network.privateSubnetRouteTableIds, ...reference.network.isolatedSubnetRouteTableIds];
  for (const service of ["s3", "dynamodb"]) {
    const found = endpoints.filter((endpoint: any) => endpoint.VpcEndpointType === "Gateway" && endpoint.ServiceName?.endsWith("." + service));
    requireValue(policy.gatewayEndpoints[service] ? found.length === 1 && found[0].State === "available" && allTables.every(id => found[0].RouteTableIds?.includes(id)) : found.length === 0, `Retained ${service} gateway endpoint disagrees with the declared network or is missing route-table associations.`);
  }
  const actualInterfaces = endpoints.filter((endpoint: any) => endpoint.VpcEndpointType === "Interface");
  requireValue(actualInterfaces.length === policy.interfaceEndpoints.length && policy.interfaceEndpoints.every((service: string) => actualInterfaces.some((endpoint: any) => endpoint.ServiceName?.endsWith("." + service) && endpoint.State === "available" && endpoint.PrivateDnsEnabled && reference.network.privateSubnetIds.every(id => endpoint.SubnetIds?.includes(id)))), "Retained interface endpoints do not match the declared services/private subnets/DNS. Restore external networking or correct the declaration.");
}

/** A reference update must never covertly remove a different managed pool/DB,
 * or turn a reference shell into an empty replacement with new identities. */
export function assertStatefulOwnershipTransitions(previous: any, next: any): void {
  const before = previous?.Metadata?.["framework:stateful-reference"];
  const after = next?.Metadata?.["framework:stateful-reference"];
  for (const [kind, type] of [["cognito", "AWS::Cognito::UserPool"], ["database", "AWS::RDS::DBInstance"]] as const) {
    const hadManaged = Object.values<any>(previous?.Resources ?? {}).some(resource => resource.Type === type);
    const hasManaged = Object.values<any>(next?.Resources ?? {}).some(resource => resource.Type === type);
    requireValue(!(hadManaged && after?.kind === kind), `Changing a managed ${kind} stack to an external reference would remove its current managed resource. Release/retain it through a separately reviewed lifecycle operation before creating a fresh reference deployment.`);
    requireValue(!(before?.kind === kind && hasManaged), `Removing the ${kind} reference would create a new empty resource with new identities. Use a separately reviewed new-resource/replacement operation; reference recovery cannot do this silently.`);
    if (before?.kind === kind && after?.kind === kind) requireValue(isDeepStrictEqual(before.reference, after.reference), `Changing the ${kind} reference physical identity requires a separate reviewed replacement operation. This recovery path preserves the selected identity.`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flag = (key: string) => { const at = args.indexOf(`--${key}`); return at < 0 ? undefined : args[at + 1]; };
  const profile = flag("profile") ?? process.env.AWS_PROFILE;
  const region = flag("region") ?? profileRegion(profile);
  requireValue(region, "Select an AWS region.");
  const aws = { profile, region };
  const account = String(runAwsSync(["sts", "get-caller-identity"], aws).Account);
  const mode = flag("mode");
  requireValue(mode === "dev" || mode === "prod", "Select dev or prod explicitly.");
  const deployment = flag("deployment");
  requireValue(deployment && /^[a-z][a-z0-9-]{0,62}$/.test(deployment), "Select the destination deployment explicitly.");
  const context = readCdkContext(root);
  const target = resolveRepositoryTarget({ root, get: key => key === "prodDeployment" ? String(mode === "prod") : key === "deployment" ? deployment : context[key], env: process.env, requireInputs: false });
  requireValue(target.target.name === deployment && target.mode === mode && (!target.target.account || target.target.account === account) && (!target.target.region || target.target.region === region), "Selected deployment target/account/region differs from the AWS inspection destination. Choose the target's pinned account and region.");
  let result: unknown;
  if (command === "list") result = { account, region, ledgers: readRetainedResources(root, account, region), observedAt: new Date().toISOString(), note: "Teardown evidence is local and durable; availability/ownership require explicit live inspection. Copy .framework/retained-resources when moving checkouts." };
  else {
    const kind = flag("kind");
    requireValue(command === "inspect" && (kind === "database" || kind === "cognito"), "Use list or inspect --kind database|cognito.");
    const id = flag("id") ?? flag("physical-id");
    const originalDeployment = flag("original-deployment");
    requireValue(id && originalDeployment, "Inspect requires --id and --original-deployment.");
    result = discoverStatefulReference(kind, id, originalDeployment, aws, { account, region, deployment, mode }, flag("client-id"));
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (require.main === module) main().catch(error => { process.stdout.write(JSON.stringify({ error: { kind: error instanceof AwsCliError ? error.kind : "failed", message: error instanceof Error ? error.message : "Stateful resource inspection failed." } }) + "\n"); process.exitCode = 1; });
