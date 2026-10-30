# SQL, database and retention campaign — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

Owner: `/root/sql_recovery`. Source leases were partitioned with the lead; no
shared application source, shared database, AWS resource or real environment input
was changed by these experiments. The only HTTP mount edit was the coordinated
`databaseSqlRouter` import/mount in `server/server.ts`.

## Initial current-state matrix

| Capability | Initial state | Current-source evidence observed before edits | Owner/action |
| --- | --- | --- | --- |
| Prisma source, validation, offline migration review | Working in tests; broken in this Windows browser | `database-workbench.ts`, `database-history.ts`; fixed source guard compared native backslashes with a forward-slash constant | Preserve existing authority; normalize path comparison |
| Typed local initialization/migration application | Implemented; real target behavior not re-proven here | `database-application.ts`, its fixture suites, canonical runner guard | Preserve; do not introduce a second migration runner |
| Protected production application | Implemented; live execution unverified | `database-cloud.ts`, versioned VPC task; explicit IAM/TLS target-bound inspection/write approvals | Preserve; no production task launched |
| Reusable repository SQL/seed/backfill/inspection | Missing | Database had Schema, History & migrations and Database status only; guide explicitly said no general SQL console | Implement authored `.sql` files, service, routes, UI and tests |
| Operation outcome history | Working for migrations, missing for saved SQL | `database-operations.ts` had durable migration records and no general command contract | Reuse its cross-process database lock; add redacted SQL history |
| Environment-specific retention control | Existing CDK/env policy, missing from database GUI | `RETAIN_STATEFUL_RESOURCES` in `cdk-app/deployment.ts`; RDS/Cognito removal policy and deletion protection; no retention switch in ManagedDatabaseControls | Reuse the existing protected input service and public allowlisted source endpoint |
| Automatic RDS/Cognito retained-resource adoption | Unsupported | Managed stacks construct their owned resources; no primary DB/pool import/adoption API | Explain boundaries; do not claim recovery from a switch |
| Local data persistence | Declared, initially unverified here | Compose `postgres_data`; ordinary startup never migrates/seeds | Prove container replacement using an owned volume and fake rows |

## Implemented source and operations

`shared/database-sql.ts` defines saved commands, source/execution reviews and
truthful operation outcomes. `server/database-sql.ts` provides the fixed repository
authority and reuses the private Compose target resolver, existing database
operation lock and installed `pg` driver. No `DATABASE_URL` input, custom arbitrary
target URL, package dependency or startup runner was added.

Source lives in `packages/database/sql/{seed,backfill,operation,inspection}/name.sql`.
One versioned JSON metadata comment and one SQL statement keep source review
single-file and code-first. Review creates no file; explicit Save uses the existing
expected-contents/exclusive-create helper. Source changes, linked paths, stale hashes
and existing destinations are refused. Hand-edited files are discovered by refresh.
Malformed files appear as catalog issues without execution.

Execution is a different, expiring, single-use review bound to exact file bytes,
private target identity and positional scalar parameters. PostgreSQL's extended
query protocol prevents multi-statement batches. Transaction controls, schema DDL
and SELECT INTO are rejected from the saved-command surface. Inspection runs in a
database-enforced read-only transaction; result display is capped at 100 rows.
Writes run in a transaction with statement and lock timeouts. Repeatable intent
requires authored idempotence. Once intent uses the reserved `framework_studio.sql_runs`
in the same transaction, keyed by command path and parameter-set digest. Editing a
committed once command does not silently reset it.

Only acknowledged COMMIT is `committed`. A failed statement with acknowledged
rollback is `failed`/`unchanged`. Lost COMMIT acknowledgement, interrupted execution
and failed durable outcome recording remain `unconfirmed`; there is no automatic
write retry. Fsynced history excludes parameter values, result rows and free-form
driver errors; SQLSTATE is retained. Existing state-directory ancestors and files
are checked against symbolic links.

Production saved SQL is explicitly unavailable. Selecting Production and reviewing
execution cannot open a local connection or launch a task. The original protected
production migration workflow remains available in Database status. This is a
remaining product limitation, not a claim that arbitrary saved production commands
were implemented or externally validated.

`DatabaseSql.tsx` adds **Database → Saved SQL**. Source and execution have separate
dialogs. Results identify command, path, revision and target; changing the command,
parameters or target clears the old result. Approval errors stay visible in their
modal. SQL and retention remain usable if Prisma source loading fails, so an invalid
contract does not hide operational recovery.

`DataRetention.tsx` adds **Database → Data retention** and is shared by the Cognito
view. It reads only allowlisted public source inputs from `/identity/source`, then
uses the existing protected deployment-input review/apply API. Mode and snapshot
changes invalidate its loaded source/plan, request generations discard late source
responses, and an existing global draft blocks editing. It preserves the existing
shared retention policy and defaults. It explains source intent versus deployment,
deletion protection, continuing RDS cost, independent local volumes, missing
dependencies, snapshots, import/adoption and absent automatic reattachment.

## Real Pass 1 evidence

The lead granted an exclusive lease for container `campaign-sql-20261023`, volume
`campaign-sql-20261023-data` and loopback port `15463`. PostgreSQL 16 was already
cached; no image was pulled, no cloud resources provisioned, and no host/shared
volume was mounted. Both container and volume carry
`com.matts-aws-framework.campaign=20261023` and
`com.matts-aws-framework.owner=sql`.

The fixture was `.cache/studio-campaign-20261023/app`, served at port 4591, with an
owned browser tab separate from the lead's creation journey. Its root Compose
binding was pointed at the leased database using fake, disposable credentials.
No original checkout `.env` file was read for values, overwritten or committed.

| Journey | Observed result | Evidence |
| --- | --- | --- |
| Fresh Database browser load | Failed before SQL exercise | Visible `The contract resolves outside its fixed source authority` exposed the Windows separator bug |
| GUI create seed → review → save | Passed | Actual fixture file `packages/database/sql/seed/campaign_gui_seed.sql` contains the reviewed metadata and `INSERT ... ON CONFLICT ... RETURNING label` |
| Explicit selected-target execution | Passed | Typed `Run campaign_gui_seed on Local PostgreSQL`; browser showed confirmed COMMIT, one returned row `campaign-gui-demo`, durable history |
| Seed rerun with same parameter | Passed | New typed approval; browser showed confirmed COMMIT and zero inserted rows |
| Deliberate constraint failure | Passed | GUI-authored `campaign_gui_failure.sql`, duplicate INSERT, typed approval; UI showed SQLSTATE 23505, failed/unchanged and no committed transaction changes |
| Independent row inspection | Passed | `docker exec ... psql` queried exactly `campaign-gui-demo` after the failed statement; one original row remained |
| Server restart | Passed | Catalog rediscovered both saved commands and the two earlier commit records; no write replay occurred |
| Production target selection | Passed boundary | Review refused with the versioned IAM/TLS task/target-bound approval explanation; no task launched |
| Retain/reconnect local volume | Passed | Verified ownership/mount, stopped container, removed it without `-v`, recreated with the same named volume; actual psql row remained |
| Retention missing source | Passed refusal | Development/prod missing input file disabled the switch and gave an explicit prerequisite |
| Retention GUI source change | Passed | Disposable dev template initialized with the canonical existing `createDeploymentInput`; GUI checked retain → reviewed → saved; actual fixture line `RETAIN_STATEFUL_RESOURCES='true'`; prod input remained absent; no deployment |

Native browser accessibility snapshots captured the reviewed SQL, target identity,
row count, typed approval, 23505 failure and retention source review. A browser
screenshot of the failure/result/history was emitted during the journey. No
standalone screenshot file was saved by the author. The lead's independent narrow
replay saved `.cache/studio-campaign-20261023/sql-pass2-narrow-fixed.png`.

The dev input initialization used the canonical server helper in the terminal,
because the retention view correctly refuses an absent input file and the existing
creation control lives in Deploy. This remains a small setup detour; the retention
change itself was performed through the real GUI. No original environment input
was touched.

## Isolated integration and focused verification

| Check | Result |
| --- | --- |
| Saved SQL service/unit suite after independent security review | 9/9 passed |
| Existing workbench + existing workbench UI + initial SQL suite, run from Studio workspace | 40/40 passed |
| New SQL component checks for approval error visibility and stale success clearing | 2/2 passed |
| Real PostgreSQL opt-in integration | 1/1 passed; eight actual operations, then real installed Prisma strict schema verification after once ledger creation |
| Studio client/server TypeScript checks | Passed after final SQL UI refinements and structural jsdom test typing correction |
| Knowledge link/source checker | Passed after documentation update |
| Independent Cognito production-domain gate review | No blocking defect; 2/2 tests independently passed |

The live integration uses only `STUDIO_SQL_LIVE=campaign-sql-20261023`, its fixed
loopback port and fake campaign database. It proves real seed insert/rerun, query,
once-only commit/skip, duplicate-key rollback, attempted write through inspection
rejection and preserved data, plus redacted history across a service restart. It
does not start Docker automatically and is skipped in ordinary offline verify.

An initial direct Node test invocation from the repository root used the wrong
tsx JSX configuration and reported `React is not defined` in existing components.
Rerunning from the `framework-studio` workspace, matching its normal npm workspace
command, passed all 40 focused tests. This invocation failure was not hidden.

## Independent review and replay

`/root/release_identity` independently reviewed SQL security and found SELECT INTO
could create schema objects and state-history ancestors could traverse links. Both
were fixed, with regression tests. It also reviewed the existing journal Windows
`r+` fsync fix as narrowly scoped. `/root/identity_domains` independently challenged
retention's late responses, source invalidation, global draft overlap and broad
dotenv reads; all were tightened before handoff.

The lead independently opened a fresh replay tab, selected the persisted seed,
bound `independent-pass-two`, typed its target confirmation and observed one real
committed insert. It repeated the same bound values and observed zero duplicate
inserts. It confirmed the author's history survived and saved the narrow screenshot
above. Final psql inspection independently showed both `campaign-gui-demo` and
`independent-pass-two` in the actual database before cleanup.

The narrow replay found the shared seven-tab navigation overflowed a 420px viewport.
The lead fixed that shared navigation: measured document width was then 420px,
navigation width 388px, with bounded horizontally scrollable contents 475px. This
was an independent integration refinement rather than a claim that a CSS media rule
alone established usability. The lead still owns the final integrated synth/verify
gate. Mock-only failures are not counted as live AWS evidence.

## Retention/recovery truth and residual work

### Additional independent integration repairs

After SQL cleanup, the lead assigned a real GUI regression: selecting the newly
created `campaign-event` repeatedly logged duplicate React keys. Independent reads
of the actual port-4591 snapshot and `buildScene` output established exactly one
target/node per mode, ruling out duplicate source authority or model/layout nodes.
The event Inspector rendered `WorkloadConnections` and `Triggers` as direct siblings
with identical `key={target.ref}`. `Inspector.tsx` now namespaces those independent
component identities (`connections:` and `triggers:`). A focused real-framework
event Inspector + snapshot refresh UI regression passed 1/1. The lead owns frozen
browser sync; the author then independently navigated the real frozen browser to
`/isometric?select=lambda%3Acampaign-event`, observed the event Inspector and both
connection/trigger controls, and read zero duplicate-key console errors. No
infrastructure identities were changed.

An independent B/C review also challenged attaching optional S3 read permissions
to the same role used as the default authenticated role and the reader group.
Ambiguous-token denial alone does not prove a missing group cannot receive the
default role. The finding was sent to the identity specialist/lead with the proposed
permissionless-default/separate-reader-role fix. The identity specialist implemented
that separation; independent source review and all 3 native synthesis tests passed.
The default role has no API policy, while only the group ReaderRole can carry the
explicit bucket/prefix GetObject grant. No effective AWS credential/runtime test is
claimed. See [AWS role mapping documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/role-based-access-control.html).

A final installed-adapter review also moved the new once-only ledger out of the
application's public namespace into reserved `framework_studio.sql_runs`. The same
owned local namespace was briefly re-created with a minimal real contract-matching
table. The full SQL lifecycle, followed by actual installed Prisma
`schemaVerify({strict: true})`, passed. SQL/service component checks passed 11/11.
`/root/release_identity` independently reviewed the consistent transactional
create/select/insert namespace change and found no widening of target/permission
scope. Older experimental public scratch ledgers are not automatically adopted;
the feature was not previously shipped.

No RDS instance, Cognito pool, IAM identity or AWS stack was created, modified or
destroyed by this agent. No production operation was attempted. Retain policy
source was changed only in the disposable fixture; deployed protection/recovery
has not been established. Existing framework construct identities were not moved.

RETAIN keeps a physical AWS resource; it does not guarantee surviving supporting
network/IAM/client/provider/domain dependencies or adoption by a new stack.
Snapshot restoration creates a distinct instance/endpoint. Cognito passwords cannot
be exported into a replacement pool. Local-volume reuse was proven; automatic
primary RDS/Cognito import/reference recovery is unsupported and explicitly stated.

Remaining limitations are production arbitrary saved SQL, automatic retained
primary-resource adoption, durable browser draft recovery and final integrated
synth/verify. Broad external AWS effects
were deliberately not used to replace source/fixture evidence.

## Resource and cleanup ledger

| Resource | Identity and ownership | Continuing cost | State at specialist handoff |
| --- | --- | --- | --- |
| Owned local PostgreSQL container | `campaign-sql-20261023`, first replacement ID begins `d45f9ef6e660`; final Prisma-proof instance begins `e7b2630bcbcc`; exact campaign/owner labels | None remaining | Both runs stopped and removed after final ownership/mount proof |
| Owned PostgreSQL volume | `campaign-sql-20261023-data`, exact campaign/owner labels | None remaining | Removed only after its exact consumer was stopped/removed; absence verified |
| Fixture SQL and history | Under `.cache/studio-campaign-20261023/app` | Local disk only | Retained as campaign evidence; original source untouched |
| AWS resources | None | None introduced | No cloud cleanup required |

Cleanup completed: immediately rechecked exact labels and mounted volume, queried
both GUI labels, stopped and removed the exact owned container, then removed its
exact now-unused volume. Filtered container/volume listings returned no matches.
No forced removals, broad prune, unrelated container or volume operations were used.
The cached pre-existing PostgreSQL image was preserved. The ignored source/history
fixture remains as evidence; its target is no longer reachable because the owned
test database has been deliberately removed.
The final reserved-schema proof was also cleaned completely after verifying its
single once-only ledger record. Rechecked ownership, stop/remove/unused-volume
removal and empty filtered inventory were repeated without force or broad cleanup.
