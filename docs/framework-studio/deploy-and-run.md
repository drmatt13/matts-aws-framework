# Deploy & Run

> Status: approved design (2026-10-17), implemented through M8; see [As built](#as-built-m2m8) for what exists and where it departs from this plan. The [M0–M1 plan](../superpowers/plans/2026-10-17-deploy-run-m0-m1.md) covers the first milestones. Statements about "today" describe the repository as it stood when the design was approved.

## Context

The Deploy tab is a placeholder ([Deploy.tsx](../../framework-studio/src/views/Deploy.tsx)). The lifecycle runs on CLI scripts, and the repository remembers a mode flag (`PROD_DEPLOYMENT` in `cdk-app/.env`).

Evidence from this checkout:

- **Hand-run recovery work.** `.framework/` holds hand-written teardown scripts, retained-resource audits and a cross-stack export recovery.
- **Leaked assemblies.** `.cache/deploy` holds 21 leaked ~90 MB assemblies.
- **One name, one account and region, used for both modes.** `my-aws-app` (7348…4764, us-east-1) served as prod and then as dev, kept apart only by a manual teardown. **Nothing in the framework refuses a cross-mode or cross-deployment update.**

The owner's revised direction is that Studio starts from **what actually exists**:

- it resolves the selected profile's caller identity;
- it discovers framework-owned deployments in CloudFormation;
- it reads their mode from authoritative metadata;
- it reconciles them against the repository and this machine.

Any number of development and production deployments can coexist, in the same account and region or in different ones, with no collisions. Profile names never imply a mode.

This revision keeps what worked and restructures the rest around four ideas:

1. **A versioned identity contract**: ownership, mode and AWS identity, plus revision information kept separately.
2. **Read-only discovery and live synchronization.**
3. **A strict observe → plan → execute separation**, with an explicit **Reconcile** that only ever produces a plan.
4. **Accurate production planning through CloudFormation change sets.**

Confirmed by the owner: `my-aws-app` stays the current **dev** deployment, and `my-aws-app-prod` is reserved for production. Neither name is hard-coded as the only possible deployment, and production may share an account.

### What changed from the previous revision

| Kept | Changed | Dropped as unnecessary |
| --- | --- | --- |
| Mode comes from context. Shim plus `FRAMEWORK_MODE` handoff. The framework's own scripts (deploy, status, export, destroy) enforce every guard, so the CLI is protected without Studio. | Two fixed environments become **any number of deployment targets**. | An AWS SDK inside Studio. |
| An inputs file per target. | The identity contract moves to v2: template metadata plus stack tags, with v1 outputs still honored. | A detached job runner. |
| `deploy:status` as Studio's only path to AWS. | Read-only **discovery** of all framework deployments in an account and region, including a legacy path. | A new diff library. |
| Attached children, plus local containers that survive Studio restarts. | Live watch with incremental events. Restart reconciliation from intent records. Detection of changes made outside Studio. | ECR lookups in v1. |
| Client env through `.env.[mode].local`. | **Prod plans use change sets**, applied with `execute-change-set`. Dev keeps template plans. | Change sets for every dev plan (still available as an option). |
| `destroy.ts`; consequence-based confirmation. | A rules engine (`reconcile`) produces findings and actions. **Reconcile** produces a reviewable plan and never executes. | A continuous controller (Kubernetes style). |
| Termination protection deferred. | The UI is organised around a deployments rail rather than a Dev/Prod picker. | — |

## 1. Verified findings

Earlier findings that still hold:

- **Mode today.** It is an import-time constant read from `cdk-app/.env` ([source.ts:118](../../packages/framework/src/config/source.ts#L118)). [cdk-app.ts:60](../../cdk-app/bin/cdk-app.ts#L60) refuses context that disagrees with it. Two guards depend on that line: [dev-request.ts:14](../../scripts/dev-request.ts#L14) and [seed-test-user.ts:62](../../packages/database/scripts/seed-test-user.ts#L62). `FRAMEWORK_INPUTS_FILE` exists, but [deploy.ts:27](../../scripts/deploy.ts#L27) and [export-cdk-outputs.mjs:159](../../scripts/export-cdk-outputs.mjs#L159) ignore it.
- **Identity v1.**
  - Every stack carries the output `framework:deployment:v1` = `{version, deployment, mode, account, region}` ([framework-resources.ts:366](../../cdk-app/lib/framework/framework-resources.ts#L366)).
  - Stacks that failed on first create (`ROLLBACK_COMPLETE`), `REVIEW_IN_PROGRESS` stacks and legacy stacks have **no outputs**, and export skips them ([resource-export.ts:37](../../scripts/resource-export.ts#L37)). Their templates still contain the identity output value as a literal.
  - Stack sets depend on the config.
  - There are no stack tags, no template metadata and no termination protection.
- **Deploy.** It never reads stacks that are already deployed. Its account check compares the caller with an account derived from the same credentials, and this checkout's prod deployment was made with a profile named `dev`. A pre-built assembly passed to `--app` breaks synth. `hotswap`, `--no-rollback` and `--yes` pass straight through. There is no SIGINT handling. Strong cross-stack references are on.
- **Docker.** Synth needs it only for a Python zip with `requirements.txt`. Publishing needs it only for container Lambda and ECS images that are not yet in ECR. Today's dev graph needs none, and the prod graph has three image assets. `dev:containers` always needs it.
- **Local development.**
  - `dev.mjs` runs an attached `compose up --watch` with no `cwd`.
  - Status from `compose ps` fails without the root `.env`; label filters don't.
  - The runner reads `resources.json` once.
  - A prod export overwrites the dev root `.env`.
  - `client-app/.env` is copied by hand.
- **Studio.** `CommandRunner` has two commands, buffers output, uses one lock and inherits the full environment. Server-sent events have no ids. Invariants #6, #7 and #8 are revised by this design.

New findings for this revision:

- **Physical names are already isolated by deployment.**
  - Every explicit name in `cdk-app/lib` is scoped by the stack name: user pool `${stackName}-UserPool` ([cognito-stack.ts:158](../../cdk-app/lib/app/cognito-stack.ts#L158)), HTTP API `${stackName}-HttpApi`, CloudFront functions, and exports `${stackName}:…` ([framework-cloud.ts:367](../../cdk-app/lib/framework/framework-cloud.ts#L367)).
  - Secrets are `${deployment}/secret/…`. The Cognito domain prefix combines name, account and region ([deployment.ts:578](../../cdk-app/deployment.ts#L578)).
  - Two deployments therefore coexist in one account and region by construction. No unscoped physical name was found; a test will lock that in.
- **CDK CLI 2.1139 capabilities**, verified in the bundled source and the option registry:

  | Option | Behaviour |
  | --- | --- |
  | `deploy --method prepare-change-set --change-set-name N` | Creates change sets **without executing** them. It always creates one, even when there are no changes, and an empty one is not deleted when execute is false. |
  | `deploy --method execute-change-set --change-set-name N` | Executes a change set created earlier, **"bypassing synthesis entirely"** (`executeExistingChangeSet` → `checkAndExecuteChangeSet` refuses replacement in paused-fail states). |
  | `deploy --parameters STACK:KEY=VALUE` | Supplies parameters. `--previous-parameters` defaults to true, so a parameter that isn't passed keeps its deployed value. |
  | `deploy --revert-drift` | Creates a **drift-aware change set** that includes reverting drift. |
  | `diff` | Has **no** `--parameters` option, so a change-set diff can't supply the secret-ARN parameters. |
  | `drift`, `rollback`, `publish-assets` | Available. |

  - `updateTerminationProtection()` runs right after a change set is created, and again before execution.
  - A stack whose first create failed is deleted automatically before CDK creates it again.
  - CloudFormation itself marks a change set `OBSOLETE` when its stack is updated after the change set was created.
  - After a change set runs, CloudFormation removes the stack's other change sets.
- **This machine.** Docker Desktop is stopped (context `desktop-linux`), and `docker desktop start` is available. Compose v5.1.0, AWS CLI 2.35.8, profiles `default` and `dev`.

## 2. Concepts

| Term | Meaning | Where it lives |
| --- | --- | --- |
| **Account context** | The selected AWS profile resolved to `{callerArn, account, region}`. The profile name is only a credential source and never implies a mode. | `sts get-caller-identity` |
| **Deployment** | A framework-owned set of stacks sharing **identity** `{owner, deployment, account, region}`. Its **mode** is fixed when it is created. | Observed in CloudFormation (§3) |
| **Target** | A deployment the repository *intends* to exist: `{name, mode, account?, region?, inputs}`. There can be any number. | Committed in `cdk-app/cdk.json` `framework:targets`, plus an implicit personal dev target from `CDK_APP_NAME` in `cdk-app/.env` |
| **Plan** | An immutable artifact describing how to move one target from what is observed to what is desired: steps, evidence, risks, uncertainties, required authorization, fingerprints | `.cache/framework-studio/plans/<id>/` (CLI: `--plan <dir>`) |
| **Operation** | Execution of a plan, or a local lifecycle action, through the typed registry | Studio jobs and intent records |

**Targets for this checkout:**

```jsonc
// cdk-app/cdk.json (committed)
"framework:targets": {
  "my-aws-app-prod": { "mode": "prod", "account": "734800004764", "region": "us-east-1", "inputs": "cdk-app/.env.prod" }
}
// cdk-app/.env (per developer, gitignored): CDK_APP_NAME=my-aws-app → implicit { mode: "dev", inputs: "cdk-app/.env" }
```

**Rules:**

- **Prod targets require an account pin.** The region pin is optional; when absent, the profile's region applies.
- **Shared targets are declared in `cdk.json`.** A shared dev target, staging, or another prod target all go there.
- **Names are unique.** The personal dev name may not equal any declared target name.
- **Selection** (CLI and Studio share one rule, `resolveTarget`):
  - `-c deployment=<name>` picks the target. `-c cdkAppName` remains a legacy alias.
  - `-c prodDeployment=true|false` states the graph. It **must agree** with the target's mode, so a prod target can never be built without explicitly stating prod.
  - No flags selects the personal dev target.
  - `-c prodDeployment=true` alone selects the only declared prod target, or fails with the list.
- **Inputs.** Each target has its own inputs file: dev uses `cdk-app/.env` (the file Compose mounts), prod defaults to `cdk-app/.env.prod`. Secret values therefore never cross between deployments.

## 3. Identity contract v2

Four concerns, recorded separately:

| Concern | Fields | Recorded in | Changes |
| --- | --- | --- | --- |
| **Ownership** | `owner` = `matts-aws-framework`, `deployment`, `stack` (the stack's role, e.g. `CognitoStack`) | Template `Metadata["framework:deployment"]`, stack tags, and the v1 output (deployment only) | Never |
| **Mode** | `mode` | The same three places | Never: switching means delete, then create |
| **AWS identity** | `account`, `region` | Metadata and the v1 output, cross-checked against the StackId ARN | Never |
| **Revision** | `contract`, framework version, source commit plus a dirty flag, assembly digest (a hash of the templates), plan id, `deployedAt`, `deployedBy` (caller ARN), `via` (cli or studio) | **Deployment record**: the SSM parameter `/framework/deployments/<name>`, written after verification. **Never in templates.** | Every deploy |

**Why revision stays out of templates.** A commit hash in a template would change every stack on every commit. "Up to date" would never hold, and every change set would be noise.

**Template metadata**

- `{contract: 2, owner, deployment, mode, account, region, stack}`.
- It is readable through `get-template-summary` for **every** stack that has a template, including failed creates and `REVIEW_IN_PROGRESS`.

**Stack tags**

- `framework:owner`, `framework:deployment`, `framework:mode`, `framework:contract`.
- They come back from `describe-stacks` with no extra call, and they exist from the moment a stack is created, including on failed creates.
- CloudFormation copies them onto the resources, which enables a tag-based **leftover scan** after deletion. That replaces the manual teardown audits.

**v1 output**

- Kept unchanged indefinitely, for older readers.

**Reader rules** (`packages/framework/src/deploy/identity.ts`)

- Evidence is ranked metadata, then tags, then the v1 output.
- Every source that is present must agree, and the StackId's account and region must match. Otherwise the stack is `inconsistent` and refused.
- A v1-only stack is recognized as `contract-1`. It moves to v2 on its next reviewed deploy.

**Migration cost.** The first v2 deploy adds tags, which CloudFormation copies onto resources in place. The prod change set shows each resource's `Replacement` flag authoritatively before anything runs. This needs verifying once on a disposable deployment.

**Deployment record**

- Advisory only: it is never used for a safety decision.
- If writing it fails, deploy prints a warning and does not fail.
- SSM keeps 100 versions, which gives a deploy history.
- `destroy.ts` deletes it.
- It needs `ssm:PutParameter`.
- It is a cuttable piece (§12).

## 4. Discovery (read-only)

`npm run deploy:discover -- [--profile p] [--region r] [--json]` (Studio runs the same command):

1. **Account context:** `sts get-caller-identity`. Errors are classified: no credentials, an expired SSO or login session, access denied.
2. **Regions:** the profile's region, plus the pinned regions of targets whose account equals the caller's. Scanning every enabled region is available on demand.
3. **Sweep per region:** `describe-stacks` over all pages. For each stack: name, id, status and reason, times, **tags**, **outputs**, `ChangeSetId`, termination protection, and parent (nested stacks are grouped under their root).
4. **Evidence:** tags (v2), then outputs (v1). Stacks are grouped by deployment, and each group is validated (consistency, account and region against the StackId).
5. **Legacy path** (cautious). It considers only stacks with **no** evidence whose name is `<known deployment or target name>-<Suffix>` (alphanumeric, no further hyphen):
   - read `get-template-summary` (v2 metadata);
   - otherwise read `get-template` and look for the v1 output's literal value;
   - if found, the stack is attached with the label "identity recovered from template" (for example a failed create);
   - otherwise it goes to **Unrecognized**: shown, **never adopted**. Adoption is an explicit planned step (§7).
6. **Pending change sets:** `list-change-sets` for the deployments' stacks. `framework-<planId>-*` change sets are ours; anything else is foreign.
7. **Records:** one `ssm get-parameters-by-path /framework/deployments/`.
8. **Result:**
   - `{context, regions, deployments[{identity, mode, contracts, stacks[], health, record?, pendingChangeSets[], issues[]}], unrecognized[], unreadable[]}`;
   - each target matched as `observed`, `absent`, or `conflict{mode, account, region, owner}`;
   - deployments nobody declared (for example a teammate's dev deployment) are listed **read-only**.

**Permissions:**

| Kind | Calls |
| --- | --- |
| Required | `cloudformation:DescribeStacks`, `GetTemplateSummary`, `GetTemplate`, `ListChangeSets`; `sts:GetCallerIdentity` |
| Optional | `ssm:GetParametersByPath` |

A call that fails because of a missing permission yields a partial result that says what couldn't be read. **Discovery never calls a mutating API.** Tests run the script against a fake AWS CLI that fails on any non-read verb.

## 5. Live synchronization

- **Watching an operation.** `npm run deploy:status -- -c deployment=<n> --watch [--jsonl]` is one long-lived process per watched deployment.
  - It polls `describe-stacks` for the deployment's stacks every 3 s while anything is `*_IN_PROGRESS` or an operation is active.
  - It reads `describe-stack-events` incrementally, paging until the last `EventId` it has seen.
  - It emits `stack`, `event` and `done` lines. In a terminal it prints readable progress, which helps CLI users too.
- **Idle refresh.** Studio refreshes when it gains focus, on **Refresh**, and every 60 s for the selected deployment. A full discovery runs when the profile changes or on **Refresh all**.
- **Changes made outside Studio.** When `LastUpdatedTime`, status or `ChangeSetId` differs from what was last observed and the change wasn't ours, Studio shows "Updated outside Studio · 14:02". The deployment record shows *who* and *via what* when the change was a framework deploy. Plans for that deployment become stale.
- **Restart reconciliation.**
  - Each operation writes an intent record, `.cache/framework-studio/operations/<id>.json`: the operation, target, plan id, change-set name, completed steps and remaining steps.
  - On start, Studio rediscovers each unfinished operation's deployment, then:

  | What it finds | What Studio does |
  | --- | --- |
  | Stacks still in progress | Follows them again |
  | Stacks finished | Re-runs verification read-only and records the result |
  | Remaining **local** steps of an authorized operation (e.g. the dev export) | Resumes them |
  | Remaining **cloud** steps | **Never resumes them.** Shows "Partially applied: 1 of 3 stacks · Continue…", which needs a new authorization |

  - Our executions are recognised by the change-set name in the stack's `ChangeSetId`.

## 6. Architecture: observe → plan → execute

| Layer | Writes | Framework, CLI and scripts | Studio |
| --- | --- | --- | --- |
| **Observe** | **None.** No AWS writes, no file writes | `deploy:discover`; `deploy:status [--watch]`; pure `identity.ts`, `discovery.ts`, `classify.ts` | `observe/aws.ts` runs the scripts. `observe/local.ts`: the Docker probe; Compose state by label (`com.docker.compose.project`) plus the runner's `matts-*` containers; managed processes; exported files. `observe/repo.ts`: snapshot model, targets, predicted Docker need. `observe/prereqs.ts`: Node 24, npm 11, AWS CLI, dependency freshness (hidden lockfile timestamp versus `package-lock.json` and manifests) |
| **Plan** | Only unavoidable preparation, disclosed and authorized: change sets, asset publishing, **creation of new secrets** | `deploy:plan` (§8) writes `plan.json`, the assembly and the evidence | `plan/*`: requests plans, parses `plan.json` into a `PlanView`, handles expiry and discard (deletes our change sets and any `REVIEW_IN_PROGRESS` stacks the plan created, which have no resources) |
| **Execute** | Cloud and local changes, **only with an authorized plan** | `deploy:apply --plan <dir> [--confirm <name>]`; `deploy:destroy`; `export`; `dev:containers [--detach]` | `execute/registry.ts`: typed operations, fixed argv, no shell, curated environment (selected `AWS_PROFILE`, static keys removed). `execute/jobs.ts`: attached children, numbered logs, server-sent-event replay, locks, intent records, cancelling a process tree (with "CloudFormation continues"). `execute/local.ts`: Start, Stop, Restart, Attach Watch, the Vite client |

**Shared pure logic** lives in `packages/framework/src/deploy/`: `identity`, `targets` (`resolveTarget`), `classify`, `reconcile`. CLI and Studio therefore apply one set of rules.

**Studio API:**

- Observe: `GET /api/observe/...`.
- Plan: `POST /api/plans`, returning a plan id; `DELETE`-style discard via `POST /api/plans/:id/discard`.
- Execute: `POST /api/plans/:id/apply {authorization}`, and `POST /api/local/:action`.
- Logs: `GET /api/jobs/:id/log?after=`.
- The token, host and origin guards stay as they are today.

**Framework changes carried over from before:**

- the `cdk-app.ts` shim plus `bin/graph.ts`, with `FRAMEWORK_MODE`;
- a legacy `PROD_DEPLOYMENT` line fails closed, with a migration message;
- rebased guards: seed, prune and dev-request require the dev-export identity to match a dev manifest;
- export per target: dev writes the root `.env`, `resources.json` and `client-app/.env.development.local`; prod writes `.framework/prod/outputs.json` and `client-app/.env.production.local`, and never the root `.env`;
- `export --check`;
- `dev.mjs --detach`;
- cross-process lock, SIGINT cleanup and an assembly sweep;
- prod refuses `--hotswap`, `--no-rollback` and `--yes`.

## 7. Reconciliation and next actions

**`reconcile(desired, observed, running) → Finding[]`** is pure and lives in `packages/framework/src/deploy/reconcile.ts`.

- Each finding is `{code, severity: info | attention | blocking, scope, evidence, remedies: ActionRef[]}`.
- Codes:
  - **Identity:** `TARGET_ABSENT`, `MODE_CONFLICT`, `ACCOUNT_CONFLICT`, `INCONSISTENT_IDENTITY`, `UNRECOGNIZED_CANDIDATE`, `CONTRACT_V1`.
  - **Sync:** `IN_SYNC`, `DIFFERS` (from the last plan), `NOT_CHECKED` (source changed since), `MISSING_STACK`, `ORPHAN_STACK` (a stack of this deployment that is no longer in the desired graph).
  - **CloudFormation state:** `IN_PROGRESS`, `FAILED{create | update-rollback | delete}`, `PENDING_CHANGE_SET{ours | foreign}`, `DRIFTED` (only when checked), `SECRETS_CHANGED`.
  - **Local:** `LOCAL_INCOMPATIBLE`, `EXPORT_STALE`, `RESTART_NEEDED`, `WATCH_DETACHED`.
  - **Prerequisites:** `DOCKER_NEEDED_DOWN`, `DEPS_STALE`, `CREDENTIALS`.

**Next actions** follow from findings by priority: blocking, then in progress, then failed, then differs, then local. The UI never shows a fixed set of buttons.

**Reconcile** builds a plan; it never executes anything. It is an ordered list of typed steps, each tagged `local`, `cloud-write` or `destructive`, with its authorization and uncertainty notes:

1. **Prerequisites:** dependencies, Docker. Local, and eligible to run without asking.
2. **Recovery:**
   - remove a failed-create stack, which has no resources;
   - `cdk rollback` for `UPDATE_ROLLBACK_FAILED`;
   - discard foreign or expired pending change sets, listed for confirmation.
3. **Converge:** create or update stacks through a template plan (dev) or change sets (prod), carrying the v1 → v2 identity migration.
4. **Adopt** an unrecognized stack: only when the user selects it, and states its deployment and mode. Adoption means a guarded deploy that passes `--adopt <stack>`.
5. **Orphans:** listed, but **unselected by default**. Removal is `destructive` and needs the typed name.
6. **Local** (dev): export, restart services, attach Watch.

**Execution rules:**

- A plan runs only through **Apply** with an authorization that matches its required level (§9.6).
- **Production is never modified because reconciliation found a difference.** Reconcile only plans, and prod always pauses.
- For dev, the one-click **Deploy development** / **Update development** is Reconcile followed by Apply. It continues automatically only when the plan has no consequential steps, and only because the user clicked it.

## 8. Planning accuracy

**Development, the template plan (default; no AWS writes):**

1. synth into a kept assembly;
2. guard;
3. read-only secret plan (names and create/update/unchanged; values compared in memory, in the script);
4. structural comparison per stack against `get-template`: added, removed and modified logical ids and types; the `DeletionPolicy` of anything removed; stateful types touched; removed or changed exports that still have importers (`list-imports`), which is the deadlock warning;
5. IAM broadening from `cdk diff --app <dir> --security-only --fail`;
6. full text from `cdk diff --method template`.

Replacement is shown as "may". Change sets can be switched on for dev too.

**Production, the change-set plan:**

1. Synth (kept assembly), guard, and the secret plan.
2. **New secrets.** If the plan needs secrets that don't exist yet, it pauses: "Create N secrets so CloudFormation can plan against their ARNs. Nothing reads them until you apply." This is an explicit authorization, because a change set cannot reference an ARN that doesn't exist.
3. `cdk deploy --app <dir> --method prepare-change-set --change-set-name framework-<planId> --parameters <ARNs>`, with `--revert-drift` optional (a drift-aware review). This publishes assets (S3 and ECR, plus Docker if images are missing) and creates change sets. New stacks enter `REVIEW_IN_PROGRESS`.
4. `describe-change-set --include-property-values` per stack, giving authoritative changes: action, `Replacement` (True / False / Conditional), scope, details and the causing entity. Empty change sets are recorded as "no changes" and deleted.
5. **Staged dependencies.** A stack whose change set can't be created yet (it imports an export that isn't deployed) is marked **deferred until `<upstream>` runs**. Apply pauses after the upstream stack, prepares the deferred change set, and **asks again** if its changes go beyond the template preview.
6. `plan.json`: assembly digest, change-set ids, fingerprints (`LastUpdatedTime ?? CreationTime`, status) and the authorization level. Plans expire after 24 h by default.

**Apply in production:**

1. guard again;
2. every change set must be `CREATE_COMPLETE` and `AVAILABLE`; `OBSOLETE` means re-plan;
3. recompute the secret plan, and refuse if the names or actions differ;
4. update secret values;
5. `cdk deploy --app <dir> --method execute-change-set --change-set-name framework-<planId>` in dependency order;
6. verify: statuses, identity, and templates equal the assembly;
7. write the deployment record.

**Remaining uncertainty**, shown in every review and never hidden:

| Area | What the plan knows | What it cannot establish | Mitigation |
| --- | --- | --- | --- |
| Parameters | Secret-ARN parameters are passed explicitly; others keep their previous values | Parameters resolved when the change set runs (e.g. `BootstrapVersion` from SSM) | Listed; stale checks |
| Secrets | Names and create/update/unchanged | Value contents (never shown). Value updates apply *before* the stacks run and reach runtime readers immediately | Apply recomputes the secret plan and refuses on mismatch |
| Assets | Content hashes; published during preparation | Whether `cdk gc` removed them before apply | Plan expiry; CloudFormation fails safely if they're missing |
| External changes | The change set against the deployed template and parameters; a drift-aware change set includes drift on supported types | Resources CloudFormation doesn't manage; types where drift isn't supported | A drift check is offered as a prod plan step; labelled |
| Concurrency | CloudFormation marks change sets `OBSOLETE` when the stack is updated | Changes made outside CloudFormation | Fingerprints plus the `OBSOLETE` check |
| Cross-stack | The current exports | A downstream stack's final change until its upstream has run | Staged preparation and re-approval |
| Custom resources | Their properties | Their effects at run time (e.g. CloudFront KeyValueStore population, database bootstrap) | Named as "runtime effects not predicted" |
| Template plans (dev) | Adds, removes, modifies; IAM broadening | Whether a replacement will happen | "May replace" label; change sets available |

## 9. Safety invariants

The scripts enforce these, so the CLI is protected without Studio.

1. **Observation is read-only.** Discover, status and watch use read verbs only, which tests enforce.
2. **The mode comes only from context, and it must agree with the target's declared mode.** Profile names carry no meaning. A mode switch is never implicit; the only route is delete, then create.
3. **A deploy touches only stacks that are absent or whose evidence matches the target exactly:** owner, deployment, mode, account and region. Unrecognized or inconsistent stacks are never adopted silently (`--adopt <stack>`, typed).
4. **Prod targets have account pins.** Caller account = pin. Target names are unique, and the personal dev name never equals a declared target. Each target has its own inputs file, and every physical name is scoped by deployment (the isolation test).
5. **What was reviewed is what gets applied:** the same assembly digest, change sets `AVAILABLE`, unchanged fingerprints, and a recomputed secret plan that matches.
6. **Authorization:**
   - Every cloud write needs an explicit Apply bound to a plan id.
   - Destructive steps need explicit selection.
   - Prod requires a typed name when a plan has removals, IAM broadening, a replacement (`True` or `Conditional`) of any resource, a stateful type modified, an export with importers changed, or a first deploy into the account. Other prod plans need one deliberate click.
   - The scripts check `--confirm`.
7. **Reconcile never executes, and prod never changes because a difference was detected.**
8. **No concurrent changes:** `*_IN_PROGRESS` blocks; a cross-process lock; a Studio lock per deployment.
9. **Success means verification**, and the deployment record is written only after it.
10. **Deletion goes only through `destroy.ts`.**
    - The mode must be stated explicitly.
    - It reports what remains: retain and snapshot policies, managed secrets, and a tag-based leftover scan.
    - Prod requires the typed name.
    - Termination protection is respected, and disabled only after confirmation.
11. **Secret values never leave the scripts.** Plans, status, logs, records and Studio carry names only.
12. **Only typed registry operations run:** fixed argv, validated parameters, no shell, an explicit cwd.

## 10. UX: Deploy & Run

The visual language stays: drafting film and ink, Barlow, and colour only for dev (teal), prod (violet) and local (amber). It reuses `dialog.preview`, `.lane-line`, the drawer and toasts. Observation, planning and execution look different: observed facts are plain ink, plans are dashed outlines, and operations show live progress.

```
┌ Account  [profile: dev ▾] → 7348…4764 · us-east-1 · role/Dev ✓      [Refresh all] ┐
├ Deployments ─────────────┬─────────────────────────────────────────────────────────┤
│ IN THIS REPOSITORY       │ my-aws-app   [Dev]  7348…4764 · us-east-1   contract v1  │
│ ● my-aws-app       Dev ✓ │ Deployed 2h ago from 9f3c9cc via Studio (role/Dev)      │
│ ○ my-aws-app-prod  Prod  │ ┌ Repository ───┬ AWS ─────────────┬ This machine ────┐ │
│   not deployed           │ │ 4 workloads   │ ● 4 stacks ok     │ ● Running 9/9    │ │
│ DISCOVERED (read-only)   │ │ Docker: no    │ ⚠ differs (1)     │ App :3000 ↗      │ │
│ ● alex-dev         Dev   │ └───────────────┴───────────────────┴──────────────────┘ │
│ UNRECOGNIZED (1)       ▸ │ Needs attention                                          │
│                          │ ⚠ AsynchronousLambdaFunctionsStack differs (handler code)│
│ Local dev → my-aws-app   │ ℹ Identity contract v1: upgraded on next deploy          │
│                          │ [ Reconcile… ]   Stop development · Logs · ⋯             │
├──────────────────────────┴─────────────────────────────────────────────────────────┤
│ Activity  Update development · ✓Plan ✓Guard ●Apply ○Verify   Cognito 14/22 ▸ log  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Account bar.** Choose a profile; Studio shows the resolved caller, account and region. Each target remembers its own profile. A target pinned to a different account asks for "a profile for 7348…4764".

**Deployments rail.**

- **In this repository:** declared targets plus your personal dev deployment, each with its observed status.
- **Discovered:** read-only.
- **Unrecognized:** expandable, with each one's evidence and "Adopt…" (which plans adoption).
- The rail also shows which deployment local development is attached to.

**Detail view.**

- **Identity header:** mode badge, account and region, contract version, and the revision record.
- **Three state panels:** Repository, AWS (stacks, outputs, events, drift) and This machine (dev only; prod says "Local development runs against a development deployment").
- **Needs attention:** findings with their remedies.
- **One primary action**, derived from the findings (Sign in / Deploy development / Reconcile… / Start development / Stop development / a recovery action), plus secondary actions.

**Plan review dialog.**

- **Header:** "Plan for `<target>`", its evidence type (change sets or template), and when it expires.
- **Checks:** a guard checklist, then steps grouped local / cloud / destructive.
- **Per-stack changes:** action, Replacement and causing entity.
- **Other evidence:** IAM changes, export deadlocks, secret names, Docker images, and **the uncertainty table**.
- **Apply:** shows the account. The typed name appears only when §9.6 requires it.
- Prod plans are visually framed in violet.

**Errors** are cards: the step, the classified cause, and recovery (an operation or exact guidance). The raw log is one click away.

## 11. Implementation plan

`npm run verify` passes after every milestone. Live AWS tests are opt-in (`FRAMEWORK_LIVE_AWS=1` with a disposable name) and never part of `verify`.

- **M0 — Design record.**
  - Work: commit as `docs/framework-studio/deploy-and-run.md`; revise Studio invariants #6 (names only), #7 (typed registry) and #8 (AWS only through repository scripts and the AWS CLI; observation read-only).
- **M1 — CLI safety on today's contract** (it ships alone).
  - Work: `identity.ts` and `classify.ts` (v1 outputs, the name pattern, the template fallback); the deploy guard before secret sync (mode, mixed, inconsistent, unrecognized, in progress, unsafe prod flags); the lock, SIGINT handling and assembly sweep; `FRAMEWORK_INPUTS_FILE` honoured.
  - Tests: classifier fixtures for every status, outputless stack, foreign account and inconsistency; the guard refuses before any secrets call.
- **M2 — Targets and mode from context.**
  - Work: `targets.ts` and `resolveTarget`; `framework:targets`; the implicit personal target; inputs files per target; the shim, `graph.ts` and `FRAMEWORK_MODE`; the legacy-line migration; rebased guards; export per target, including the client `.local` files and `--check`; docs and examples.
  - Tests: selection and agreement; name collisions; pins; `new App({context})`.
  - **Isolation test:** synthesize `my-aws-app` (dev) and `my-aws-app-prod` (prod) for the same account and region, then assert that stack names, explicit physical names, export names and secret names are disjoint.
- **M3 — Identity v2, discovery and status.**
  - Work: metadata and tags emitted (v1 output kept); reader rules; `deploy:discover`, `deploy:status`, `--watch` with incremental events; the deployment record.
  - Tests: a fake AWS CLI that fails on any non-read verb during discovery; mixed v1/v2 agreement; nested grouping; partial results on permission denial.
  - Acceptance: discovery against this account lists `my-aws-app` as dev, v1.
- **M4 — Plan and apply.**
  - Work: template plan; change-set plan (prepare, describe, empty-set cleanup, staged deferral, new-secret authorization); `deploy:apply` with `execute-change-set` (plus the `OBSOLETE` and stale checks, secret plan recompute and verification); discard and expiry; `destroy.ts` with the tag-based leftover scan; `dev.mjs --detach`.
  - Tests: every refusal path; confirmation enforced in the script.
  - Acceptance: an opt-in live run against a disposable **prod-mode** name in the dev account: change-set plan → apply → verify → destroy.
- **M5 — Studio foundation.**
  - Work: the observe, plan and execute modules; the registry; jobs and intent records; restart reconciliation; numbered server-sent events; prerequisite probes; preferences (profile per target).
  - Tests: parameter validation; restart mid-operation; no secret values in any record or event; the guard harness for the new routes.
- **M6 — Observation UI.**
  - Work: account bar, deployments rail (declared / discovered / unrecognized), detail, live events, findings and `nextActions`.
  - Acceptance: live and correct for this account, with **no writes**.
- **M7 — Local lifecycle.**
  - Work: Start, Stop, Restart; Watch reattach; the client; health; logs; freshness; adoption of a stack started from a terminal.
  - Acceptance: restarting Studio mid-run leaves no orphaned processes.
- **M8 — Reconcile and apply UI.**
  - Work: dev one-click, then the prod change-set review and authorization; recovery steps; partially applied operations.
  - Acceptance: an opt-in live dev cycle; prod is left to the owner.
- **M9 — Teardown and refinements.**
  - Work: the delete UI; `cdk drift` and drift-aware review; `cdk rollback`; `aws sso login`; `docker desktop start`; termination protection for prod (after verifying the failed-create auto-delete and `REVIEW_IN_PROGRESS` interactions).

## 12. Complexity: what's deliberately left out, and what can be cut

- **No continuous controller.** Reconcile is on-demand planning, and nothing auto-applies in the background.
- **No custom dependency scheduler.** CDK orders the stacks; the only addition is "deferred stack" staging.
- **No SDK, no database, no detached daemons.** One AWS transport (the AWS CLI through the repository's scripts). Plans and intent records are JSON files under `.cache`.
- **No custom drift engine.** `cdk drift` and drift-aware change sets cover it.
- **No multi-region sweep by default.**
- **Cuttable if you prefer a smaller footprint:**
  - **The SSM deployment record.** Without it, revision information is reduced to the template digest and `LastUpdatedTime`.
  - **Stack tags.** Metadata plus outputs are enough for identity; tags add `describe-stacks`-only discovery and the leftover scan, at the cost of a one-time tag update on every resource.
  - **Change sets stay prod-only** by default.

## 13. Open decisions

1. **Deployment record in SSM** (advisory revision history): include (recommended) or cut?
2. **v2 stack tags** (one-time, in-place tag update on every resource; enables leftover discovery): include (recommended) or metadata only?

Both are planned as included unless you say otherwise. My other calls, all reversible:

- shared targets in `cdk.json`, the personal dev name in `cdk-app/.env`;
- prod and mode agreement;
- the `FRAMEWORK_MODE` shim;
- a legacy line fails closed;
- `--adopt` is the only way to adopt a stack;
- 24 h plan expiry;
- client env through `.env.[mode].local`;
- local containers survive Studio restarts;
- termination protection deferred to M9.

## Verification

- `npm run verify`, `npm --workspace cdk-app test` and `npm --workspace framework-studio test` per milestone.
- Explicit synths: `cdk synth -c prodDeployment=false --quiet`, and `-c deployment=my-aws-app-prod -c prodDeployment=true --quiet`. Also check the refusals: disagreeing mode, pin mismatch, legacy line, name collision.
- The discovery test proves no mutating verb is called. The isolation test proves the two deployments are disjoint.
- Studio checks on `--port 4591` only, never touching the owner's 4590. Playwright covers the rail, detail, review and findings states, with fixtures for failures.
- Opt-in live runs on disposable names: a dev cycle (deploy → verify → export → start → stop → delete) and a prod-mode change-set cycle in the dev account. Afterwards, check CloudFormation and the tag-based leftover scan. Actions on real production are left to the owner.
- Report which checks actually ran. Offline tests don't prove deployment, Docker or browser behaviour.

## As built (M2–M8)

What exists now, where it lives, and where it departs from the plan above.

### The page

Framework Studio's **Deploy** tab (`framework-studio/src/views/Deploy.tsx`, components in
`src/views/deploy/`) has four parts:

| Part | What it shows and does |
| --- | --- |
| Account bar | The chosen profile resolved through the AWS CLI to account, region and caller, or a classified problem (expired session → **Sign in**). Below it, this machine's tools: Node, npm, AWS CLI, dependency freshness, Docker engine, Compose, each with its remedy (Install, Start). |
| Rail | This repository's targets, other framework deployments in the account (read-only), and unrecognized lookalike stacks. Which deployment this machine's settings point at, and whether local development is running. |
| Detail | Findings, most pressing first, with one primary action. Three panels: Repository (intent, mode, inputs, pins), AWS (stacks, pending change sets), This machine (Docker, settings, watch, web client, containers with logs). CloudFormation events, live during operations. |
| Activity | Every operation as a job: its steps, a live numbered log, Cancel. The watch and the web client are jobs too, until stopped. |

The findings rules are pure and tested: `framework-studio/shared/deploy-findings.ts`.
They live in Studio rather than `packages/framework`, because no CLI uses them; the CLI's
own guards stay in the scripts.

### The server

| Module (`framework-studio/server/deploy/`) | Responsibility |
| --- | --- |
| `routes.ts` | `/api/deploy`: GET overview, discover, status, teardown, plans, drift, job logs, container logs; POST operations, cancel, preferences. Behind the existing token, host and origin guards. |
| `registry.ts` | The only operations: `deploy-plan` (optionally `autoApply` for dev), `deploy-apply`, `deploy-discard`, `destroy`, `export`, `local-start`, `local-stop`, `local-restart`, `local-attach-watch`, `deps-install`, `docker-start`, `aws-login`, `drift`. Parameters are validated (profile must be configured, names match the deployment pattern, plans are Studio's own); argv is fixed; no shell. |
| `jobs.ts` | Attached children, numbered log lines (memory plus JSONL on disk), a lock per deployment and for local work, process-tree cancellation, records that survive a restart (a job that was running is reported interrupted, never resumed). |
| `observe.ts` | AWS reads only through `deploy:status` (profiles, discover, status, watch) and `destroy:resources --plan`, with short caches and shared in-flight reads. |
| `prereqs.ts`, `local.ts`, `local-commands.ts` | Tool probes; containers by Compose label; exported files; the direct commands for the web client and the watch. |
| `process.ts`, `tether.mjs` | Spawning with a curated environment (static AWS keys, `AWS_PROFILE`, `PROD_DEPLOYMENT` and `FRAMEWORK_MODE` dropped; `FRAMEWORK_DEPLOY_VIA=studio`), and the tether that stops a program when Studio's pipe closes. |

### Safety, as enforced

- Every rule in §9 is still enforced by the scripts; Studio adds checks in front of them,
  never instead. Production is only planned from Studio: one-click apply is refused for it,
  and its apply needs the typed name when the plan says so (428 otherwise).
- Deletion always needs the typed name, for development too, and shows the teardown plan
  (order, termination protection, what is retained or snapshotted, managed secrets) first.
- A deployment discovered in the account but not declared here is read-only, except for
  deletion.
- Secret values never reach Studio: plans, logs and events carry names only (tested with a
  sentinel value through a full deploy).
- A change-set plan records each change set before preparing it (`preparing.json` in the
  plan directory). If planning fails or is cancelled part-way, `--discard` still removes
  what it prepared, and Studio lists the plan as unfinished with Discard as its only action.
- A target pinned to a region is read from that region, as deploying it would use; a plan
  under review is never replaced by another that finishes meanwhile; installing
  dependencies runs alone; a verified development apply holds the exports lock, since it
  rewrites this machine's settings.

### Local processes and restarts

Containers outlive Studio on purpose. The watch and the web client must not, however Studio
ends. On Windows a Node parent takes its Node descendants with it, but not past another
program: `npm run dev` puts `cmd.exe` before Vite, and `docker compose` runs Compose as a
plugin of `docker.exe`. So Studio runs client-app's dev script's program directly with Node,
and the Compose plugin binary directly (`docker-compose --project-directory <root> watch
--no-up`). On macOS and Linux the tether stops them. After a restart Studio finds the
containers by label and offers **Resume watching**.

### Departures from the plan

- **Restart reconciliation** reports interrupted jobs and rereads AWS; it does not keep a
  separate intent record per operation. The job record is the record.
- **Reconcile** is not a separate plan type: the findings name the next step, and every
  step is an ordinary operation. Development's one click is plan-then-apply in one job, and
  continues to apply only when the plan needs no confirmation.
- **Adoption, orphan-stack removal and recovery operations** (continue-update-rollback,
  deleting a failed stack on its own) are not built. Failed first creates and paused updates
  recover by deploying again (the CDK CLI handles both); a stuck rollback is shown with
  console guidance and the delete action.
- **Termination protection** for production is not switched on by deploys.
- **Drift** runs CloudFormation drift detection (it changes no resource, but it is not a
  read); it is offered, never run automatically.

### Test seams

| Variable | Replaces |
| --- | --- |
| `FRAMEWORK_AWS_CLI`, `FAKE_AWS_STATE` | The AWS CLI (`cdk-app/test/support/fake-aws.mjs`) |
| `FRAMEWORK_CDK_CLI` | The CDK CLI (`cdk-app/test/support/fake-cdk.mjs`) |
| `FRAMEWORK_DOCKER_CLI`, `FAKE_DOCKER_STATE` | Docker, in Studio and `dev.mjs` (`framework-studio/test/support/fake-docker.mjs`) |
| `FRAMEWORK_EXPORT_DIRECTORY` | Where export writes, and where status and Studio read exported files |
| `FRAMEWORK_STUDIO_STATE_DIRECTORY` | Studio's jobs, plans, preferences and run record (default `.cache/framework-studio`) |
| `FRAMEWORK_POLL_MS` | Poll intervals |

`framework-studio/test/deploy-service.test.ts` drives the real routes and scripts against
these: discover, a development deploy with verification and export, a production change-set
plan that first needs its secret created, local start and stop, teardown.
`deploy-ui.test.ts` drives the page in a DOM.

### Not verified here

A deploy, apply or teardown against real AWS, and starting the real Docker stack, need your
authorization and were not run. Read-only discovery and status were run with the `dev`
profile against 734849394764/us-east-1.
