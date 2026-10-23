# Database

`packages/database` owns storage, migrations, connections, and the persistence API.
For agent-driven changes through GraphQL and React, start with [Data features](DATA-FEATURES.md).

## Source and generated artifacts

| File | Responsibility |
| --- | --- |
| `prisma/contract.prisma` | Authored PostgreSQL model/storage contract |
| `prisma.config.ts` | CLI contract/output/migration paths and database connection input |
| `prisma/migrations/` | Committed generated migration packages and snapshots |
| `src/generated/` | Ignored emitted contract JSON/types; never hand-edit |
| `src/contract-types.ts` | Projection from emitted fields to application record types |
| `src/contracts.ts` | Derived records, explicit write inputs, repository interfaces |
| `src/client.ts` | Prisma runtime and PostgreSQL driver binding |
| `src/<plural>.ts` | Ordinary application repository methods |
| `src/index.ts` | Static repository registry, derived Database type, connection cache |

Consumers import `getDatabase`, `disconnectDatabase`, and application types from
`@repo/database`. They do not import generated Prisma files or construct ORM queries.
`getDatabase(databaseConnection())` takes the settings `@repo/framework/runtime/database`
resolves for a workload that declares `database: true`: the Compose Postgres locally, an IAM
login that signs a token per connection in AWS. Application writers use RDS Proxy when
enabled; otherwise they connect directly. Each connection identity (host, port, database,
login) has its own `pg` pool across warm Lambda invocations. Writer and reader pools coexist;
changing settings for an active identity is refused. `disconnectDatabase()` closes all pools.

## Writer and reader connections

Ordinary operations, OAuth reconciliation and migrations use the writer. Declare reader
access on workloads that have reads which tolerate asynchronous replication:

```ts
// framework-config/workloads/http.ts
database: { readers: true },

// Handler: both repository handles can coexist.
const writer = getDatabase(databaseConnection());
const reader = getDatabase(databaseConnection({ role: "reader" }));
```

The reader helper requires that declaration. It picks one configured replica randomly on
first use per execution environment and retains that endpoint and pool. With no replicas,
it uses the writer; development uses Compose Postgres for both roles. Replica failures
surface to the caller, without automatic writer fallback or query retries. Reads can be
stale, including immediately after a successful write. Use the writer for read-after-write
consistency, transactions and authentication. Replica connections bypass RDS Proxy.

`database: { connection: "direct" }` bypasses Proxy for the writer. The existing `db-migrate`
task uses this setting; `databaseUrl()` also resolves only the declared writer. Object
options can combine, for example `{ readers: true, connection: "direct", pool: { maxConnections: 4 } }`.

Configure `defaults.database.pool` and override it with workload `database.pool`:

```ts
defaults: { database: { pool: {
  maxConnections: 10, connectionTimeoutMs: 20000, idleTimeoutMs: 30000,
} } },
```

These settings reach both local and AWS pools through framework-owned
`PRIMARY_DATABASE_POOL_OPTIONS`. Only declared readers receive `PRIMARY_DATABASE_READ_URLS`,
a JSON URL array. Do not author either variable. Each writer/reader pool has its own limit;
budget connections across concurrent Lambda environments, container replicas, migrations
and administrative access. Proxy multiplexing depends on transaction/session behavior:
session pinning can reduce its benefit. Keep TLS verification and IAM token signing per
new connection; a token belongs to the selected endpoint.

## Records and writes

Records use `ContractRow<"Project">`. The projection removes known string-timestamp
brands while preserving ordinary strings, enums, nullability, and newly added columns.
Write inputs explicitly select allowed fields; a new column is not automatically writable.
Repository rows are returned directly. Missing single-row reads/updates/deletes return null.

Timestamps use ISO strings, with automatic update behavior declared in PSL:

```prisma
updatedAt temporal.timestamptzString(6, onCreate: now, onUpdate: now) @map("updated_at")
```

Create and nonempty update execution apply these defaults. Empty updates are no-ops.
Repositories do not stamp timestamps and the string codec needs no Temporal polyfill.
The driver-based runtime is Rust-free; no binaryTargets or native query engine belongs
in a Lambda package. Pinned versions live in package.json/package-lock.json; consult
the installed Prisma references under `node_modules/@prisma/orm-postgres/skills/prisma-8/`
for the exact query, contract, and migration APIs.

## Changing storage

Run from the repository root:

```powershell
npm --workspace @repo/database run generate
npm --workspace @repo/database run migration:new -- --name <change_name>
```

Generation must precede planning. Inspect the planned SQL and commit the authored
contract plus migration package. Check renames, drops, constraints, backfills, and
whether existing rows can satisfy new required fields. Generation/planning are offline;
neither applies the migration. A no-op storage plan is valid for execution-default changes.

If planning reports `MIGRATION.PLAN_ORIGIN_UNKNOWN`, select the intended origin from
the migration graph or a reviewed ref. Each package is an edge from one storage hash
to another; branches and cycles are legal, and folder dates do not establish a current
database or an implicit planning head. `migration:list` shows those edges:

```powershell
npm --workspace @repo/database run migration:list
npm --workspace @repo/database run migration:new -- --name <change_name> --from <intendedOriginHash>
```

Confirm the origin against the intended shipped contract, relevant ref, or separately
observed database marker and physical schema. A graph tip is a useful candidate, not
proof of that choice. Do not substitute an arbitrary snapshot: an abandoned plan can
leave one outside any migration path. Review before removing abandoned artifacts.
Planning is offline, does not inspect a database, and never advances a migration ref.
Use an explicit empty origin only when creating a baseline from empty storage is intended.

Continue the source change using Data features, regenerate artifacts, and run verification.
Only then apply the reviewed migration to the explicitly selected environment:

```powershell
npm --workspace @repo/database run migration:status
npm --workspace @repo/database run db:migrate
npm --workspace @repo/database run db:verify
```

These commands use DATABASE_URL. Configuration reads process environment, root `.env`,
and optional `packages/database/.env`. Confirm the target without printing credentials.
The [production guide](PROD-DEPLOYMENT.md#database-release) explains obtaining the RDS
connection. Agents preparing application code must leave application as a separate action.

## Local database

Compose starts PostgreSQL and runs read-only `prisma-verify` before database consumers.
Starting or recreating compute never applies migrations, prunes users or sets up test
identity. Missing/pending storage blocks consumers while leaving PostgreSQL available.
In Studio, inspect **Database → Database status → Local PostgreSQL**, then separately
review and authorize initialization or migration application. For terminal application,
review the intended SQL/target first, then explicitly run
`docker compose --profile database-write run --rm prisma-migrate`.
`PRISMA_LOCAL_SCHEMA_SYNC=push` selects direct `db:update` only for that explicitly invoked
write service; it is not startup behavior or a production release path.

Orphan cleanup is a separate destructive action, never a startup dependency. After
inspecting the intended pool and affected users/projects, separately authorize
`docker compose --profile identity-cleanup run --rm prune-cognito-orphans`.
postgres_data outlives the dev Cognito pool: after the dev stack is destroyed and
redeployed, a users row can hold a sub the new pool does not, which can never sign in
and whose email makes signing up again fail with CognitoIdentityConflictError. The
step lists the whole pool named by USER_POOL_ID with the selected AWS profile, then
deletes every users row whose sub is absent. Deleting a user cascades to the rows it
owns, such as its projects. If the pool cannot be listed (no USER_POOL_ID, expired
credentials, a deleted pool) it warns and deletes nothing. It refuses any database
other than the Compose or loopback one.

Separately authorize `docker compose --profile identity-setup run --rm seed-test-user`
to make `LOCAL_TEST_USER_EMAIL` a working account: it creates the
user in the dev pool if needed, sets its password from cdk-app/.env.dev, and writes its
users row through `ensureCognitoUser`. An admin-created account never fires the
post-confirmation trigger, so this step writes the row itself. It keeps an existing
row, runs only for a pool a development export wrote, and has the same database guard. See
[Development](DEV-DEPLOYMENT.md#verification-and-troubleshooting).

Database contract/generated files are excluded from Watch. Rebuild the development
image after contract changes. To author a migration with the container CLI, rebuild
first, then open a shell with `docker compose run --rm prisma-migrate sh`; its prisma/
directory is writable on the host. Execute package commands inside that shell. Starting
a shell avoids the service's default migration command, but can start its postgres dependency.
Do not run migrations merely to verify application types or schema tests.

## Commands

Prefix each with `npm --workspace @repo/database run`:

| Script | Effect |
| --- | --- |
| `generate` | Emit ignored contract artifacts |
| `migration:new -- --name <slug>` | Generate an offline migration plan |
| `migration:list` | List on-disk migrations |
| `migration:status` | Inspect pending migration status for the selected database |
| `db:migrate` | Apply migration packages |
| `db:verify` | Check the live schema and marker against the contract |
| `db:schema` | Inspect the live database schema |
| `db:init` | Initialize an empty database additively and sign it |
| `db:update` | Directly synchronize storage; does not author a migration package |
| `db:prune-cognito-orphans` | Separately authorized deletion of local users absent from the dev Cognito pool, cascading owned data; never ordinary startup |
| `db:seed-test-user` | Separately authorized creation/password update of the dev test user and its local row; never ordinary startup |
| `scaffold -- <Model> --dry-run` | Preview a new owned-list/create feature; see Data features |
| `typecheck` / `test` | Check types / run offline database and scaffold tests |

There is no supported `prisma db push` workflow in this repository.

## Studio workbench

`npm run studio` → **Database** offers Prisma source editing beside the diagram,
reviewed source saves, migration-graph comparisons, and offline migration planning in
a disposable workspace. Saving source, emitting application artifacts, installing a
reviewed migration package and applying it to a database remain distinct actions.

**Database status** compares a deliberately selected target with saved source, migration
history and observed physical storage. Unknown, unreachable and unsupported targets
remain unknown. The local target uses the existing literal Compose loopback port; Studio
never starts Compose for inspection. Safe operational PostgreSQL overrides remain supported;
connection-changing overrides use read-only `docker compose config` resolution and require
a unique loopback-only binding. Unresolved bindings remain unavailable. Production requires
a named account/region target and profile. **Check database task destination** reads AWS
metadata; after displaying the exact stack-owned task definition and billing, typed
**Inspect &lt;deployment&gt;** launches a billed VPC task with a database session forced read-only and private-database IAM/TLS access. The task uses its declared subnets/security groups and may receive a public IP; Studio displays the actual assignment before approval. Changes to its full launch/log descriptor invalidate review.
An old write-only task is refused as an actionable deployment prerequisite. Inspecting never
applies SQL; **Apply &lt;deployment&gt;** separately approves a second task after SQL/source review.
Task/source currency, marker/ledger identities and historical physical storage are rechecked
under the canonical PostgreSQL migration lock before DDL. No task or write runs automatically.
Local application requires a reviewed path, fresh physical historical baseline, target
identity checks and typed approval. A marker-less local target can instead request a
reviewed initialization: Studio verifies the absence of application tables, views, sequences,
functions and enum/domain types, previews Prisma's initialization SQL, and requires typing
`Initialize Local PostgreSQL`. A populated unknown target is never reset/adopted implicitly.
Production can initialize a genuinely empty target through the same reviewed additive
initializer, with distinct `Initialize <deployment>` approval. It binds full native operations,
every statement/parameter and canonical control DDL; the writer repeats empty-marker/ledger
and metadata checks inside its canonical transaction before any DDL. Empty means no extra
user schemas, relational/unmodeled objects or large-object metadata. Missing history alone
does not block a fresh schema; populated or partial unknown storage remains refused.
Redacted operation records survive restart; interrupted writes remain unconfirmed and are
never replayed. Inspect the database/ledger before another review. Stable failure codes,
execution stage and known results remain available without connection values.
Production records include the exact task ARN, request token and CloudWatch destination;
submitted tasks can outlive Studio. Unknown outcomes require read-only task/ledger inspection
before retry, never an automatic repeat. Journal locks are checkout-scoped and never removed
automatically; see the workbench guide's deliberate stale-owner recovery procedure.

The [Database workbench guide](framework-studio/database-workbench.md) describes
editor capabilities, evidence, limits and the source/artifact/database boundaries.

## Generation and verification

Root postinstall restores ignored database artifacts on normal installation. The Docker
image defers that root hook until the Prisma inputs have been copied, then generates
inside the image. CDK also has a database-generation build hook. Host dependencies and
generated database files must never overwrite image-owned files.

`npm run verify` regenerates database artifacts before checking committed GraphQL output.
Database tests cover identity reconciliation, timestamp execution defaults, derived scalar
types, and scaffold output compilation/execution. Feature schema tests execute GraphQL
against repository fakes. These tests do not establish live database migration correctness.
