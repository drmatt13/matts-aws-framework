import { CfnIdentityPool, CfnIdentityPoolRoleAttachment, CfnUserPoolGroup, type IUserPool, type IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Effect, FederatedPrincipal, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { identityPolicyStatements, type IdentityPolicyStatement } from "./identity-policy";
import { isExternalCognitoReference } from "./cognito-lifecycle";

/** Native application CDK, shared by Studio's reviewed stack template and code-only use. */
export interface IdentityPoolAccessProps {
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
  readonly groupName: string;
  /** Optional explicit bucket; no AWS permissions are granted by default. */
  readonly readBucketArn?: string;
  readonly readPrefix?: string;
  /** Reviewed literal ReaderRole policy. Replaces the convenience bucket fields, never the default role/trust. */
  readonly readerPolicyStatements?: readonly IdentityPolicyStatement[];
  /** Explicit opt-in only. Guest identities receive a separate permissionless role. */
  readonly allowUnauthenticated?: boolean;
}
export function identityPoolAccess(scope: Construct, props: IdentityPoolAccessProps) {
  if (isExternalCognitoReference(props.userPool)) throw new Error("Identity-pool source cannot create or replace groups and role mappings on an externally referenced User Pool. Preserve and inspect its existing identity-pool roles, or separately review explicit group/role reconciliation before deployment.");
  if (props.readerPolicyStatements !== undefined && (props.readBucketArn !== undefined || props.readPrefix !== undefined)) throw new Error("Choose readerPolicyStatements or the convenience read bucket/prefix, never both policy authorities.");
  const statements = props.readerPolicyStatements === undefined ? undefined : identityPolicyStatements(props.readerPolicyStatements);
  if (props.readBucketArn && !/^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(props.readBucketArn)) throw new Error("Identity-pool read access requires one explicit S3 bucket ARN, without wildcards or object paths.");
  if (props.readPrefix && (!props.readBucketArn || /[*?\x00-\x1f\x7f]/.test(props.readPrefix) || props.readPrefix.startsWith("/"))) throw new Error("An object prefix needs an explicit bucket and cannot contain wildcards, control characters or start with a slash.");
  const identityPool = new CfnIdentityPool(scope, "IdentityPool", {
    allowUnauthenticatedIdentities: props.allowUnauthenticated === true,
    allowClassicFlow: false,
    cognitoIdentityProviders: [{ clientId: props.userPoolClient.userPoolClientId, providerName: props.userPool.userPoolProviderName, serverSideTokenCheck: true }],
  });
  const principal = (amr: "authenticated" | "unauthenticated" = "authenticated") => new FederatedPrincipal("cognito-identity.amazonaws.com", {
      StringEquals: { "cognito-identity.amazonaws.com:aud": identityPool.ref },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": amr },
    }, "sts:AssumeRoleWithWebIdentity");
  const authenticatedRole = new Role(scope, "AuthenticatedRole", {
    assumedBy: principal(),
    description: "Default authenticated identity-pool role; no AWS API permissions.",
  });
  const readerRole = new Role(scope, "ReaderRole", {
    assumedBy: principal(),
    description: props.readerPolicyStatements === undefined ? "Reader-group identity-pool role; only explicit object reads are granted." : "Reader-group identity-pool role; only explicit reviewed policy statements are granted.",
  });
  const unauthenticatedRole = props.allowUnauthenticated === true ? new Role(scope, "UnauthenticatedRole", { assumedBy: principal("unauthenticated"), description: "Explicitly opted-in guest identity role; no AWS API permissions." }) : undefined;
  if (statements) for (const statement of statements) readerRole.addToPolicy(new PolicyStatement({ effect: statement.Effect === "Deny" ? Effect.DENY : Effect.ALLOW, actions: [...statement.Action], resources: [...statement.Resource] }));
  else if (props.readBucketArn) readerRole.addToPolicy(new PolicyStatement({ actions: ["s3:GetObject"], resources: [`${props.readBucketArn}/${props.readPrefix ?? ""}*`] }));
  const readerGroup = new CfnUserPoolGroup(scope, "ReaderGroup", { userPoolId: props.userPool.userPoolId, groupName: props.groupName, roleArn: readerRole.roleArn, precedence: 10, description: "Role claim for this identity pool. Group membership is a separate authorized operation." });
  const provider = `${props.userPool.userPoolProviderName}:${props.userPoolClient.userPoolClientId}`;
  const attachment = new CfnIdentityPoolRoleAttachment(scope, "IdentityPoolRoles", {
    identityPoolId: identityPool.ref,
    roles: { authenticated: authenticatedRole.roleArn, ...(unauthenticatedRole ? { unauthenticated: unauthenticatedRole.roleArn } : {}) },
    roleMappings: { userPool: { identityProvider: provider, type: "Token", ambiguousRoleResolution: "Deny" } },
  });
  return { identityPool, authenticatedRole, readerRole, readerGroup, unauthenticatedRole, attachment };
}
