# AWS Studio product audit and implementation plan

Date: October 22, 2026. Scope: the working tree at commit `73604fa`, including the pre-existing Studio UI/documentation edits. No product code was changed. All source application experiments used disposable copies. Explicit AWS checks and the primary browser used profile `dev`, account `734849394764`, region `us-east-1`, for identity/status reads only. A secondary tab initially restored `default` before switching to `dev`, potentially initiating automatic reads against the same account. No cloud resources, change sets, models, databases, or Docker services were started, deployed, modified, or deleted.

**Assessment:** Studio has a strong source-review foundation and useful architecture views, but developers cannot yet depend on it for a complete application lifecycle. The largest problems are incomplete deployment reconciliation/recovery, undisclosed database/auth effects behind local startup, and configuration approval that does not establish implementation readiness. Prioritize these correctness and operational-boundary defects before expanding the map or adding more individual settings.

Fresh conventional workload creation already supplies starter code. The missing required capability is **repairing the actual configured implementation path of an existing declaration**, including partial scaffolds and runtime/package changes. Teardown already reads deployed identities without synthesizing current workloads; its remaining source coupling and incomplete consequence evidence need fixing.

## Evidence and boundaries

Started with `git status --short`, then read `AGENTS.md`, `README.md`, `docs/FRAMEWORK.md`, the knowledge router, and relevant subsystem guides/source. The initial 28 modified paths covered Studio views/styles/tests and six documentation/knowledge files. These were preserved. The audit evaluates that current implementation, not an older committed UI.

The specified `127.0.0.1:4590/isometric` was unavailable. Separate Studio instances ran on **4591** against the shared checkout for inspection/preview and **4592** against `/private/tmp/aws-studio-editing-audit-p7xhEm` for source application. A disposable Chrome profile exercised the real UI. Docker was independently confirmed stopped. Source writes and deployment operations were blocked in the inspection browser; only reviewed creation/apply/undo endpoints were enabled on the copied project's origin. Existing deployed projects were simulated with fake AWS and actual repository CLI scripts. Thus real cloud release/recovery and application runtime success are not claimed.

Evidence notation: **B** = real browser; **F** = executed isolated fixture or actual CLI with fake AWS; **T** = existing regression tests; **S** = implementation inspection; **U** = unverified live behavior. A source-backed risk is distinguished from a reproduced failure below. Test-harness errors and host limitations are recorded separately.

Raw evidence, screenshots, and replay scripts are in `/private/tmp/studio-product-audit-20261022-root/`. Deployment probes additionally use `/private/tmp/aws-studio-audit-{deploy,plan}-proof.mjs`; workload probes use `/private/tmp/aws-studio-{artifact,generated}-audit.cjs`. These are disposable evidence, not new product APIs or permanent repository tests. Abbreviated `src/`, `server/`, `shared/` and `test/` locations below are relative to `framework-studio/`; other paths are repository-relative.

## Actual authority and execution flow

| Stage | Current authority and effects |
| --- | --- |
| Declaration → snapshot/map | `SnapshotBuilder` evaluates the literal TypeScript composition in separate dev/prod processes; normalization, source indexing and bounded CDK inference produce the graph. This does not synthesize, build handlers or observe runtime health. |
| Editor → proposed diff | `InspectorDraft` stages typed intents; batch/resource/input planners splice bounded source spans and evaluate overlays. Creation runs real generation in a disposable copy and includes new implementation files. Ordinary edits have narrower checks/output handling. |
| Validation → source application | Both-mode configuration checks, selected TypeScript checks and before/after hashes guard application. The transaction writes reviewed bytes, refreshes/rechecks the model and compensates on failure. These checks currently miss some implementation artifacts (F06). |
| Generated artifacts → application | Framework generator owns target IDs, API/agent contracts, service environment examples and Compose. Prisma generation and GraphQL/data propagation have their own sequence. Their currency is separate from a valid declaration graph; ordinary edits do not uniformly finish generation (F10). |
| Local execution | Exported development outputs/resource manifest configure the same declared workloads through local API/WebSocket/invocation adapters and Compose. Running them needs Docker and some real AWS dependencies. Starting Compose also invokes database/auth jobs (F01). Task/workflow acceptance is not terminal success. |
| CDK/deployment | Synthesis builds templates/asset references for a selected target. Repository deploy scripts check account/ownership, prepare template/change-set reviews, bind plans/secrets/state and execute approved artifacts. Production can defer stacks until dependencies exist. Completion, verification and export are distinct outcomes. |
| Database | Prisma exact-text session is a separate authority: validate/review/save source, emit artifacts, plan offline migrations, install reviewed files, inspect selected DB, then separately authorize application. No graph switch selects a live database. |

This trace explains why a successful click, a green graph, generated files, a started process and a verified release are different product states. The recommendations expose those states without requiring users to learn the implementation pipeline first.

## Developer journeys

“Complete” means the intended application works, permissions and ownership are explicit, source/generated state agree, deployment effects are understood, and update/removal/recovery have an identified next step. A valid graph alone does not meet that definition.

| Persona and product | Starting knowledge and constraints | Success definition | Actual outcome and first necessary source handoff |
| --- | --- | --- | --- |
| Frontend developer: private issue tracker, fresh product on the supplied starter | React/TypeScript, little AWS; authenticated users own their tickets; preserve data across restarts | Sign in; create/list/archive/delete own tickets; run locally; review a production release | **Partial.** Can inspect the starter, create an authenticated Lambda, edit/validate Prisma, and review SQL. Database attachment, ownership-aware repositories/GraphQL exposure/client operations require source. No reviewed first-database initialization; local startup is not a harmless prerequisite action. |
| Full-stack developer: invoice SaaS, fresh product then second release | Comfortable APIs/SQL, limited CDK; private uploads, tenant data, PDF background task, separate dev/prod, small development budget | Wire bucket/database/task, configure secrets and sessions, run locally, add an invoice field, deploy/update safely | **Partial; GUI journey blocked.** Service/task/secret creation works. New bucket/native grants, database binding, invocation edges and application behavior require source. Production database execution exits Studio. Source removal cannot establish that old deployed stacks or costs disappeared. |
| AI application developer: tenant case assistant | Knows model SDKs, little IAM; authenticated document lookup, private storage, provider secret, async summaries; avoid paid inference during setup | Own agent and tool, validated request/response, least-privilege storage/secret access, local conversation and reviewed release | **Partial.** Agent creator has model/tool scaffolding and existing-tool selection. No new-tool wizard, storage/grant authoring or complete async wiring. Default starter invokes a provider when run. Missing implementation recovery is absent. No model calls were made. |
| Backend developer: telemetry export service, existing app | Knows Lambda/ECS/events, new to this DSL; local service, queue Lambda, export task, scheduled workflow; retain deployed identities | Create and connect workloads; run a task/workflow to terminal success; change route/packaging; remove safely | **Partial.** Conventional scaffolds and a sequence of existing Lambda/task steps work. Advanced bindings/removal need source. Packaging can be approved with no Dockerfile; route rename leaves generated browser contracts stale. Local/cloud terminal execution was not attempted. |
| Infrastructure engineer: operate the invoice SaaS after substantial declaration changes | Understands IAM/VPC/CloudFormation; exact account/region, reproducible reviewed updates, no surprise costs/data loss | Reconcile deployed vs desired, inspect replacements/security, recover partial updates, delete retired deployment without rebuilding current source | **Not dependable yet.** Identity guards and saved-plan checks are substantial. Removed whole stacks are omitted from comparison, current-source failures block saved-plan cleanup, teardown loses uncertainty and is not bound to reviewed scope. |

Each persona began with the same Docker-stopped GUI and prerequisite path. The fresh-project case is a new product within this framework starter, not an unsupported empty directory. Subsequent releases, drift, removed/renamed stacks, failures and stale reviews used existing fixture applications and deployed-state simulations. Implementation knowledge was used to diagnose what the GUI revealed; it was not credited as discoverable persona knowledge.

## Workflow coverage

| Journey segment | Exercise | Result and remaining limit |
| --- | --- | --- |
| Open with Docker stopped | B: Board, Isometric, Database, Deploy; actual stopped engine | **Pass.** Both configuration graphs load. `/deploy` names dev/account/region and Docker remedy. No cloud stack exists for the selected actual target; stale exported settings are called out. |
| Prerequisites and startup | B/S/T: tools, profiles, Docker remedy, startup registry/Compose trace | Discovery **passes**; startup has undisclosed writes and no final application readiness gate (F01/F08). Actual startup intentionally not run. |
| Fresh workload creation | B: function/service/task/agent/stack forms; authenticated function full preview; F/T: all ten creators | **Pass within templates.** Declaration, starter, generated files and manifests appear in review. No arbitrary configured-folder/repair or tool/bucket creator. |
| Review → apply → registration → map → undo | B/F: authenticated HTTP Lambda in copied project; exact file/map inspection | **Pass.** New canonical target selected; generated contracts included; undo removes files and map node. Selection remains on an absent-node message after undo, a minor polish gap. |
| Bindings, auth, secrets, DB/network scope | B/S/F/T: creator choices, authenticated starter, protected inputs, placement/consumer edits | Scoped existing editors **pass**; general grants/database/session/invocation authoring unavailable. IAM/session/tenant behavior not live-tested. |
| Toggle settings and invalid intermediate edits | B/F/T: endpoint preview/discard; packaging; placement, defaults, runtime, auth and trigger fixtures | Guarded drafts largely **pass**. Artifact-incompatible packaging incorrectly passes (F06). No Docker build/runtime claim. |
| Rename/move/remove | F/T: HTTP route rename, catalog moves, native trigger/VPC deletion and dependent refusal | Supported source transforms preserve identities/unrelated text. Route projections go stale. General workload rename/move/removal remains source-owned. Whole deployed stack retirement is invisible in planning. |
| Stale review/external edit/failure | F/T: hashes, concurrent edit, rollback, partial writes, undo, snapshot retry | Guards **pass**. Sandbox watching failed with `EMFILE`; normal watching works outside the restriction, but Studio hides watcher errors. Crash recovery is compensating restoration, not a durable transaction. |
| Map connections/environment switch | B: real map and same selection/camera across dev/prod, 420px inspector; F/T: edges/deletions/aggregation | **Pass for exercised projections.** Source graph is not live deployment/health; missing artifacts still look valid. No broad visual regression at 1440/420 observed. |
| Database source/invalid draft | B/F/T: installed Prisma, invalid type, retained diagram, review/conflict fixtures | **Pass.** Precise `PSL_UNRESOLVED_REFERENCE` at line 3; invalid draft retained and save blocked; discard explains no DB change. |
| Schema → generation → application access | B/S/F/T: emitted evidence and downstream recipe | Source/generated/database distinctions exist, but regeneration and repository/GraphQL/client work are a manual handoff. |
| Migration plan/review/install | F/T: real pinned Prisma in disposable workspaces, SQL, destructive/required-field cases, reviewed artifacts | **Pass for standard config.** Imported local Prisma config helper breaks planning (F09). No database contacted. |
| Local DB evidence/application/recovery | F/T: target/marker/drift/path/typed approval/runner failures | Conservative guards **pass**. Unmarked init unavailable; failure details too weak. No live database writes. |
| Production DB lifecycle | B/S: static unavailable target, private IAM/TLS task boundary | **Unavailable in Studio.** No named production database inspection or application; no live tests. |
| Deploy plan/apply/update/partial/cancel | F/T: real wrappers + fake AWS; B: mocked review/outcomes | Existing guards and normal flows **pass**. Reconciliation, cleanup and outcome gaps below reproduced. No real AWS change sets or deployments. |
| Teardown after source divergence | F: throwing/deleted source, replaced target catalog, denied consequence reads | Broad synth hypothesis **disproved**. Narrow target-catalog coupling and false-empty consequence evidence **fail**. No deletion sent to live AWS. |
| Dev/prod infrastructure synthesis | T: creation fixture's explicit dev and prod synth, no credentials, bundling disabled | **Pass.** Proves template construction/registration, not image execution, live permissions, data safety or deployed identity continuity. |

## Prioritized findings

P1 means fix before relying on this workflow for data/infrastructure changes; P2 blocks or materially confuses a common journey; P3 is usability or supporting-documentation polish. Likelihood describes the triggering situation, not a measured incidence rate. Findings are ordered by operational consequence, then reach.

| ID | Priority | Likelihood | Blocking scope |
| --- | --- | --- | --- |
| F01 | P1 | High | Local startup can change/delete data and mutate dev Cognito without showing those effects |
| F02 | P1 | Medium | Teardown preview presents unreadable consequences as empty |
| F03 | P1 | Medium | Teardown approval does not bind the reviewed destructive scope |
| F04 | P1 | High during evolution | Removed whole stacks omitted; false `no-changes` convergence |
| F05 | P1 | Medium | Broken/evolved current source blocks saved-plan cleanup or explicit retired-target deletion |
| F06 | P1 | High for imported/moved code | Approved configuration can be unrunnable; missing implementation has no repair |
| F07 | P2 | Medium with multiple destinations | Split destination authority and incomplete cache keys mix evidence |
| F08 | P2 | High when operations fail | Unverified cloud result and premature local success obscure recovery |
| F09 | P2 | Medium with custom Prisma config | Valid schema configuration cannot plan a migration |
| F10 | P2 | High for ordinary edits | Applied route/config edits leave generated artifacts behind |
| F11 | P2 | High | Core app wiring/removal needs an unexplained code handoff |
| F12 | P2 | High for new projects/failures | DB initialization, production targeting and failure recovery incomplete |
| F13 | P2 | Environment-dependent | Watch failure is silent; source/map freshness becomes unknowable |
| F14 | P2 | High for batched/generated edits | Sparse edits appear as large rewritten blocks |
| F15 | P2 | Medium | Development auto-apply ignores consequential uncertainty/cost cases |
| F16 | P2 | High for review | Security/property/data effects cannot be assessed from review alone |
| F17 | P2 | Low, severe on interruption | Multi-file source transactions lack durable crash recovery |
| F18 | P3 | High | Overview density, terminology and stale docs impede discovery |

### F01 Local startup hides database and identity writes

**Evidence S/T.** With exported development settings, `/deploy` → **Start development**, **Export and start development**, or **Apply changes** dispatches `scripts/dev.mjs`. Compose runs migrations, orphan-user pruning, then test-user seeding. `PRISMA_LOCAL_SCHEMA_SYNC=push` selects direct `db:update --confirm app_db`. Pruning deletes users absent from the selected Cognito pool; owned projects have cascading deletion. Seeding may create a real development Cognito user and set its password.

Expected: show and separately authorize the selected database changes and identity effects. Actual: registry calls the step **Generate and start containers**; the start button has no SQL/data/identity review. The Database status page itself warns that starting Compose can migrate and clean data, establishing an inconsistent approval boundary. This is not a claim that the migration runner lacks its own safeguards. **Local startup was not executed.**

Locations: `src/views/Deploy.tsx:187-190`, `server/deploy/registry.ts:303-310,348`, `scripts/dev.mjs:139`, `docker-compose.yml:159-215`, `packages/database/scripts/prune-cognito-orphans.ts:49`, `packages/database/scripts/seed-test-user-cli.ts:70,96`, `packages/database/prisma/contract.prisma:23`, `src/views/DatabaseEvidence.tsx:98`.

Fix: separate **Start local services**, **Review local database changes**, and **Set up test identity**. If compute requires pending migrations, pause at that explicit gate. Make orphan cleanup opt-in with affected user/project counts. A generic start/restart must not silently authorize direct schema push or cascading data cleanup.

### F02 Teardown turns denied reads into empty consequences

**Reproduced F.** Fake an owned deployed stack with an external importer, retained S3 bucket and managed secret. Deny `list-imports`, `get-template`, and `list-secrets`; run `destroy.ts --deployment retired-app-prod -c prodDeployment=true --profile dev --region us-east-1 --plan --json`. It exits **0**, with empty `importedBy`, `remains`, and `secrets`, and no uncertainty warning.

Expected: unknown retention/dependencies are explicit blockers. Actual: blanket catches assume “no imports,” “failed create has nothing to retain,” or no secrets. This makes the deletion review unsafe to trust even if CloudFormation later refuses a dependency. Locations: `scripts/destroy.ts:90-117`; replay `/private/tmp/aws-studio-audit-deploy-proof.mjs`, case `consequence-reads-denied`.

Fix: typed per-read evidence (`known/absent/unreadable`) with safe AWS error classification; block destructive execution when required dependency/template evidence is unknown. Name external importers as blockers. Optional inventory failure must remain visible rather than becoming zero.

### F03 Teardown confirmation is not tied to the reviewed stack set

**S, missing binding verified; concurrent-state race not executed.** Open deletion review, then change AWS state or remap the profile before confirming. GET returns no saved plan/digest/expiry; POST supplies name/mode/profile/region/typed name; the CLI discovers a fresh set. An added owned stack or changed policy can therefore alter scope without re-review.

Expected: delete the exact reviewed deployed identities and consequences, or refuse changed scope. Locations: `shared/deploy.ts:247-257`, `src/views/Deploy.tsx:289-300`, `scripts/destroy.ts:176-187`.

Fix: saved teardown review binding resolved account/region/mode/name, immutable StackIds, templates/policies/dependencies, timestamp and fingerprint. Recheck before execution and each dependency phase. Expire/refuse changes; lift termination protection only after all gates. Typed name alone is not a scope digest.

### F04 Deployment comparison omits stacks removed from source

**Reproduced F; review wording S.** Deploy-state fixture contains unchanged `audit-dev-CurrentStack` plus owned `audit-dev-RemovedFromSource` with S3 resources. Current assembly contains only CurrentStack. Actual wrapper reports `no-changes`, one stack, no retired-stack warning; review says **“AWS already holds exactly this. Nothing to apply.”**

Expected: show the deployed stack absent from current source and explicitly retain it pending a separate removal review. Actual: comparison iterates only current assembly stacks. Source/map removal does not establish resource deletion, cost removal or convergence. Locations: `scripts/deploy.ts:271-272,291-303,386-399`, `src/views/deploy/PlanReview.tsx:87-88`. Replay: `/private/tmp/aws-studio-audit-plan-proof.mjs`.

Fix: reconcile desired stack identities with the complete owned deployed set. Keep removed stacks by default; surface their exact identities, dependencies, data and ongoing-cost consequences. Never automatically delete them because a declaration disappeared. Qualify subset/no-change statements precisely.

### F05 Current source unnecessarily blocks recovery artifacts

**Two reproduced F failures; broad synthesis hypothesis disproved.** (1) Make a saved plan, then change only fixture `framework.config.ts` to throw `SOURCE_CHANGED_AFTER_REVIEW`. Both `--apply` and `--discard` stop at that exception. (2) Deleting a retired production deployment with explicit name/mode/region fails if current `cdk.json` contains two different production targets, or is malformed. The multi-target error asks for `-c deployment` despite Studio already providing `--deployment`.

Counterexample tested: throwing workload declarations and removed CDK source **do not** prevent teardown planning. `destroy.ts` discovers deployed ownership and dependencies without synth. Preserve that design.

Expected: discard depends on plan-owned review identities; explicit teardown depends on deployed identity; applying an immutable saved artifact can distinguish its reviewed revision from newer source. Actual: `scripts/deploy.ts:545-550` imports/validates current source before dispatching apply/discard; `destroy.ts:166-171` resolves current targets before honoring explicit deployment. Studio paths: `server/deploy/observe.ts:77-79`, `registry.ts:253-256`. Replay: both deployment proof scripts above.

Fix dispatch boundaries first. Discard must remain available when source is broken. Explicit teardown should load current targets only for optional defaults. Saved apply must retain assembly/asset/identity/secret/fingerprint safeguards and clearly offer **Apply reviewed revision** versus **Plan current source**; it must never silently combine them.

### F06 Configuration approval does not establish implementation readiness

**Reproduced F; B creation verifies the existing strength.** On `lambda:invocation-test-step`, set Packaging to container. Plan/apply succeeds; both maps remain valid and display container packaging; its folder contains no Dockerfile. The canonical `assertTargetArtifacts` then fails. Undo succeeds. Separately remove the declared implementation folder in a fixture and refresh: no graph diagnostics; Add same ID refuses “already declared”; Inspector directory is read-only.

Expected: relevant-node artifact errors and a reviewed starter/repair action at the configured path. Actual: preflight validates configuration/cloud edges without this artifact check. Fresh creators already generate conventional Lambda/service/task/agent code, include generator outputs, and guard overwrites. Empty/README-only directories are accepted; an existing `index.ts` is safely refused, but with a generic identity-conflict message.

Locations: `server/model/project.ts:588`, `server/edits/fields.ts:142`, `server/edits/batch.ts:336`, `packages/framework/src/config/source.ts:321`, `src/views/Inspector.tsx:199-206`, `shared/creation.ts:22-32`, `server/edits/creation.ts:193-196,420,440,468`. Raw results: `/private/tmp/aws-studio-artifact-audit-results.json`.

Fix shared overlay-aware canonical artifact validation and the bootstrap specification below. Separate **source valid**, **artifacts current**, **implementation ready**, **synthesized**, and **observed running**. Place failures on target/field/action. Never manufacture a healthy implementation from declaration validity.

### F07 Destination context and evidence keys are inconsistent

**B/F for the region/error cases; S for the cache risks.** In mocked GUI, selected target/status is pinned to `us-west-2`, while profile discovery/header displays `us-east-1`. Denying only default-region discovery causes “AWS could not be read” over a successfully read selected target. Shell's Development/Production map switch is also independent of Deploy's selected target. Drift storage/query keys use only deployment name; switching accounts can retain another account's drift under the same name. Plan summaries/findings also match by name without the full destination tuple.

Expected: a single explicit destination and scoped errors; graph mode cannot imply a different operation target. Actual: `Deploy.tsx:94-95,114,226,246` combines discovery and selected status inconsistently; Shell renders the unrelated switch; `server/deploy/service.ts:37,66,144-145` and `src/deploy/api.ts:29` omit destination from drift identity. This is misleading evidence, not a demonstrated bypass of underlying account-pin guards.

Fix all caches, records, keys and controls around deployment/mode/account/region/profile observation plus source revision. Give discovery its own region and partial-error scope. On Deploy, replace the map switch with target selection or visibly label it **Map preview** and avoid presenting it as execution control. Include destination in drift/plan summaries.

### F08 Operation success and verification are lost or premature

**B mocked cloud result; S local startup.** Give the newest plan `applied: unverified` while stacks report UPDATE_COMPLETE. Main UI shows “Deployed · 1 stack” and Update development, with no verification-failure finding or normal route back to the result. The CLI correctly records per-stack verification and exits 3; the presentation drops that distinction. Separately `compose up --detach --build` lacks `--wait`; starting watch/client processes immediately produces “Development is running” before service/client HTTP readiness.

Expected: persistent complete/partial/unverified/export-failed/interrupted outcomes and separate readiness. Locations: `shared/deploy-findings.ts:123-149`, `src/views/deploy/PlanReview.tsx:83-85`, `scripts/deploy.ts:216-235,488-494`, `scripts/dev.mjs:139`, `server/deploy/registry.ts:303-310`.

Fix one durable result view listing completed/remaining/uncertain work and targeted recovery. Recheck is read-only; uncertain writes never auto-retry. Require relevant container health/client bind/application checks for **Ready**, while allowing **Started; readiness pending**. CloudFormation complete is not application healthy. Cancellation currently stops the command; its tooltip correctly says AWS may continue. Make that visible before cancellation and continue AWS observation afterwards.

### F09 Imported Prisma configuration breaks offline planning

**Reproduced F.** Import a local formatting helper from `prisma.config.ts` in a disposable checkout. Workbench source is valid and config revision present. Planning from the actual graph head fails `CLI.CONFIG_UNREADABLE: Cannot find module './studio-format.js'`. Overlay copy includes root config/history/manifests, not its imported helper.

Expected: same supported configuration closure in validation/planning. Locations: `server/database-history.ts:63-78,228-239`; source compiler already tracks imported helpers (`database-workbench.test.ts:239`, passing). History revision also omits transitive config bytes; stale installation under this configuration was not separately demonstrated because planning fails first.

Fix one bounded canonical dependency manifest for validation, copy, revision and install checks. Copy supported authored imports, exclude dotenv/credentials, and reject unsupported external paths precisely. Probe/log: `probe-imported-prisma-config.mjs/.log` in the raw-evidence directory.

### F10 Ordinary edits do not complete generated-artifact updates

**Reproduced F.** Rename `/graphql` to `/audit-graphql`. Source applies and map changes; generated `framework-routes.ts` is byte-for-byte unchanged and lacks the new path. Impact tells the user to regenerate and update callers. Creation does include generated outputs, so identical source responsibilities have different completion semantics.

Expected: include affected generator output in review, or show persistent **Source saved; generated artifacts need update** with a direct offline action. Locations: `server/edits/batch.ts:109-113,279,285`, `transaction.ts:199`, `creation-generation.ts:42`; results `/private/tmp/aws-studio-generated-audit-results.json`.

Reuse creation's generator-preview pipeline for projection-changing edits. Call sites remain explicit code, with a located reference list and return checkpoint. A failed generated/wiring check should remain tied to the edit, not require discovery through Configuration health → Additional checks.

### F11 Real application wiring and removal exceed the GUI without a guided handoff

**B/S.** Try adding a DB-backed endpoint, private upload bucket, new agent tool, handler→task binding, or removing a workload. Add has ten templates, no tool/bucket. Stack always creates an SQS queue. Existing Environment/Explicit IAM are read-only. The typed edit union lacks workload database attachment/userPool/invocation/grant/workload-removal operations; database policy/placement editing already exists. Supported VPC and native-trigger removals do check dependencies.

Expected: supported purpose-based connection operations or an explicit, actionable source handoff. Locations: `src/views/AddMenu.tsx:9-20`, `Inspector.tsx:220-241`, `ManagedDatabaseInspector.tsx:37-42`, `shared/api.ts:19-35`, `shared/creation.ts:47-49`, `server/edits/creation.ts:464,477-486`.

Add bounded **Connect database**, **Provide user session**, **Read/write bucket**, **Consume secret**, **Run task**, **Start workflow**, **Invoke agent**, **Add tool** actions using canonical framework bindings. Review environment delivery, native grants and network implications together. Database auth remains IAM; VPC references remain explicit; no implicit peering. Repository/GraphQL/record authorization/client behavior stays code, with exact source links and the data-feature checklist. A line on the map must not imply permission or runtime invocation. Source removal and deployed deletion are separate reviews with incoming references/data consequences.

### F12 Database lifecycle stops at initialization, production and failure diagnosis

**B/F/S/T.** Actual service mock with missing marker and matching physical schema refuses application before selecting a migration path. Correctly fail-closed, but there is no reviewed empty-database initialization path. Production RDS is a static unavailable target; only local PostgreSQL can be applied. Failed application preserves conservative unchanged/unconfirmed/applied classifications but swallows structured error details into a generic message. Any `services.postgres` Compose override disables inspection, even an unrelated healthcheck-only override.

Expected: explicit empty-origin init, named production handoff, actionable redacted failure. Locations: `server/database-application.ts:85,92,144-151`, `shared/database-application.ts:28`, `server/database-workbench.ts:157,161`, `src/views/DatabaseEvidence.tsx:75`.

Verify emptiness before offering initialization; never adopt/reset an unknown populated DB automatically. Initially show production deployment/account/region/database and an exact private IAM/TLS migration-task handoff; integrate execution later under separate authorization. Preserve migration/operation/error-code/SQLSTATE/stage/marker evidence, completed edges and **Inspect again**. Resolve effective Compose identity read-only rather than rejecting every override. No live DB actions were taken.

### F13 Watch failures silently destroy freshness

**Observed sandbox failure; S product feedback defect.** The atomic schema-replacement watcher test failed twice under restrictions. Minimal `fs.watch` probes in `/tmp` and workspace emitted `EMFILE`, no events. The same probes outside sandbox restrictions receive normal events, so this is not an established host-wide exhaustion or atomic-replacement defect. Studio's `watcher.on('error', () => {})` suppresses errors when they do occur, and workload artifact directories are not watched at all.

Expected: visible degraded watcher state, affected scope, source refresh and recovery. Locations: `server/watch.ts:31-42,81,90`. Add bounded fallback polling and injected error/recovery tests. Preserve last-good graph but label freshness unknown; never represent silence as current state.

### F14 Sparse edits produce misleading large diffs

**F/B.** Change lines 3 and 97 of a 100-line file. `diffOf` shows 95 removals and 95 additions; 93 unchanged lines are marked changed. The authenticated-function browser preview similarly shows large unchanged generated blocks as replacements. Source splicing preserves bytes; representation is the defect.

Locations: `server/edits/plan.ts:60-82`, `src/views/EditDialog.tsx:23`. Use multi-hunk line diff, authored/generated grouping, new/deleted/modified counts, collapsed large generated hunks and full accessible patch. Keep meaningful security/data changes expanded.

### F15 Development can auto-apply uncertain consequential changes

**S/T; pure confirmation probe F.** Default Deploy development sends `autoApply:true`. Development confirmation checks removals/security broadening, but a modified stateful resource with unknown replacement returns `level:none`; registry proceeds automatically. Development still contains real Cognito/event/resources, secrets and costs.

Expected: cloud review is a stable product precedent in both modes. Locations: `src/views/Deploy.tsx:182`, `scripts/deployment-plan.ts:101-115`, `server/deploy/registry.ts:155-166`. Default to **Plan AWS changes → Apply reviewed plan**. At minimum, stop automatic execution for stateful/identity changes, uncertain replacement, secret writes and billable additions. Never interpret “dev” as “free/local.”

### F16 Deployment review lacks inspectable effects and freshness

**B mocked/S.** Review resource rows contain type/logical ID/property names without before/after values or declaration owner; IAM broadening tells users to read a log outside the modal without a link. Security-diff failure is conflated with broadening; some full-diff errors are ignored. `observedAt`/unreadable discovery evidence are present in the contract but not displayed. A stale mocked observation looks current; discovered rows are described as read-only while offering deletion.

Locations: `src/views/deploy/PlanReview.tsx:16-27,99-120`, `scripts/deploy.ts:305-314`, `shared/deploy.ts:70-77`, `src/views/deploy/Detail.tsx`, `shared/deploy-findings.ts:93-98`.

Persist a review bundle with source owners, exact template/property/security evidence, analyzer success/failure, replacement confidence, secret timing, data consequences and dependency phases. Render **Observed at … · partial/stale/refreshing** per scope. Say **Not declared here; source/deploy controls unavailable** for discovered deployments while retaining explicit identity-based deletion recovery.

### F17 Multi-file source writes lack durable interruption recovery

**S, crash experiment not performed.** Existing hash guards, undo and compensating restoration are well tested, but no durable journal records an interrupted write across source/starter/generated/manifest files. Expected: restart can identify applied/restored/conflicted files and offer safe recovery. Use a transaction manifest and content hashes, never overwrite post-crash user edits. Extend existing writer rather than adding a second file API. Location: `server/edits/transaction.ts`; current limitation is documented in Studio README/knowledge editing page. Add kill-between-write fixture tests before claiming crash atomicity.

### F18 Discoverability and information density need targeted fixes

**B/S.** At 1440px the current 61-resource/69-connection map fits at about 0.146 zoom: many names are unreadable until search/focus. Inspector and Deploy fit 420px without horizontal page overflow; current controls/disclosures are materially more consistent than older docs suggest. Keep that work. Prefer a searchable resource navigator and one-hop focus as the first useful task, with visible zoom-to-selection and evidence labels. Avoid adding more simultaneous arcs or permanent badges.

Update stale `moving-forward.md` claims (“only five fields,” no relationship/network editing, no AWS observability) and capability entries that still call database visualization read-only. Define a stable vocabulary: **save source**, **generate artifacts**, **plan migration**, **apply database migration**, **prepare AWS change sets**, **deploy reviewed plan**, **start local services**. Reserve generic Apply only inside a review that names its object and target.

## Proposed Deploy experience

The primary page should answer destination, evidence age, proposed effects and recovery without requiring a user to decode infrastructure IDs first.

1. **One destination header.** Named deployment selector; fixed Development/Production badge; profile → resolved caller/account/region; input file; saved source/review revision. No competing unlabeled environment switch. Show account-pin mismatch before any write. Account-wide discovery gets a separately labeled region scope.
2. **Three compact evidence panels.** **Source:** config/artifact validity and pending changes. **AWS:** observed time, complete/partial/unreadable state, retired stacks, latest operation outcome. **Local:** Docker, exported deployment/currentness, service readiness, watch/client. Keep passed machine checks collapsed; show actionable blockers with field/file/remedy links.
3. **Initial setup.** Explain Development once: application compute runs locally, with named real AWS dependencies. Missing inputs link to protected editing/template generation; profile setup supplies exact commands; costs are shown before creating anything. Distinguish CDK environment bootstrap, application starter files and local image rebuilding.
4. **Prepare with explicit effects.** Default **Compare AWS templates (read-only)** explains identity/template/secret reads and possible synthesis lookups; it creates no AWS objects. A genuinely offline comparison requires an explicitly saved baseline. Separate **Prepare CloudFormation change sets** explains empty review stacks and any opt-in prerequisite secret creation. Use the existing template-review capability where possible. No hidden provisioning under “inspect,” “refresh” or “plan offline.”
5. **Review the actual release.** Group by application owner, then stack/resource. Expand removal/replacement/security/secret/data risks; collapse unchanged machinery. Show complete old/new stack inventory, property/security diffs, dependency order, deferred phases, uncertainty and cost-bearing NAT/interface endpoints/ALB/ECS/RDS. Local estimates disclose assumptions; no false exact bill guarantee.
6. **Apply a fixed review.** Button names deployment/account/region/revision. Changed assets, identity, secret binding, stack state or destructive scope fails closed. Newer source offers **Apply reviewed revision** or **Plan current source** without changing the reviewed artifact. Source change application, DB migrations, local startup and infrastructure deployment remain distinct operations.
7. **Progress and cancellation.** Timeline shows preflight, prepared objects, secret writes, assets, each dependency phase, per-stack result, export and verification. Logs are expandable and preserve scroll position. Use **Stop command; AWS may continue** rather than implying cancellation of already-started CloudFormation work. Keep observing the authoritative cloud result.
8. **Persistent recovery.** Complete, partial, unverified, export-failed, rollback and interrupted outcomes survive reload. Show what finished, remaining stacks, exports/data effects, safe read-only recheck, exact repair and retry scope. Never suggest retrying an unconfirmed database write blindly. Failed plans can always be inspected/discarded despite broken current source.
9. **Deployed-identity teardown.** Select an observed owned deployment even if it is no longer declared. Show exact StackIds/account/region/mode, import order/external blockers, protection, deletion/retain/snapshot policies, managed secrets and retained-resource costs. Missing consequence reads block execution. Save/confirm this exact scope; recheck it, journal each deletion, stop on failure, and review any retain-failed-resources fallback explicitly. Teardown never needs current synth.

Cost default for testing: use `dev`, offline synth/template comparisons, fake change sets and deterministic starters. New VPCs begin without NAT/interface endpoints; add only those required by an explicitly chosen cloud workload, explaining service × zone count and recurring/data charges. Existing production networks are never silently rewritten to make a test cheaper. This audit deployed zero endpoints or other resources.

AWS's service contracts support this design: deletion accepts a unique StackId and starts an asynchronous operation, so execution should bind that ID and observe completion. Export importers must be removed before their exporter can be deleted. Retained resources and snapshots can continue incurring charges; replacement effects require `UpdateReplacePolicy` in addition to deletion policy. The review must account for service defaults, including RDS snapshot defaults, rather than interpreting a missing explicit policy as proof that nothing remains. These are documented semantics, not live audit results. [DeleteStack](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DeleteStack.html), [stack exports](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-exports.html), [DeletionPolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html), [UpdateReplacePolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html).

Interface endpoints are billed by provisioned endpoint-hour in each availability zone plus processed data, which is why the review should expose service × zone counts and avoid deploying endpoints for audit fixtures. [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/).

## Bootstrap code specification

Use existing `InspectorDraft`/batch planner/generator/exclusive-write/hash/undo machinery. Introduce a typed **implementation scaffold/repair** request keyed by canonical target, not arbitrary source text or unrestricted file paths.

**Placement in flow:** Creation gets an **Implementation** step showing stable target ID, configured directory, public path and declared construct ID separately; observed deployed identity appears only when available. Missing directory defaults to **Create starter files** with file tree; **Use existing implementation** requires artifact validation. Existing target health/Build section offers **Create starter files at <actual configured path>**. Packaging/runtime conversion offers the same reviewed compatible operation; moving directories preserves target/construct identity or is refused.

| Workload | Required files and minimum behavior | Review and runtime requirements |
| --- | --- | --- |
| Node ZIP Lambda | `index.ts`, configured export (normally `lambdaHandler`); HTTP returns 200 JSON; authenticated HTTP uses `authenticated` + `auth:true,userPool:true`; WebSocket returns valid gateway response; generic event deterministic acknowledgment | Default Node 24; use repository TS/build ownership. Add manifest/tsconfig only when conventions require a dependency workspace. Replay-enabled event must use `withLocalReplay`. Trigger-specific starters honor payload semantics; do not pretend every event is HTTP. |
| Image/Python Lambda | Image adapter: matching Dockerfile, runtime entry and dependencies; Python ZIP: `lambda_function.py`, normally `lambda_handler` (`lambda_function.lambda_handler`), and needed requirements | Offer only tested supported adapters. Otherwise explain exact required files and keep conversion source-owned; no successful packaging toggle without those artifacts. |
| ECS service | `index.mjs`, `Dockerfile`, `package.json`; bind `0.0.0.0` at declared port; `/health` returns 200; non-root Node image; workspace `dev` watch command | Default local-only; declaration still explicitly names `cloud.vpc` and `cloud.subnet`. Include generated Compose, `.env.example`, workspace and npm 11 offline lock changes. Explain cloud-lane egress/costs before enabling it. Never bypass current image labels/reconciliation. |
| ECS task | `index.mjs`, Dockerfile; parse/validate `FRAMEWORK_TASK_INPUT`; deterministic no-op, bounded completion log, exit 0; malformed input exits nonzero | Explicit `cloud.vpc`/`cloud.subnet` even when local-only. Add manifest only when needed; do not log full input/secrets. Timeout belongs to invocation. Starter creation does not run the task. |
| Agent | `index.ts`, `contract.ts`, `package.json`, `tsconfig.json`; framework `agent(id,contract).respond`, Zod request/response | Default **Echo starter (no model call)** omits model dependency/environment/access/provider requirements. Explicit **Model and tools** variant uses shared `@repo/models`, bounded loop and visible prerequisites/costs. Auth on; browser route optional; IAM service agent explicit. Include generated contracts/workspace lock changes and image-rebuild next step. |
| New agent tool | `cdk-app/lambda_functions/tool_functions/<id>/{index.ts,contract.ts}`; export `lambdaHandler` using `tool()`/`authenticatedTool()`; self-contained `{description,request,response}` contract and declaration registration | `auth:true` uses `authenticatedTool()`; tools/agents do not need separate `userPool:true`. Database/network/resource/secret references remain explicit. Data access belongs in tools; do not infer agent database attachment. Preview both modes and regenerate projections. |

**Existing paths and conflicts:** inspect the resolved configured destination using canonical framework path rules. Missing/empty directories may receive exclusively created files. Preserve unrelated files. Classify partial files individually as compatible/missing/conflicting; add only missing files after validating existing implementation. Never overwrite, normalize or “repair” differing user code. Offer source editor/choose-folder on conflict. A repeated successful request returns **Already configured**; a failed attempt can refresh/review again. Reject traversal, external authority, symlink/junction components, generated/.git/node_modules destinations and family-invalid paths. Recheck realpath, absence and exact hashes at apply. Undo removes only matching owned bytes.

**Review:** group Declaration / New implementation / Generated artifacts / Manifests, each exact destination, full patch, validation and identity implications. Show local rebuild/start as separate next actions. Include relevant artifact/auth/contract/TypeScript checks in the overlay. External changes preserve the form and offer an explicit **Review against latest** comparison; never silently rebase. Journal multi-file installation before writing so interruption can be reconciled without deleting later user edits.

## Database and local workflow recommendations

Keep the workbench's strongest existing distinctions: draft vs saved source; storage vs execution changes; migration graph vs live marker; physical verification vs marker equality; offline plan vs live application. Invalid text retains its diagram only with its current last-valid label.

After **Save schema**, show a persistent progression: **Generate application artifacts → Review repositories/GraphQL/ownership/client impact → Plan SQL from explicit baseline → Save migration files → Select database → Inspect → Review/apply database path → Inspect again**. Generation changes files, not live storage. Planning contacts no database. A head hash is a navigation hint, not an inferred baseline or proof of application. Destructive SQL, required fields/backfills and constraints remain prominent.

Integrate target-bound empty-local initialization and production task handoff without weakening unknown-state safeguards. Keep production IAM/TLS/private networking. Show actual deployment/database identity, not a generic Production RDS label. Improve redacted failure evidence and durable operation records before adding retries. Resolve effective local Compose identity safely; preserve `postgres_data`. Separate migration, orphan cleanup and test identity setup from compute startup.

## Sequenced implementation plan

| Sequence | Work package | Acceptance criteria and meaningful regression coverage |
| --- | --- | --- |
| 1 — correctness and operational boundaries | F01–F06: explicit startup effects; deployed-set reconciliation; source-independent recovery; fail-closed teardown evidence; saved delete scope; canonical artifact validation | Repros above become failing tests first. No live/source mutation before relevant approval. Removed stack is visible/retained; denied reads block deletion; changed stack/policy/account expires review; invalid current source permits discard and explicit identity teardown; packaging without artifacts refuses with zero writes; missing configured folder has node-level repair. |
| 2 — consistent evidence and outcomes | F07–F10/F13: full destination keys, scoped read errors/freshness, durable outcome presentation/readiness, Prisma config closure, generator-complete edits, watcher health | Switch profiles/accounts/regions with same deployment name without leaking drift/plans. Readable selected target survives unrelated discovery failure. Unverified/export-failed/partial results persist with recovery. Nested Prisma imports plan; helper edits expire review. Route edit review includes real generated output. Inject EMFILE/ENOSPC/watch loss/recovery. |
| 3 — UX and developer completion | F11/F12/F14–F16/F18: destination-led Deploy, usable diffs/review evidence, purpose-based bindings, safe review defaults, bootstrap/repair, database handoffs | Browser novice scenarios reach explicit next action without hidden prerequisites. Distant changes produce accurate hunks. Security analyzer failure is unknown and blocks apply until resolved. Starter/partial/conflict/retry paths never overwrite. DB empty-init is verified and separately approved; populated unknown DB stays blocked. Snapshot/config/source errors point to relevant field/node/action. |
| 4 — recovery architecture and broader lifecycle | F17 plus durable source/operation journals, immutable asset manifest, production DB adapter, bounded removal/adoption | Fault injection between files/stack phases survives restart and preserves external edits. Plan identity includes template and asset bytes, not only names/templates (`scripts/deploy.ts:127-131`). Production uses existing private IAM task; no public ingress/password shortcut. Removal lists incoming references/data/retained costs and keeps source and cloud authorization separate. |

Use one operation contract for destination, reviewed artifact, prerequisites, effects, dependency phases, progress/outcome and retry policy; reuse existing framework authorities and script boundaries. This shared work removes more inconsistencies than independent form patches. Keep map geometry/layout out of declaration identity and deployment decisions.

Every implementation package must update the relevant as-built docs and knowledge pages: Framework/Development/Production/Database/AgentCore guides as affected; Studio README, Deploy & Run, database workbench, inspector/design/capabilities; knowledge editing/snapshots/creation/graph model, runtime local/environment, deployment planning/safety/operations/environments. Remove superseded roadmap limitations. Validate links with `node docs/aws-studio-knowledge/check.mjs`.

Required engineering gates: **`npm run verify`**, relevant real-browser flows at desktop and narrow panels/windows, failure/stale-state tests, and explicit **development and production synths** for infrastructure changes: `AWS_PROFILE=dev npm --workspace cdk-app exec -- cdk synth -c prodDeployment=false --quiet` and `AWS_PROFILE=dev npm --workspace cdk-app exec -- cdk synth -c prodDeployment=true -c deployProdWebSocketApi=true --quiet`. Use explicit target/account/region and disposable output/inputs for offline fixtures. Compare baseline/changed templates whenever identities could move: prove unchanged `cloud.constructId`, stack scopes, historical `AsynchronousLambdaFunctionsStack`, logical IDs and stack-prefixed outputs. Route paths, display labels, target IDs and construct/deployed identities are not interchangeable.

Browser regression should include fresh and existing projects, Docker off, new implementation files, partial scaffold, external source conflict, rejected review, accepted source/generated map update, delete dependencies, mode/profile/region switch, expired/partial reads, dropped SSE/reload, deferred phases, failed verification, cancellation with continuing AWS work, and teardown after source deletion. Docker runtime and authorized cloud release tests remain separate from offline verify/synth.

## Checks actually run

| Check | Result |
| --- | --- |
| Studio browser/server typecheck | **Passed** (`npm --workspace framework-studio run typecheck`). |
| Studio production build into disposable `/tmp` output | **Passed**; normal >500 kB chunk warning, no product output committed. |
| Creation/transaction/plan/splice/draft/model suites | **116/116 passed**, including both offline synthesis modes; no cloud actions, bundling disabled in synth fixture. |
| Network-source/landscape suites | **79/79 passed**. |
| Studio deployment suites | **60/60 passed** from Studio workspace with loopback access. |
| CDK deployment planner/secrets/CLI/destroy targeted suites | **28/28 passed**, sequential fake-AWS run. |
| Database/schema/history/application/UI/prerequisites/startup focused suites | **74/75 passed under restrictions**; watcher failed twice with sandbox EMFILE. Raw probes outside the restriction receive normal file events; the same watcher regression then **passed 1/1** unrestricted. |
| Database placement/resources/deployment-inputs suites | **29/29 passed**. |
| Root GUI/security suites: startup/navigation/isometric/deploy/guards | **68/68 passed** with loopback access. Some overlap with suites above; do not sum as unique coverage. |
| Knowledge checker | **Passed**: 28 pages, 540 local links, 142 source references at audit start. |
| Real browser | Board/Isometric/Deploy/Database at 1440px; 420px Inspector; function/starter/generated review; fixture apply/map/undo; VPC preview/back/discard; invalid Prisma/retained diagram/discard guard; database history/evidence; mocked deploy destination/failure states. No uncaught errors in completed root journeys. |
| New isolated probes | Missing artifact accepted, missing directory repair failure, stale route generation, noisy sparse diff, imported Prisma config failure, unmarked DB refusal, retired stack omission, broken-source apply/discard, source-divergent teardown and denied-read false-empty preview reproduced. |
| Full `AWS_PROFILE=dev npm run verify` | **Passed, exit 0**, including all **642 Studio tests**. Framework/GraphQL generation checks, ignored database generation, workspace typechecks, schema and workspace suites completed. The unrestricted full run also passes the watcher test. |

Initial attempts under restricted sandbox produced `listen EPERM` for CLI IPC/HTTP tests; reruns with loopback access passed. A deployment UI invocation from the repository root used the wrong JSX configuration; the proper workspace run passed. Two planner assertions from a parallel run disappeared in sequential isolation. One browser harness waited for a removed selection to close, while Studio correctly displayed “is not in this graph”; source/map undo succeeded and the assertion was corrected. These are not presented as product correctness failures. Watcher EMFILE occurs under restrictions; normal probes work outside them. The error-suppression code remains a real feedback risk (F13).

No live authenticated CRUD, upload, model invocation, task/workflow terminal execution, image build, production DB/IAM/TLS, deployment, rollback, teardown or retained-resource billing behavior was verified. No live operation is needed to establish the reproduced findings. If later desired, prepare a disposable minimal-cost dev deployment with no declared VPC consumers/interface endpoints, exact budget/identity and cleanup plan before requesting cloud-write authorization; databases and model use need their own intended-target authorization. An offline mock cannot prove live parity.
