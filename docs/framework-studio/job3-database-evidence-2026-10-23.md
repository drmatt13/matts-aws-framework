# Job 3 database, persistence and recovery evidence

Executed October 23, 2026, against this checkout. This report covers local PostgreSQL
and Studio's real server services. It makes no claim of RDS recovery, browser
acceptance, CloudFormation import, snapshot restoration or a complete full-stack pass.

## Runtime and ownership

The initial sandbox Docker request was denied filesystem socket access; an approved
escalated read established Docker Desktop was stopped. Starting the installed Docker
Desktop made Docker 29.8.0 and Compose 5.5.1 available. No existing containers were
running at baseline. The cached `postgres:16` image ran PostgreSQL **16.15 on arm64**,
digest `sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.
No image pull or AWS mutation was needed. These are local compute observations,
not claims about billed AWS costs.

| Fixture | Ownership | Destination | Purpose / cleanup |
| --- | --- | --- | --- |
| `matts-job3-database-20261023` | Compose project plus `com.matts-aws-framework.campaign=job3-database-20261023` on container/volume | Loopback `15463`, dedicated `campaign_data` volume | Initial native initialization, saved SQL, migration and independent GUI/runtime investigation; exact container/network/volume removed and absence verified |
| `matts-job3-db-403be00b` | Random project plus `com.matts-aws-framework.job3` matching its project | Loopback `55000`, independently labeled `campaign_data` | First live regression; six subjourneys passed, last stopped at unsupported test-harness Compose flag; exact project and volume removed |
| `matts-job3-db-a6fd68ae` | Same independent ownership scheme, fresh project | Loopback `55001`, separate volume | Corrected full local regression **8/8**; container/network/volume removal and volume absence verified |
| `matts-job3-db-5af0aeda` | Same independent ownership scheme, fresh project | Loopback `55002`, separate volume | Extended local regression **9/9**; actual wrong-credential case added, cleanup and volume absence verified |
| `matts-job3-db-2a7c04a1` | Same independent ownership scheme, fresh project | Loopback `55006`, separate volume | Final guarded live regression **9/9**; label-scoped cleanup and absence verified |

The regular application Compose project and `postgres_data` were not opened,
reused, removed or reset. All disposable credentials were synthetic fixture values;
no user environment files or database records were changed.

## What actually ran

| Journey | Observed result | Classification / evidence |
| --- | --- | --- |
| Compose startup | Actual Linux PostgreSQL container reached its real healthcheck | Runtime, not `compose config`; `.cache/job3/database/postgres.log` |
| Empty database initialization | Studio reviewed native precheck/CREATE/postcheck SQL plus control tables, then its actual Prisma runner applied it; marker and strict physical schema matched | Real Studio service and driver, not browser; `initialize.log` |
| Empty target changed after review | An independently created view invalidated the empty proof; application refused; deleting only that fixture view permitted a new reviewed initialization | Actual metadata/DDL and refusal; `lifecycle-live.log` |
| Repeatable saved seed | Bound value contained quotes, SQL terminators and `DROP TABLE` text; row inserted as data. `ON CONFLICT` rerun affected zero rows | Actual parameter binding and idempotence; `lifecycle-live.log` |
| Once-only seed/backfill | First run committed, same parameter set skipped. Ledger remained valid after service restart and complete compute replacement | Real `framework_studio.sql_runs` in the retained volume; `lifecycle-live.log` |
| Duplicate row | PostgreSQL returned **23505**; Studio reported failed/unchanged after acknowledged rollback; original rows remained | Actual constraint failure; `saved-sql-live.log`, `lifecycle-live.log`, `postgres.log` |
| Read-only SQL | A `nextval` inspection returned actual server **25006**, and the sequence's `is_called` remained false | Proves PostgreSQL read-only enforcement, rather than merely rejecting wrapped DML syntax; `lifecycle-live.log` |
| Changed source and target | Editing saved SQL after execution review, or changing the resolved loopback port, invalidated execution before any additional row | Real source/private-target recheck; `lifecycle-live.log` |
| Retained credential mismatch | Changing only Compose's declared password produced actual PostgreSQL **28P01**; Studio reported unchanged and omitted rejected password from result/history; restoring correct declaration recovered | Existing PostgreSQL credentials belong to persisted storage; changing Compose metadata does not reset a role; `lifecycle-live.log` |
| Migration artifacts | Studio ran installed Prisma offline to plan baseline and forward nullable-column packages; installed only reviewed artifacts | Real source/artifact path, database unchanged until explicit application; `migration.log` |
| Physical drift | Extra column outside contract produced `divergent`; migration review refused. Removing only that injected column restored a known historical baseline | Actual strict schema verification; `lifecycle-live.log` |
| Changed migration package | Appending a comment to reviewed migration source expired application; restoring bytes and preparing a new review allowed application | Real source hash refusal; `lifecycle-live.log` |
| Forward migration | Actual Prisma migration added nullable `description`, preserved existing rows, advanced marker/ledger and returned `current` after strict physical inspection | Real migration runner and PostgreSQL, no mocked client; `migration.log`, `lifecycle-live.log` |
| Database unavailable | Stopping only campaign PostgreSQL made Studio observation `unreachable`; saved SQL failed/unchanged. Starting it recovered data and durable redacted operation history | Actual stopped process and refused connection; `lifecycle-live.log` |
| Retained volume reconnect | Stopped and removed original container after label verification. A new container ID mounted the exact retained owned volume. Original rows, updated schema/marker and once ledger survived and were queried successfully | Local database recovery, not AWS reference/import/snapshot recovery; `lifecycle-live.log` |

The existing saved-SQL live suite also passed **1/1**, including real pinned Prisma
strict verification after the once ledger had been created. Its read-only DML-CTE
attempt was rejected by PostgreSQL's nested-DML restriction; the separate 25006
probe above verifies the actual transaction read-only boundary.

## Product finding and repair

While deliberately stopping storage, Studio's error said Compose startup could
apply migrations. Current startup is read-only verification, so that guidance was
stale and confusing. The error now identifies the selected Compose project,
published loopback port, separate project startup and the fact that inspection
starts no containers and applies no migrations. The live unavailable-target
journey verifies the corrected message while actual PostgreSQL is stopped.

The first lifecycle regression used unsupported `docker compose rm --yes`.
That was a test-harness defect, not a Studio or persistence failure. Cleanup
succeeded. The harness now verifies the exact stopped container's independent
campaign label and calls ordinary `docker rm` without forcing removal; a fresh
fixture replay verified the full recovery journey.

## Checks and reproducibility

```sh
# Explicitly disposable runtime tests; Docker and loopback network access required.
STUDIO_DATABASE_LIVE=job3-disposable node --conditions=development --import tsx --test framework-studio/test/database-lifecycle-live.test.ts
STUDIO_SQL_LIVE=campaign-sql-20261023 node --conditions=development --import tsx --test framework-studio/test/database-sql-live.test.ts
```

The first command owns setup and cleanup. The second existing suite requires a
separately provisioned disposable `campaign` PostgreSQL on loopback `15463` with
its declared `demo_items(label)` table; it does not create or clean the server.
Do not run it against ordinary application data.

| Check | Actual terminal result | Log |
| --- | --- | --- |
| Real Compose lifecycle, extended | **9 passed, 0 failed, 0 skipped**, final guarded replay 11.17 seconds | `.cache/job3/database/lifecycle-live-final.log` |
| Inherited override safety | **3/3** override cases refused before fixture setup with Docker absent from PATH | `.cache/job3/database/inherited-override-refusals.json` |
| Existing real saved SQL suite | **1 passed, 0 failed, 0 skipped** | `.cache/job3/database/saved-sql-live.log` |
| Existing framework `databaseConnection()` persistence suite | **1 passed, 0 failed, 0 skipped**; actual 28P01 wrong login and 42703 missing column, volume reuse, missing destination and cleanup | `.cache/job3/database/framework-persistence-live.log` |
| Focused workbench and SQL regressions | **27 passed, 0 failed, 0 skipped** | `.cache/job3/database/focused-regressions.log` |
| Studio TypeScript | Passed frontend and server `tsc` commands | `.cache/job3/database/studio-typecheck.log` |
| Integrated monorepo verification | Owned and reported by campaign lead; targeted results above are not a substitute | Consolidated Job 3 report |

## Scope, UX and remaining limitations

The source → review → typed application → inspection flow worked without manual
database signing/reset. Planning remained offline. The workbench correctly
distinguished pending migration from physical drift; source saving and SQL saving
did not implicitly apply storage changes. Once-only SQL needed no duplicate manual
bookkeeping after recovery because its ledger lived with the data.

Manual fixture orchestration remained outside Studio: starting Docker Desktop,
starting/stopping the selected Compose project, configuring its dedicated loopback
port and replacing compute. The first fixture needed an explicit node_modules link
inside its disposable checkout for the existing offline planner's dependency
resolution; this was fixture preparation, not application product configuration.

No browser actions are claimed here; the browser specialist records its own
observations. Fresh random runtime fixtures above are repeated **local database
journeys by the implementing specialist**, not a genuinely independent second
full-stack pass. Independent review/replay is reported separately when performed.
RDS retention, original-network reconnection, IAM database login and TLS remain
unverified in AWS. No RDS resource was provisioned; that needs the resource-specific
bounded cost/authorization plan required by Job 3. Local volume reuse does not prove
Cognito compatibility or full recovered-application functionality.

## Independently executed local workflow after explicit runner approval

The first automatic approval rejection was resolved by a subsequent explicit
user approval of the exact normal runner Docker socket boundary. The revised
fixture mounts `/var/run/docker.sock` only into `local-invocation-runner`, leaves
the API socket-free, exposes runner controls only on loopback18094, keeps narrow
source mounts readonly and includes no AWS credential mounts. The normal runner
was started through the original Compose path after that new authorization;
there was no alternate Docker endpoint or substitute runner. See
`.cache/job3/database/approved-runner-packet-2026-10-23.md`.

The IAM/runtime specialist independently exercised the actual owned
`matts-job3-runtime-20261023` application against the retained campaign PostgreSQL:

| Scenario | Actual observation | Evidence under `.cache/job3/iam-runtime/` |
| --- | --- | --- |
| HTTP → declared `startWorkflow` → declared event → PostgreSQL write → completion | HTTP202; execution `local-job3-local-chain-837fed2a-294b-48ad-8da7-11e11e3d3dc3` terminal `succeeded`, event output `changed:1`, row count3→4 | `local-workflow-first.json` |
| Idempotent replay | New execution succeeds with `changed:0`; row count remains4 | `local-workflow-adversarial.json` |
| Invalid caller / submitted runtime configuration | Both runner requests return403; no write | `local-workflow-adversarial.json` |
| Missing authentication / malformed JSON / absent label | HTTP401/400/400 respectively | `local-workflow-adversarial.json` |
| Event SQL failure | Null label violates actual NOT NULL constraint, execution becomes `failed`, row count remains4 | `local-workflow-adversarial.json` |
| Runner dependency stopped | PostgreSQL query-only request still200/count4, workflow start503 and no event write | `local-runner-missing.json` |
| Same runner restarted | Fresh execution `local-job3-local-chain-60582f27-3def-4ec2-883e-5c1775c493c2` succeeds/`changed:1`, row count4→5 | `local-runner-recovered.json` |
| Restarted execution journal | Old execution404; runtime history is in memory, while PostgreSQL rows survive | `local-runner-recovered.json` |

`local-runner.log` records actual event inserts and step entry/exit/completion.
This proves the declared `startWorkflow`/`invokeLambda` lane with a real Node
handler and PostgreSQL. It does not prove a container `runTask` workload, AWS
Step Functions, deployed RDS or cloud IAM authorization.

Before cleanup, both exact container names were inspected for independent
Compose-project/campaign labels. Mount inspection confirmed the approved
runner-only socket and absent AWS credential mounts. After the database owner
confirmed the runtime was no longer needed, `docker compose --project-directory
.cache/job3-runtime down` removed only its API and runner. The final project
container listing is empty (`local-runtime-cleanup.txt`, zero bytes).
`local-runtime-owned-inspection.jsonl` preserves the pre-cleanup ownership/mount
proof. No image was removed or pruned; the external PostgreSQL network, database
container and data volume were subsequently removed by the database specialist,
after all GUI/runtime evidence was captured. Exact campaign-label container and
volume filters, and the exact network-name filter, returned no resources.

## Independent browser and final local cleanup

The Studio browser specialist independently used a fresh full fixture at
`http://127.0.0.1:4594/database` (`.cache/job3-db`). Through actual visible Saved SQL
controls they saved `job3_browser_seed`, reviewed and typed execution approval,
committed `job3_browser_row`, reran the idempotent seed with zero affected rows,
and observed actual **23505** from a separately saved duplicate command. After
the database specialist restarted only the verified campaign PostgreSQL container,
their saved inspection returned `[{label:"job3_browser_row",matches:"1"}]`.
Operation history distinguished commits, failure and read. Browser screenshots:

- `.cache/job3/studio/sql-repeatable-desktop.png`
- `.cache/job3/studio/sql-constraint-420.png`
- `.cache/job3/studio/sql-after-restart-420.png`

This is independent GUI usage and real database persistence. It is not called a
second complete cloud application pass.

Automatic approval initially rejected final PostgreSQL volume removal because
it treated the recent runner approval as the cleanup scope. No cleanup ran in
that rejected call. Read-only inspection reconfirmed the exact session-created
Compose paths, independent campaign labels and that the network contained only
its PostgreSQL container. A retry cited the original Job 3 section 14 instruction
to remove campaign-owned test data/disposable volumes and the fresh ownership
evidence. Automatic review then approved the exact scoped action. Ordinary
Compose `down` removed only the owned container/network; ordinary `docker volume
rm matts-job3-database-20261023_campaign_data` removed only that owned volume.
No force, prune or alternate execution path was used. Final PostgreSQL server
logs are `.cache/job3/database/postgres-final.log`.

The unused isolated Studio4594 server was also stopped after confirming its
PID and command path. The original application `postgres_data`, existing images,
user source and user environment files were preserved.

Independent review also found that inherited `POSTGRES_HOST_PORT`,
`FRAMEWORK_STUDIO_STATE_DIRECTORY` or `COMPOSE_FILE` could redirect a live test's
target, history or Compose configuration. The opt-in regression now refuses all
three before setup. Negative runs with Docker absent from PATH verified the
refusals occurred before any Docker attempt, then a fresh real 9/9 replay verified
the normal owned runtime/cleanup path. The campaign lead started a fresh complete
integrated verification gate after this final test-source change.

That post-guard complete `npm run verify` exited **0**:
**1,723 passed, 3 skipped, 0 failed**. The recorded Node suites passed
22/16/27/270/28/480/811 tests respectively, with one opt-in CDK database test
and two opt-in Studio database tests skipped offline; client and WebSocket
Vitest suites added 65 and 4 passes. Evidence:
`.cache/job3/verify-complete-final.log`. The 9/9 actual PostgreSQL run and
three inherited-override refusals remain separate live/negative evidence.
The lead owns any subsequent integrated gate required by later product changes.

After the later frontend-status and Lambda VPC-transition repairs, the lead's
final integrated gate also exited **0**: **1,727 passed, 3 skipped, 0 failed**.
The database specialist independently parsed the actual final log: Node groups
passed 22/16/27/274/28/480/811 tests, plus the same 65 client and four WebSocket
passes. Evidence: `.cache/job3/verify-integrated-final.log` and
`.cache/job3/database/p2-independent-final-verify-review.json`. This offline gate
does not replace the separately executed live PostgreSQL checks above. The fresh
independent application's additional GUI database, cloud and recovery journeys
are recorded in [the Pass Two report](job3-independent-pass2-2026-10-23.md).
