# Cognito retention and external references

Retention preserves the original User Pool and its users. Referencing that same
pool preserves its pool ID and existing user `sub` values. A new pool does not
recover users, passwords or deleted accounts.

## Configure retention

`framework-config/stateful-resources.ts` is authoritative for Studio and code-only
use. Each mode chooses Database and Cognito independently:

```ts
import type { StatefulResourcesConfiguration } from "../cdk-app/stateful-resources";

export const statefulResources = {
  dev: { database: { retention: "remove" }, cognito: { retention: "retain" } },
  prod: { database: { retention: "retain" }, cognito: { retention: "retain" } },
} satisfies StatefulResourcesConfiguration;
```

An omitted policy inherits the target's existing `RETAIN_STATEFUL_RESOURCES`
input. Shipped empty dev/prod entries preserve that behavior. Source application
and deployment are separate. Inspect actual deployed `DeletionPolicy`,
`UpdateReplacePolicy` and pool deletion protection; source alone proves no protection.

Managed retention covers the pool, native app client, domain, Google/OIDC/SAML
providers and native Cognito invoke permissions. Construct paths, logical IDs,
output names and stack-prefixed exports remain stable. Separately declared groups,
Identity Pools, IAM roles, provider secrets, certificates, external IdP applications
and Lambda functions have independent owners and lifecycles.

This application's pre-signup, message and post-confirmation Lambdas live in the
historical `AsynchronousLambdaFunctionsStack`. Deleting them leaves the retained
pool with unusable trigger ARNs. Retaining a permission does not retain its
function, role, database connection or downstream dependencies. Unsafe teardown
must be refused or scoped to preserve original supporting infrastructure. Groups
with deleted role ARNs and removed Identity Pool mappings need separate reconciliation.

## Reference the retained pool

The supported reuse strategy is an **external reference**. It does not import
CloudFormation ownership, restore a backup, or recreate clients/providers/domains/groups.
The original pool, surviving public client and ACTIVE domain must be compatible.
Inspect exact ownership, account, profile, region, mode and original deployment:

```powershell
node --import tsx scripts/stateful-references.ts inspect --kind cognito --id us-east-1_Example123 --client-id examplepublicclient --original-deployment old-app --deployment new-app --mode dev --profile dev --region us-east-1
```

An active CloudFormation owner blocks this release/reuse pathway. Names alone
are insufficient evidence. Preserve `.framework/retained-resources/` when moving
checkouts so exact original physical-resource/StackId evidence remains available.
Review and copy the inspector's public descriptor into the intended mode:

```ts
export const statefulResources = {
  dev: { cognito: { reference: {
    account: "111122223333",
    region: "us-east-1",
    originalDeployment: "old-app",
    userPoolId: "us-east-1_Example123",
    userPoolClientId: "examplepublicclient",
    userPoolDomainUrl: "https://old-app.auth.us-east-1.amazoncognito.com",
  } } },
  prod: {},
} satisfies StatefulResourcesConfiguration;
```

These identities are placeholders. Credentials, secret values, unknown fields,
incomplete descriptors and cross-account/region references are refused. Domain
URLs are HTTPS origins without a trailing slash. Custom domains may include the
observed `userPoolDomainCloudFrontEndpoint` hostname. Source Apply and reviewed
deployment recheck live compatibility; discovery is not an AWS reservation.

The reference stack publishes original pool/client IDs, domain and OAuth redirect
using existing outputs. Additional `UserPoolManagement=external-reference` and
`UserPoolOriginalDeployment` outputs identify ownership. One standard SSM
StringParameter stores a nonsecret reference manifest so the CloudFormation stack
is deployable. Deleting this shell removes its manifest/outputs and leaves
external Cognito state untouched. External retention policies do not change.

## Complete prerequisites and verify authentication

The public client needs the framework's SRP/password and OAuth authorization-code
flows, scopes and exact callback/logout URLs. A changed frontend hostname or
generated CloudFront URL can require a separately reviewed external client change.
Source Google/OIDC/SAML declarations do not modify a reference. Existing attribute
mappings, provider credentials and external IdP applications remain externally managed.

Reference mode neither attaches triggers nor resolves provider secrets. Existing
functions and exact pool-scoped invoke grants must survive. Unsupported advanced
triggers need separate recovery. Source SES/signup/email-verification flags do not
reconfigure external pools or existing triggers; inspect actual configuration and
downstream runtime dependencies.

`identityPoolAccess` refuses new groups/role mappings against a marked external
pool, preventing silent duplicate groups and unintended role claims. Preserve and
inspect original Identity Pool roles or separately review reconciliation. Native
framework Cognito triggers also refuse imported-pool mutation. Import/adoption,
client/provider/domain recreation and trigger/group-role replacement are separate
unsupported operations in this reference pathway.

Studio reads references from verified deployed outputs, then verifies the live
pool account/region/original framework tags and selected client. It labels the
pool externally managed. User/group mutations are unavailable in this ownership
scope; use a separately authorized original-owner workflow.

After authorized deployment, export normal public frontend settings and verify
pool/client IDs equal the originals. Separately test browser login, refresh/logout,
providers, group claims, Identity Pool permissions and database reconciliation.
Metadata, synthesis and stable IDs do not prove authentication or effective IAM.

AWS contracts: [CDK pool references](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.UserPool.html),
[CloudFormation retain](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html),
[app clients](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html),
[domains](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooldomain.html).
