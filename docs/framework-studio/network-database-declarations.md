# VPC and managed PostgreSQL declarations

The source contract separates friendly names, declaration IDs, and deployed construct
identities. Studio writes reviewed declarations; applying source never deploys or connects
to a database.

Before, the composition root paired a native database with its VPC, while infrastructure
settings lived in deployment inputs:

```ts
networks: [applicationVpc],
database: { resource: resources.rds.database, vpc: applicationVpc },
```

After, one independently importable database declaration owns its placement and defaults:

```ts
// framework-config/databases/application/index.ts
export const applicationDatabase = defineDatabase({
  id: "application",
  resource: resources.rds.database,
  vpc: applicationVpc,
  subnet: "isolated",
  engine: "postgres",
  databaseName: "app_db",
  settings: {
    engineVersion: "16", instanceClass: "db.t3.micro",
    storageType: "gp2", allocatedStorage: 20, maxAllocatedStorage: 100,
    backupRetentionDays: 7, multiAz: false, readReplicaCount: 0, proxyEnabled: false,
  },
});

// framework.config.ts
networks: [applicationVpc, analyticsVpc],
database: applicationDatabase,
```

Workloads keep `database: true` and an explicit reference to the database's VPC. IAM-only
login, the local Compose PostgreSQL counterpart, and cross-VPC refusal remain unchanged.
Existing `DATABASE_*` inputs and matching CDK context deliberately override declaration
defaults. Studio labels these values as declaration defaults; synthesis resolves the
deployment's final settings. The structural `{ resource, vpc }` reference remains accepted
for native/framework fixtures; application guidance uses `defineDatabase`.

The ID belongs to the declaration rather than a singleton filename. Replica count, writer
and replica Multi-AZ, Proxy, storage, engine and maintenance policy are optional settings
on the same value. A future named database registry can compose these values and add
explicit named consumer references while preserving today's primary `database: true`.
Additional managed databases and separate local schemas are not provisioned by this change.

In Studio, **Add to application → VPC** scaffolds
`framework-config/networks/<id>/index.ts` and registers its import. Stable IDs and construct
identities must be unique. Display names are editable without renaming infrastructure.
Smart CIDR suggestions use unused private `/16`s; live validation rejects accidental
overlap before review. The DSL still permits deliberately overlapping independent VPCs.
The VPC Inspector reviews settings and removal. Removal requires no workload, database,
or native source references and removes the module, registry import and descriptions;
undo restores exact source. Referenced or custom modules receive a corrective refusal.

The RDS building and local PostgreSQL node open the dedicated **Application PostgreSQL**
inspector. The owning stack and **Database → Configure PostgreSQL** link there too.
Development and production cards explain the shared schema and independent data. The
inspector shows application writer/Proxy, direct migration and opt-in reader paths,
declared consumers and per-process pool limits. Local persistence remains owned by Compose.
Capacity, availability/backups, Proxy/connections, maintenance/logs and caller pool defaults
have separate disclosures. Deployment override entries are linked by name without values;
the policy preview is a declaration preview, not a live database or final synth result.

**Database home → Change placement** offers registered VPCs and private/isolated subnets;
there is no public or unplaced state. A VPC change stages one typed `databasePlacement`
operation, which updates the literal database declaration and every normalized framework
database consumer across both mode graphs. Consumer subnet tiers, database bindings,
construct IDs and native stack source stay intact. Computed/ambiguous declarations and
competing consumer placement edits receive a corrective refusal. Both mode evaluations
and TypeScript checks must pass before source review. Apply verifies the actual database
and consumer placement; mismatch rolls back, and undo/redo restores exact source bytes.
Identity, database name and engine family remain source-owned.

For deployed RDS, source placement is preparation for a planned migration/cutover. It
does not copy data, guarantee an in-place AWS move, or authorize deployment. Review native
CDK wiring, both synths and the deployment change set separately. The database's current
VPC remains required until the declaration and consumers are reassigned; native source
references can still block removing the old VPC. No database is silently detached.

This is a source-configuration migration only. `RdsStack`, `PostgresDatabase`, subnet
group, secret attachment, replicas, Proxy, IAM-login bootstrap and endpoint output scopes
stay where they are. Complete before/after RDS templates are compared, including default
and Multi-AZ/replica/Proxy configurations. No schema or data migration is required by
the refactor; changing those policies later still requires separate synth/deployment review.

Region belongs to the named application deployment in `cdk-app/cdk.json`, not a VPC.
Its pinned account/region supplies every stack environment, AZ selection and regional
endpoint. Network construction rejects incompatible caller environments, including first
native use and later cached use. Existing target pins provide the guardrail; adding a
second allowed-regions vocabulary would duplicate it. Separate named targets can use
different regions, but do not imply replication or failover. Native same-VPC consumers
and ordinary CloudFormation cross-stack imports require the same account and region;
see [CDK environments](https://docs.aws.amazon.com/cdk/v2/guide/environments.html) and
[CloudFormation ImportValue restrictions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-importvalue.html).

Studio checks its browser/server protocol before edits. After server-side declaration API
changes, restart `npm run studio` and reload. Synchronous and asynchronous validation
errors both return JSON with corrective messages instead of HTML status pages.
