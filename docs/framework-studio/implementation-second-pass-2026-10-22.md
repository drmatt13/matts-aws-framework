# AWS Studio implementation and second pass — 2026-10-22

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

This implements the four work packages in the [product audit](product-audit-2026-10-22.md). The audit remains a record of the earlier behavior; this document records the resulting implementation and its verification boundaries.

The implementation started from a clean working tree. Tests used `AWS_PROFILE=dev`, synthetic deployment inputs and disposable projects. No cloud infrastructure was deployed or deleted, no live database was changed, and the shared Docker environment was not started. The existing Studio process on port 4590 was preserved; browser tests used isolated servers on 4591/4592.

## What changed

Studio `server/`, `shared/` and `src/` paths below are relative to `framework-studio/`.

| Audit findings | Implemented behavior | Principal implementation |
| --- | --- | --- |
| F01, F08 | Ordinary local startup verifies database compatibility without migrations, pruning, seeding or Cognito writes. Those jobs require explicit actions. Local success waits for required services; failure explains what may remain running and the next recovery step. | `scripts/dev.mjs`, `docker-compose.yml`, `server/deploy/local.ts`, `server/deploy/registry.ts` |
| F02–F05 | Teardown reviews deployed stack identities, templates, imports, termination protection and retention policies. Missing evidence blocks it. Approval binds a saved expiring review; deletion uses immutable stack IDs and rechecks each dependency phase. Saved deployment application/discard and explicit deployed-target teardown do not require current declarations to evaluate. Stacks absent from current synthesis remain visible as retained deployed infrastructure. | `scripts/destroy.ts`, `scripts/deploy.ts`, `scripts/deployment-review.ts`, `server/deploy/*` |
| F07, F08, F15, F16 | Deploy owns its destination selection. Destination-aware evidence keys, timestamps, visible analysis uncertainty, review-first development deployment, inspectable template effects and separate CloudFormation change-set preparation replace implicit guarantees. Failed, unconfirmed, partial and output-export-failed outcomes remain actionable. Saved assemblies bind asset bytes as well as templates. | `src/views/Deploy.tsx`, `src/views/deploy/*`, `scripts/deployment-integrity.ts`, `scripts/deployment-artifact.ts` |
| F06, F10 | Canonical implementation-artifact checks run against the proposed file overlay. Creation and missing-file repair use the configured path, preview each new file and preserve existing bytes. Ordinary supported edits also run the real generators in isolation and review their complete output. | `packages/framework/src/config/source.ts`, `server/implementation.ts`, `server/edits/implementation-scaffold.ts`, `server/edits/batch.ts` |
| F11 | Purpose-based connections cover database IAM access, user-pool identifiers, task/workflow/agent/tool bindings, inputs/secrets and scoped bucket/queue grants. Tool creation and a private retained bucket template are available. Supported workload removal checks consumers and reviews an exact implementation archive; cloud removal remains separate. | `server/edits/connections.ts`, `server/edits/removal.ts`, `src/views/WorkloadActions.tsx` |
| F09, F12 | Offline Prisma planning includes imported configuration dependencies. Local and production empty-database initialization require reviewed SQL, target confirmation and repeated emptiness checks. Operation records preserve failure stages and recovery guidance. Production inspection/application uses the versioned IAM migration task with destination, source, SQL and physical-state guards. | `server/database-*.ts`, `packages/database/scripts/configuration-inputs.ts`, `packages/database/scripts/studio-migrations.ts`, `cdk-app/ecs_containers/tasks/db-migrate/*` |
| F13, F14, F18 | Native watcher failures become visible; polling, reconnect refresh and manual reload preserve source freshness. Accurate multi-hunk diffs preserve unchanged lines. The map has a searchable resource navigator and node-level implementation diagnostics, without altering identity or layout when filtering. | `server/watch.ts`, `shared/source-diff.ts`, `src/views/Isometric.tsx`, `src/views/Shell.tsx` |
| F17 | Source batches and resource-catalog writes journal before mutation. Interrupted transactions can restore matching files or retain reviewed current source; later edits are preserved. Deployment and database operations persist effect/outcome records. Unknown locks fail closed rather than being automatically reclaimed. | `server/edits/journal.ts`, `src/views/SourceRecovery.tsx`, `server/database-operations.ts`, deployment journal/lock helpers |

## Second-pass findings and corrections

The second pass deliberately crossed boundaries that isolated planners cannot establish:

1. **GUI repair was rejected by the HTTP parser.** Creation and repair planners passed, but the first actual browser repair encountered an old operation whitelist. The transport and planner now share strict operation parsing. The retry reviewed and applied the authenticated handler at its configured path, preserved an existing README, undid the repair, and refused a subsequent stale proposal after an external handler edit.
2. **An active source transaction looked interrupted, and checking before saving did not exclude another process.** An exclusive checkout source lock and shared active-transaction guard now exclude live operations from recovery. Recovery has its own lock and preserves later edits. A competing-process barrier proves only one writer acquires ownership; a process-kill test covers genuine interruption after the first write. Legacy single-edit APIs use the same journaled, generator-complete writer.
3. **A symlinked parent bypassed watcher root checks.** A non-linked child underneath a linked `cdk-app` parent was being watched as checkout source. Every root component is now checked; the linked root is visibly unavailable, never scanned, and recovers when restored to a real directory.
4. **Automatic stale-lock reclamation could steal a new lock.** Unknown/dead deployment and database locks now require deliberate recovery after inspection. Unique ownership tokens prevent an old operation from releasing a replacement lock.
5. **Production inspection must never launch the old write-only migration task.** Read-only metadata preparation checks the deployed protocol before task launch. Reviewed application pins the task-definition revision, source inputs and destination, and rechecks database state under the migration runner's database lock before DDL.
6. **A fresh production database had no usable initialization path.** Missing history now offers a separately confirmed additive initialization only after proving the database empty. The writer repeats that proof inside the same transaction and canonical advisory locks. Populated, partially initialized or otherwise unknown storage remains blocked. Inspection also revealed that Prisma's display preview omitted parameters, checks and non-DDL statements: review now captures the complete native runner input without executing it, previews every phase, and binds its exact digest and control-table DDL before application.
7. **Repeated snapshot failure could hide the source outcome.** Failed rollback refresh now preserves the applied/restored/unconfirmed source classification and reports snapshot unavailability instead of throwing away the result.
8. **An internal asset symlink could change without changing file bytes.** The saved assembly digest now includes link identity as well as target content and permissions; escaping links are refused. Deletion tests also moved their state into disposable roots after parallel execution exposed a shared-fixture lock collision.
9. **The task review implied private placement that the declaration did not guarantee.** The existing migration task inherits public-subnet placement and can receive a public IP; its database remains private and IAM-authenticated. Reviews now display the actual cluster, subnets, security groups, public-IP assignment and log destination. Both inspection and application bind those settings, so a changed launch descriptor requires another review. Existing networking was preserved.
10. **The new journal rejected supported native CDK edits.** Complete trigger fixtures exposed a mismatch between native-edit authority and starter-file authority. Journal records now retain narrow authority per file, so validated native edits and generated files can share one recoverable batch. Restoration revalidates both authorities; HTTP requests do not gain arbitrary file access. Older conflict assertions and incomplete generator fixtures were also updated, with guaranteed cleanup to prevent cascading test failures.

## Developer outcome

| Persona | Result after implementation | Remaining boundary |
| --- | --- | --- |
| Frontend developer / authenticated issue tracker | Can create or repair an authenticated handler, attach the database, review source/generated output, discover local initialization and separate it from startup/deployment. | Application authorization, repositories, GraphQL operations and React behavior still require application code. Providing user-pool identifiers alone does not implement authentication. |
| Full-stack developer / invoice SaaS | Can create a retained private bucket, service/task, secrets and supported permission/binding declarations; review changes and source archives; distinguish development and production actions. | Business logic, unsupported native-resource adapters and live release verification remain explicit engineering work. |
| AI developer / agent and tools | Can create a runnable model-free echo agent and typed tool, review their contracts/files and add supported bindings. | Real model credentials/access, provider behavior and deployed AgentCore compatibility require separate runtime verification. |
| Backend developer / events, containers and workflows | Supported declaration changes include generated artifacts; missing implementations have actionable diagnostics; code-owning removal preserves source in an archive. | Custom image-Lambda adapters, application-specific partial contracts and unsupported source shapes deliberately require source editing. |
| Infrastructure engineer / existing deployment and recovery | Can inspect retained stacks, review exact teardown scope independent of current source, and distinguish verified, failed and unconfirmed outcomes. | Cloud operations and recovery against real deployed resources were not executed in this implementation. |

## Verification

Raw logs, screenshots, synthetic assemblies and comparison scripts are kept outside the checkout in `/private/tmp/studio-implementation-20261022/`. Test counts below describe individual suites and may overlap; they are not summed as unique coverage.

| Check | Result |
| --- | --- |
| Framework generation and npm 11 lock synchronization | Passed; existing pinned Prisma toolchain dependency added without a version upgrade. |
| Explicit development and production CDK CLI synths | Passed with `--profile dev --no-lookups`, synthetic input files and disposable output directories. Production explicitly enabled WebSocket synthesis. |
| Baseline/current template identity comparison | Passed for 3 development and 11 production stacks: stack names, logical IDs and output IDs preserved, including `AsynchronousLambdaFunctionsStack`. After normalizing asset references, the only resource-property difference is `DATABASE_REVIEW_PROTOCOL=1` on the existing migration task. The network template is byte-equivalent; no VPC/interface endpoint configuration was added. |
| Actual Chrome: source creation → review → apply → map → undo | Passed in the disposable project. |
| Actual Chrome: missing-folder/partial repair, existing-file preservation, undo and external-source conflict | Passed after correcting the HTTP parser; no external edit overwritten and no browser exception. |
| Actual Chrome: task connection and workload removal | Passed in the disposable project: review/apply adds the map connection; undo removes it; removal reviews declaration/generated changes and exact source archive; apply removes target/route; undo restores them. |
| Actual Chrome: destination/plan/teardown layout and approval guards | Passed with mocked AWS responses at desktop and 420px; no mutation endpoint invoked. Actual development-profile observation was read-only. |
| Actual Chrome: production database and source recovery | Mocked destination/network check → separately confirmed inspection → SQL review → separately confirmed migration application and distinct empty-database initialization passed. Public-IP assignment is visible. Recovery controls preserved the inspector at 1440/700/420px. No overflow or browser exceptions; all operation responses were mocked. |
| Actual Chrome: map search/selection/mode switch, network draft/discard, database source/status/history and creation forms | Passed; narrow layouts did not overflow. Database tests did not invoke live writes. |
| Studio production build | Passed into a disposable directory; Vite reported the existing advisory for chunks above 500 kB. |
| Targeted deployment and recovery checks | Parallel fake-AWS CLI suites 16/16; final asset integrity/recovery 4/4; independent production database task/initialization review 10/10. Final database/network UI and approval guards 25/25, with Studio/database typechecks passing afterward. |
| Native editing and conflict follow-up | Complete trigger suites 16/16; affected transaction cases 10/10; mixed native/generated journal authority tests 2/2. Product validation stayed enabled in the repaired fixtures. |
| Documentation and whitespace | Knowledge checker passed: 28 pages, 545 local links, 148 source references; `git diff --check` passed. |
| Full repository verification | `AWS_PROFILE=dev npm run verify` passed, exit 0: platform lock checks, framework/GraphQL generation checks, database artifact generation, all workspace typechecks, schema tests and workspace suites, including **698/698 Studio tests** with no skips. |

The explicit CLI synth commands were `npm --workspace cdk-app exec -- cdk synth -c prodDeployment=false --profile dev --no-lookups --output <disposable-dev> --quiet` and the production equivalent with `-c prodDeployment=true -c deployProdWebSocketApi=true`. A separate baseline/current assembly comparison skipped asset bundling to compare identities consistently; the CLI runs independently exercised ordinary synthesis and local bundling.

## Operational limits and release follow-up

Production database inspection is itself an explicitly authorized, billed task launch; migration application is a second action. The new task protocol must be separately reviewed and deployed before Studio can use it. Older deployed tasks are rejected before invocation. The task uses its declared VPC networking; public task placement does not expose the private database. No public database ingress, password authentication or new interface endpoint was introduced.

Restart the existing Studio server on port 4590 to load the updated backend and protocol. The isolated verification servers and Chrome instance have been stopped; the shared server was not restarted or stopped.

Docker image builds/running application behavior, task IAM/TLS/CloudWatch delivery, real database DDL/recovery, cloud deployment/cancellation/deletion and provider integrations remain unverified live. Offline tests and synths cannot establish those outcomes. Source recovery covers the supported source transaction boundaries; it does not make secret-value editing, database writes or CloudFormation operations one atomic transaction. Undo/redo history remains process-local, while interrupted source recovery is durable.

Guides and knowledge pages describe the implemented contracts rather than promising general-purpose code editing. Unsupported custom source shapes fail with a source handoff; automatic repair never overwrites an existing implementation.
