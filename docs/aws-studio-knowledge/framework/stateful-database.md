---
id: framework.stateful-database
summary: PostgreSQL retention preserves complete dependencies; explicit references reuse original physical identity without adopting ownership.
read_when:
  - Changing RDS retention, retained database reuse or network preservation
source:
  - cdk-app/lib/app/rds-stack.ts
  - cdk-app/lib/app/database-lifecycle.ts
  - cdk-app/lib/framework/framework-network.ts
  - cdk-app/lib/framework/framework-database.ts
related:
  - framework.resources-cdk
  - deployment.planning-safety
---
# PostgreSQL retention and reuse

The actual application database is an RDS `DatabaseInstance` in production mode;
development uses the independent Compose PostgreSQL volume. Optional replicas and
Proxy are managed alongside the writer. There is no cluster recovery implementation.

`RdsStack` keeps historical `PostgresDatabase`/bootstrap/endpoint-output scopes for
managed creation. Retention additionally preserves the underlying Secrets Manager
secret (retaining its attachment alone is insufficient), DB subnet/parameter groups,
database security groups and the entire `NetworkStack` dependency graph. Network
retention applies at synthesis so later-created client groups are protected too.
NAT and interface endpoint costs survive teardown. Teardown must inspect deployed
templates rather than infer this protection from current source.

`DatabaseReference` in `database-lifecycle.ts` is a non-secret immutable physical
identity manifest. `assertDatabaseReference` performs offline structural/destination
validation; it cannot establish live ownership, actual IAM authentication, SQL login
availability, KMS state, network routes or schema compatibility. Live inspection and
reviewed deployment preflight must establish those separately.

Reference mode imports `IDatabaseInstance` attributes and the original `IVpc` with
every subnet/route-table identity in availability-zone order. It registers a direct
`DatabaseConnectionTarget` with a no-op bootstrap, allowing framework workloads to
keep their existing `database: true` declarations. New client security groups and
ingress rules remain owned by the new deployment; the existing database/VPC are
external and are never silently retagged or adopted. IAM grants name only the immutable
`db-.../app_user` identity. No master-secret read, SQL repair, migration or seed occurs.

Reference mode refuses Proxy/replica creation and incompatible database/engine major
settings. VPC CIDR must match the source declaration. The retained VPC must continue
providing its declared DNS, dual-stack subnets, routes and AWS endpoint/egress paths;
reference source cannot reconfigure externally managed network infrastructure.

Regression evidence: `cdk-app/test/database-lifecycle.test.ts` checks identity
rejection, retained dependency policies, exact IAM and no replacement/bootstrap;
`database-topology.test.ts` protects original managed topology identities. The opt-in
`database-local-persistence.test.ts` uses actual PostgreSQL in a random, labelled
Docker fixture and cleans up only its own container and volume. This proves local
volume persistence and framework reconnection, never live RDS recovery.

See [Database](../../DATABASE.md#retaining-and-referencing-postgresql) for workflow
boundaries and the reproducible disposable test command.
