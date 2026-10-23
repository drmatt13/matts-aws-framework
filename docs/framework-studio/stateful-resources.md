# Stateful retention and reference reuse

`framework-config/stateful-resources.ts` is the application-owned TypeScript authority.
Database and Cognito policies are independent in each deployment mode:

```ts
import type { StatefulResourcesConfiguration } from "../cdk-app/stateful-resources";

export const statefulResources = {
  dev: { database: { retention: "remove" }, cognito: { retention: "retain" } },
  prod: { database: { retention: "retain" }, cognito: { retention: "retain" } },
} satisfies StatefulResourcesConfiguration;
```

The checked-in empty `dev`/`prod` policies preserve existing behavior. An omitted
retention field inherits the existing `RETAIN_STATEFUL_RESOURCES` resolution,
including the deployment context override and selected inputs file. Configuring
one field deliberately overrides that resource only. Other stateful application
resources keep their existing shared-input behavior. Source changes take effect
after a separately reviewed deployment updates the relevant stack policies.

Studio exposes this file in Database → Data retention, Cognito → User Pools →
Retention and retained pool reuse, and Deploy → Stateful retention and retained-resource
references. The source review shows the TypeScript diff. Save writes source only,
uses the checkout source lock and durable source-recovery journal, and expires
when source, selected inputs, destination declarations or inspection code changes.
Reference inspection is repeated before saving. Arbitrary executable configuration
remains available to code-only users; Studio conservatively hands unsupported AST
forms back to the editor rather than rewriting them.

Configured intent and actual deployed protection are different evidence. Use
**Inspect deployed protection and inventory** to read deployed templates and the
exact teardown consequences. This preview authorizes no deletion. If AWS reads
fail, protection stays unverified. A source checkbox is never proof of protection.

| Operation | Identity and management | Supported here |
| --- | --- | --- |
| Retain in place | Original resource survives stack removal; costs and dependencies remain | Managed RDS/Cognito policies and guarded teardown |
| Reference | Original resource stays externally managed; new application connections use its IDs | Compatible PostgreSQL writer and original Cognito pool plus existing public app client |
| CloudFormation import | Transfers an existing resource into a stack's management | Separate AWS/CDK procedure; no automated import |
| Snapshot restore | Creates a distinct restored DB with a new resource identity and endpoint | Separate procedure; no automatic restore or adoption |
| Replace | Can create empty state with a new identity | Managed/reference transitions are refused by deployment guards; plan a distinct authorized migration |
| Permanently delete retained state | Irreversible data/user removal | Separate explicit destination-specific operation; no deletion button in this workspace |

## Retention dependencies and teardown

Managed database retention protects the RDS instance, existing secret, database
subnet group/security resources and its framework network. Network retention
includes routes, NAT, gateways and endpoints. These can continue billing after
the application is gone. Imported keys and other external dependencies stay
their owner's responsibility. Read the actual deployed template review before
teardown; historical deployments need a retention-policy deployment first.

Managed Cognito retention preserves the User Pool and its authored app clients,
domain/providers and pool invocation permissions. Users stay in the original
pool. Related stacks can still contain triggers, Identity Pool roles, group
relationships, certificates, secrets or other dependencies. Unsafe destruction
of a retained resource's dependencies is blocked. In particular, retaining a
pool does not authorize deleting the Lambda functions it still invokes: preserve
or separately reconcile those dependencies before teardown.

The existing teardown CLI binds immutable StackIds, deployed-template digests,
account/region/mode, policies and an expiring review. It captures physical resource
IDs before the first deletion and records completed, failed or interrupted evidence.
Partial commands can leave real cloud effects; inspect before retrying. Rollback
cannot reconstruct deleted stateful records.

## Durable inventory and CLI parity

Teardown evidence is stored in
`.framework/retained-resources/<account>/<region>/<deployment>.json`. It survives
removed declarations and deleted stacks. Preserve/copy this directory when moving
checkouts; it is local evidence, not a globally coordinated claims registry.
Live resource tags, physical IDs, CloudFormation ownership and existing reference
metadata must corroborate it. A name alone never establishes ownership. Old
teardowns without sufficient physical evidence can require restoring their ledger.

Read-only CLI equivalents:

```powershell
npx tsx scripts/stateful-references.ts list --deployment <destination> --mode dev --profile dev --region us-east-1 --json
npx tsx scripts/stateful-references.ts inspect --kind cognito --id <original-pool-id> --client-id <existing-client-id> --original-deployment <original> --deployment <destination> --mode dev --profile dev --region us-east-1 --json
npx tsx scripts/stateful-references.ts inspect --kind database --id <original-instance-id> --original-deployment <original> --deployment <destination> --mode prod --profile dev --region us-east-1 --json
```

After inspecting the returned public descriptor, put its `reference` object in
the corresponding TypeScript resource policy. Review/synthesize and use the
normal deployment plan/apply commands. The wrapper validates references before
secret writes or CloudFormation changes, including saved-assembly apply. A
reference does not read master credentials, migrate a database or modify a pool.
The Studio review uses this same inspector. All billable deployment, teardown,
database writes and identity operations retain their independent authorization.

The inspector-authored database descriptor's `masterSecretArn` is public recovery
identity evidence, verified against original deployed dependency evidence. It is
never a workload secret binding and grants no read. Do not hand-author secret ARNs
or credentials into source: secret delivery still uses the single resource catalog
and normal deployment-managed ARN binding. Reference mode never fetches this
secret's value or publishes a credential-bearing connection string.

Inventory observations are labeled uncertain until live compatibility inspection.
Inspection rejects wrong destinations, missing resources/dependencies, active
CloudFormation management, conflicting framework references and unsupported
configurations. AWS permissions or missing evidence can make the state uncertain;
an error does not establish resource absence. There is no distributed lock across
checkouts: concurrent recovery requires coordination and live reinspection.
Within this checkout, sorted locks by physical resource identity serialize
deployment preparation/application across different destination names. Conflicting
live references report the exact other deployment and StackId.

## Database reconnection

Development PostgreSQL uses the existing Compose named volume. Stop/start and
container recreation with the same project/volume preserve records. This policy
file does not delete or recreate volumes. A changed project, missing volume,
schema mismatch or connection failure must be diagnosed separately.

The AWS reference adapter supports the actual standalone encrypted, private,
IAM-enabled RDS PostgreSQL writer. It reuses its original VPC, subnet tiers,
security groups, immutable DB resource ID, endpoint and port. It validates retained
network/DNS/IPv6/routing, KMS and secret identities. New application ingress and
least-privilege `rds-db:connect` grants target the selected original resource and
existing `app_user`. No SQL bootstrap, migration, repair, seed or password-secret
read runs in reference mode. Existing proxy/replica/cluster topologies are outside
the initial reference strategy. [Database guidance](../DATABASE.md) specifies
supported declarations and an opt-in disposable real persistence test.

After supporting infrastructure deployment, verify IAM/TLS connectivity and query
known retained records with a separately authorized read. Metadata cannot prove
that `app_user` exists, that runtime networking works, or that schema matches
the current application. Keep migrations independently reviewed.

## Cognito reconnection

Select the original pool and an existing public app client. Pool/client/domain
outputs preserve those IDs; a small SSM parameter owns only nonsecret reference
metadata in the destination stack. No duplicate pool, client, domain, provider
or group is created. CloudFormation never gains management authority over the
referenced pool. Existing users and their pool-specific identities stay there;
passwords are not exported and deleted users cannot be restored this way.

Inspection checks account/region, original ownership and release, app-client auth
flows, scopes and providers, domain availability and supported trigger permissions.
Deployment also checks intended callback/logout URLs and providers against the
saved assembly. Configure a changed destination URL on the external client through
a separate authorized process before deploying. Missing or advanced encrypted
trigger dependencies require explicit recovery outside this adapter.

Referenced-pool metadata remains inspectable in the unified Cognito workspace.
User/group mutations and generated Identity Pool group/role reconciliation are
refused for reference-only pools: importing a pool must not silently widen access
or change another application's users. Existing external group/role/trust/provider
configuration remains externally managed. Verify real OAuth sign-in, issued
tokens and intended Identity Pool access after deployment; metadata inspection
is not proof of authentication or effective IAM access.
