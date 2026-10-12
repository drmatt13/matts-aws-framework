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
login that signs a token per connection in AWS. It reuses one `pg` pool across warm Lambda
invocations and rejects a different database while that pool is active; disconnect before
changing databases.

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

If planning reports MIGRATION.PLAN_ORIGIN_UNKNOWN on an unmigrated checkout, start from
the newest migration's contract hash, after confirming it is the intended baseline.
`migration:list` shows it as that migration's `toContract`:

```powershell
npm --workspace @repo/database run migration:list
npm --workspace @repo/database run migration:new -- --name <change_name> --from <latestContractHash>
```

Do not substitute an arbitrary snapshot. An abandoned plan can leave a snapshot that
must not be mistaken for the intended baseline. Review before removing abandoned artifacts.

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

Compose starts postgres and runs prisma-migrate before database consumers. Its normal
mode applies committed migrations. `PRISMA_LOCAL_SCHEMA_SYNC=push` selects direct
`db:update` instead; it is an explicit local opt-in, not the production release path.
Starting Compose can therefore mutate the local database.

After migrating, Compose runs prune-cognito-orphans before any consumer starts.
postgres_data outlives the dev Cognito pool: after the dev stack is destroyed and
redeployed, a users row can hold a sub the new pool does not, which can never sign in
and whose email makes signing up again fail with CognitoIdentityConflictError. The
step lists the whole pool named by USER_POOL_ID with the selected AWS profile, then
deletes every users row whose sub is absent. Deleting a user cascades to the rows it
owns, such as its projects. If the pool cannot be listed (no USER_POOL_ID, expired
credentials, a deleted pool) it warns and deletes nothing. It refuses any database
other than the Compose or loopback one.

Then seed-test-user makes `LOCAL_TEST_USER_EMAIL` a working account: it creates the
user in the dev pool if needed, sets its password from cdk-app/.env, and writes its
users row through `ensureCognitoUser`. An admin-created account never fires the
post-confirmation trigger, so this step writes the row itself. It keeps an existing
row, refuses `PROD_DEPLOYMENT=true`, and has the same database guard. See
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
| `db:prune-cognito-orphans` | Delete local users absent from the dev Cognito pool; Compose runs it |
| `db:seed-test-user` | Create the cdk-app/.env test user in the dev pool and local database; Compose runs it |
| `scaffold -- <Model> --dry-run` | Preview a new owned-list/create feature; see Data features |
| `typecheck` / `test` | Check types / run offline database and scaffold tests |

There is no supported `prisma db push` workflow in this repository.

## Generation and verification

Root postinstall restores ignored database artifacts on normal installation. The Docker
image defers that root hook until the Prisma inputs have been copied, then generates
inside the image. CDK also has a database-generation build hook. Host dependencies and
generated database files must never overwrite image-owned files.

`npm run verify` regenerates database artifacts before checking committed GraphQL output.
Database tests cover identity reconciliation, timestamp execution defaults, derived scalar
types, and scaffold output compilation/execution. Feature schema tests execute GraphQL
against repository fakes. These tests do not establish live database migration correctness.
