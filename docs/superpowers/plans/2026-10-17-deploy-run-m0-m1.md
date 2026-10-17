# Deploy & Run M0–M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the approved Deploy & Run design in the repository (M0). Then make `npm run deploy:resources` refuse to touch a deployment whose deployed identity doesn't match what it is about to deploy, before any secret is written (M1).

**Architecture:**

- **Shared identity logic.** Pure identity parsing and deployment classification go in a new `@repo/framework/deploy` entry point. The CLI and, later, Studio share one rule.
- **The guard.** `scripts/deployment-guard.ts` reads deployed stacks through injected readers (the AWS CLI in production, fakes in tests) and refuses unsafe deployments. It also refuses unsafe production flags.
- **deploy.ts wiring.** `scripts/deploy.ts` calls the guard after the account check and before secret synchronization. It also gains a per-deployment lock, SIGINT-safe cleanup, a sweep of stale assemblies, and `FRAMEWORK_INPUTS_FILE` support (which export also gets).

**Tech Stack:** TypeScript on Node 24 (tsx), `node:test`, AWS CLI v2 (`execFileSync`), CDK CLI 2.1139.

**Spec:** [docs/framework-studio/deploy-and-run.md](../../framework-studio/deploy-and-run.md), committed by Task 1. Approved source: `C:\Users\Matth\.claude\plans\pasted-content-id-7396-i-want-immutable-whisper.md`.

## Global Constraints

- **Preserve unrelated working-tree changes.** The uncommitted Infrastructure work is someone else's, including `scripts/deployment-assembly.ts`, `scripts/cloud-assembly.ts` and `cdk-app/lib/framework/*`. Never stage those files; stage only the files each task names.
- **Do not modify** `scripts/deployment-assembly.ts` or `cdk-app/lib/framework/framework-resources.ts` in M1.
- **Identity output contract, read-only in M1:** Description `framework:deployment:v1`; value is JSON `{version:1, deployment, mode:"dev"|"prod", account:/^\d{12}$/, region}`.
- **Legacy name pattern:** a stack belongs to deployment `D` by name only if it matches `^D-[A-Za-z0-9]+$`.
- **Guard order in deploy.ts:** synth → inspect → **lock** → STS account check → **guard** → parameter-override check → secrets → deploy → export.
- **Production refuses** `--hotswap`, `--hotswap-fallback`, `--no-rollback`/`--rollback=false`/`-R`, `--express`, `--yes`/`-y`, and `--require-approval never`.
- **Fail closed.** An AWS read error during the guard refuses the deploy, with a message saying nothing was changed.
- **Secrets stay out of output.** No secret value may appear in any new message or file.
- **Gate.** `npm run verify` must pass at the end. Never edit generated files.

## Review Focus

1. **Legacy and outputless stacks** (`ROLLBACK_COMPLETE` with no outputs, pre-marker stacks) must be recognised from their template or refused, never treated as absent. Pinned in the Task 3 classify tests: `unmarked` and `template identity`.
2. **Name-prefix lookalikes** (`app-dev-CognitoStack` when deploying `app`) must not be counted as `app`'s stacks. Pinned in the Task 3 candidates test.
3. **`--rollback false` written as two tokens, and `-R`,** must be caught like `--no-rollback`. Pinned in the Task 4 flags test.
4. **A stale lock from a crashed run** (its pid no longer alive) must not block forever. Pinned in the Task 5 lock test.
5. **The deploy-assembly-cleanup fixture** copies script files by name, so new imports break it. Task 6 makes it copy every `scripts/*.ts`.

---

### Task 1: Design record (M0)

**Files:**
- Create: `docs/framework-studio/deploy-and-run.md` (the approved design, with links rewritten relative to `docs/framework-studio/`)
- Modify: `docs/framework-studio/moving-forward.md` (invariants #6, #7, #8)
- Modify: `docs/framework-studio/README.md` (one link to the new document)

- [ ] **Step 1:** Copy the approved design into `docs/framework-studio/deploy-and-run.md`. Rewrite repository links from `framework-studio/...` to `../../framework-studio/...` (and do the same for every other root path).
- [ ] **Step 2:** In `moving-forward.md`, replace the wording of the invariants:
  - **#6:** "Keep values out of the graph. … Deployment status, plans, logs and job records carry secret *names* only."
  - **#7:** "The local boundary. Loopback only, Host check, token, origin check. Processes run only as typed registry operations (fixed script, validated parameters, no shell, explicit cwd). No generic command or file endpoint."
  - **#8:** "AWS only through the repository's scripts. Studio holds no AWS SDK or credentials. Observation (discover/status) is read-only. Cloud writes happen only as an explicit Apply of a reviewed plan, through the same scripts the CLI uses."

  Add "Revised by [Deploy & Run](deploy-and-run.md)."
- [ ] **Step 3:** Commit:

```bash
git add docs/framework-studio/deploy-and-run.md docs/framework-studio/moving-forward.md docs/framework-studio/README.md docs/superpowers/plans/2026-10-17-deploy-run-m0-m1.md
git commit -m "docs: record the Deploy & Run design and revise Studio invariants"
```

### Task 2: Identity parsing (`@repo/framework/deploy`)

**Files:**
- Create: `packages/framework/src/deploy/identity.ts`, `packages/framework/src/deploy/index.ts`
- Modify: `packages/framework/package.json` (exports: `"./deploy": "./src/deploy/index.ts"`)
- Test: `packages/framework/test/deploy-identity.test.ts`

**Interfaces:**
- Produces:
  - `type DeploymentMode = "dev" | "prod"`
  - `interface DeploymentIdentity { deployment: string; mode: DeploymentMode; account: string; region: string }`
  - `const DEPLOYMENT_OUTPUT_DESCRIPTION = "framework:deployment:v1"`
  - `interface ObservedStack { StackName?; StackId?; StackStatus?; StackStatusReason?; CreationTime?; LastUpdatedTime?; Outputs?: {OutputKey?; OutputValue?; Description?}[]; Tags?: {Key?; Value?}[] }`, all strings
  - `parseIdentity(raw: string): DeploymentIdentity`, which throws `Error("Invalid deployment metadata …")`
  - `identityFromOutputs(stack: ObservedStack): DeploymentIdentity | undefined`
  - `identityFromTemplate(template: unknown): DeploymentIdentity | undefined`, where `template` is a parsed object or a JSON string
  - `stackLocation(stackId: string | undefined): { account: string; region: string } | undefined`
  - `index.ts` re-exports `identity.ts` and (from Task 3) `classify.ts`

- [ ] **Step 1: Write failing tests** (`deploy-identity.test.ts`):
  - `parseIdentity` accepts `{"version":1,"deployment":"app","mode":"dev","account":"111122223333","region":"eu-west-2"}`.
  - `parseIdentity` throws `/Invalid deployment metadata/` for `version:2`, `mode:"staging"`, `account:"123"`, a missing region, and non-JSON.
  - `identityFromOutputs` returns `undefined` with no matching output, returns the identity when the output is present, and throws when the marker value is invalid.
  - `identityFromTemplate` finds `Outputs.FrameworkDeployment` `{Description, Value}` in both the object and the string form; returns `undefined` when there are no outputs, when `Value` is a non-string (an intrinsic), and for a YAML string.
  - `stackLocation("arn:aws:cloudformation:eu-west-2:111122223333:stack/App/id")` → `{account:"111122223333", region:"eu-west-2"}`; `undefined` for garbage.
- [ ] **Step 2:** Run `npm --workspace @repo/framework test`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `identity.ts`, `index.ts` and the export entry. The file must not import `src/config/*` at runtime; a type-only import is fine.
- [ ] **Step 4:** Run `npm --workspace @repo/framework test`. Expected: PASS.
- [ ] **Step 5:** Commit:

```bash
git add packages/framework/src/deploy packages/framework/package.json packages/framework/test/deploy-identity.test.ts
git commit -m "feat(framework): add deployment identity parsing"
```

### Task 3: Deployment classification

**Files:**
- Create: `packages/framework/src/deploy/classify.ts` (re-exported by `index.ts`)
- Test: `packages/framework/test/deploy-classify.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `type StackHealth = "complete" | "rolled-back" | "in-progress" | "review" | "failed-create" | "failed"`
  - `stackHealth(status: string | undefined): StackHealth`. The mapping:

    | Statuses | Health |
    | --- | --- |
    | `*_COMPLETE` except `ROLLBACK_COMPLETE` and `UPDATE_ROLLBACK_COMPLETE` | `complete` |
    | `UPDATE_ROLLBACK_COMPLETE` | `rolled-back` |
    | `REVIEW_IN_PROGRESS` | `review` |
    | other `*_IN_PROGRESS` | `in-progress` |
    | `ROLLBACK_COMPLETE` | `failed-create` |
    | everything else (`*_FAILED`) | `failed` |

  - `interface ClassifiedStack { name: string; status: string; health: StackHealth; identity?: DeploymentIdentity; evidence: "output" | "template" | "none" }`
  - `deploymentCandidates(stacks: readonly ObservedStack[], deployment: string): ObservedStack[]`: the identity output names `deployment`, or the name matches `^<deployment>-[A-Za-z0-9]+$`. Regex metacharacters in `deployment` are escaped.
  - `interface DeploymentQuery extends DeploymentIdentity {}`
  - `type DeploymentState`, one of:
    - `{ kind: "absent" }`
    - `{ kind: "ready" | "rolled-back"; stacks: ClassifiedStack[] }`
    - `{ kind: "in-progress" | "failed"; stacks: ClassifiedStack[]; deployable: boolean }`
    - `{ kind: "conflict"; reason: "unmarked" | "inconsistent" | "mixed" | "mode"; stacks: ClassifiedStack[]; message: string }`
  - `classifyDeployment(stacks: readonly ObservedStack[], query: DeploymentQuery, templates?: ReadonlyMap<string, unknown>): DeploymentState`. Only candidates are considered, and identity falls back to `templates.get(StackName)` when outputs lack it. Precedence:
    1. `unmarked`: a candidate with no identity.
    2. `inconsistent`: the identity names another deployment, or the `StackId` account or region differs from the identity.
    3. `mixed`: candidates disagree on mode, account or region.
    4. `mode`: the identity's mode ≠ `query.mode`.
    5. `in-progress`: any `in-progress` or `review`.
    6. `failed`: any `failed` or `failed-create`. `deployable` is true only when every failed stack is `failed-create`, because CDK deletes and recreates those.
    7. `rolled-back`: any `rolled-back`.
    8. Otherwise `ready`.
  - **Every conflict message** names the deployment, account, region, the offending stacks, and a remedy:
    - `mode` → "delete it first with npm run destroy:resources, or deploy under another name";
    - `unmarked` → "inspect it in CloudFormation; it is not adopted automatically";
    - the others say the same in their own words.

- [ ] **Step 1: Write failing tests** (`deploy-classify.test.ts`). The fixtures build `ObservedStack` objects with the v1 output:
  - absent: no stacks → `absent`;
  - all `UPDATE_COMPLETE` → `ready`;
  - one `UPDATE_ROLLBACK_COMPLETE` → `rolled-back`;
  - one `UPDATE_IN_PROGRESS` → `in-progress`;
  - `REVIEW_IN_PROGRESS` with no outputs, but template identity → `in-progress`;
  - template identity: `ROLLBACK_COMPLETE` with no outputs, plus `templates` holding a matching identity → `failed`, `deployable: true`;
  - `UPDATE_ROLLBACK_FAILED` → `failed`, `deployable: false`;
  - mode: an existing prod marker, queried as dev → `conflict` / `mode`, the message matching `/prod deployment/` and `/destroy:resources/`;
  - mixed: one dev and one prod marker → `mixed`;
  - unmarked: `app-CognitoStack` with no outputs and no template → `unmarked`;
  - inconsistent: a marker account ≠ the `StackId` account → `inconsistent`;
  - candidates: for `app`, include `app-CognitoStack` and a marker-named `weird_name`; exclude `app-dev-CognitoStack` and `other-CognitoStack`; `app.v2` is escaped, so `appXv2-Stack` is excluded.
- [ ] **Step 2:** Run `npm --workspace @repo/framework test`. Expected: FAIL.
- [ ] **Step 3:** Implement `classify.ts` and add it to `index.ts`.
- [ ] **Step 4:** Run `npm --workspace @repo/framework test`. Expected: PASS.
- [ ] **Step 5:** Commit:

```bash
git add packages/framework/src/deploy packages/framework/test/deploy-classify.test.ts
git commit -m "feat(framework): classify deployed stacks for a deployment"
```

### Task 4: Deployment guard

**Files:**
- Create: `scripts/deployment-guard.ts`
- Test: `cdk-app/test/deployment-guard.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3 through `@repo/framework/deploy`.
- Produces:
  - `unsafeProductionFlags(args: readonly string[]): string[]` returns the offending flags as written. It recognises the `=value` and the two-token `true|false` forms, `--no-x`, and `-R`/`-y`.
  - `interface GuardReaders { readStacks(): ObservedStack[]; readTemplate(stackName: string): unknown }`
  - `assertDeploymentAllowed(identity: DeploymentIdentity, args: readonly string[], readers: GuardReaders): DeploymentState`:
    1. **Production flags** (prod only): offending flags → throw "Production deployments refuse <flags> …".
    2. **Read stacks:** a `readStacks` error → throw "Unable to read deployed stacks … Nothing was changed."
    3. **Templates:** fetch only for candidates with no output identity. A `readTemplate` error is treated as "no identity".
    4. **Classify,** then allow `absent`, `ready`, `rolled-back`, and `failed` when it is `deployable`. Otherwise throw: the conflict message, or "is in progress" / "needs recovery" with stack names and statuses.

- [ ] **Step 1: Write failing tests** (`deployment-guard.test.ts`):
  - **flags matrix:** for `["--hotswap"]`, `["--hotswap-fallback"]`, `["--no-rollback"]`, `["--rollback=false"]`, `["--rollback","false"]`, `["-R"]`, `["--express"]`, `["--yes"]`, `["-y"]`, `["--require-approval","never"]` and `["--require-approval=never"]`, the result is non-empty. For `["--all","--require-approval","broadening","--rollback","true"]`, it is empty.
  - Prod plus `["--yes"]` throws `/Production deployments refuse --yes/` and never calls `readStacks`.
  - Dev plus `["--yes"]` over `absent` is allowed.
  - Dev over a prod-marked fixture throws `/prod deployment/`.
  - `readStacks` throwing → `/Unable to read deployed stacks.*Nothing was changed/`.
  - `ROLLBACK_COMPLETE` with no outputs: `readTemplate` is called for that stack only, and it is allowed when the template identity matches.
  - `UPDATE_IN_PROGRESS` → `/in progress/`.
  - No secret-looking strings: the error messages match no value from the fixtures' fake `.env`.
- [ ] **Step 2:** Run `npm --workspace cdk-app test`. Expected: the new file FAILS.
- [ ] **Step 3:** Implement `scripts/deployment-guard.ts`.
- [ ] **Step 4:** Run `npm --workspace cdk-app test`. Expected: the guard tests PASS.
- [ ] **Step 5:** Commit:

```bash
git add scripts/deployment-guard.ts cdk-app/test/deployment-guard.test.ts
git commit -m "feat(deploy): refuse deployments that conflict with deployed identity"
```

### Task 5: Deployment workspace (lock and assembly sweep)

**Files:**
- Create: `scripts/deployment-workspace.ts`
- Test: `cdk-app/test/deployment-workspace.test.ts`

**Interfaces:**
- Produces:
  - `sweepStaleAssemblies(cache: string, now: number, maxAgeMs = 24 * 60 * 60 * 1000): string[]`. It removes only directories named `assembly-*` whose mtime is older than the limit, and returns the removed names.
  - `acquireDeploymentLock(cache: string, deployment: string, isAlive = defaultIsAlive): () => void`. It creates `<cache>/<deployment>.lock` exclusively (`wx`), holding `{pid, startedAt}`.
    - If the lock is held by a live pid, it throws: "Another deployment of <d> is running (pid <n>, started <t>). Wait for it to finish, or delete <path> if that process no longer exists."
    - If the pid is dead, it replaces the lock once.
    - The returned release function deletes the file only if it still holds our pid.
  - `defaultIsAlive(pid: number): boolean` uses `process.kill(pid, 0)`: `EPERM` means alive, `ESRCH` means dead.

- [ ] **Step 1: Write failing tests**, using a temporary directory under `.cache/`:
  - **sweep:** it removes an `assembly-old` dated 2 days back (via `utimesSync`), and keeps `assembly-new`, `keep.txt` and `assembly-file.txt` (a file).
  - **lock:** a second acquire throws `/Another deployment of app is running/`. A lock whose `isAlive` returns false is replaced. After release the file is gone. Releasing after another pid has replaced the lock leaves that lock in place.
- [ ] **Step 2:** Run `npm --workspace cdk-app test`. Expected: FAIL.
- [ ] **Step 3:** Implement `scripts/deployment-workspace.ts`.
- [ ] **Step 4:** Run `npm --workspace cdk-app test`. Expected: PASS.
- [ ] **Step 5:** Commit:

```bash
git add scripts/deployment-workspace.ts cdk-app/test/deployment-workspace.test.ts
git commit -m "feat(deploy): add a per-deployment lock and stale assembly sweep"
```

### Task 6: Wire deploy.ts; honor `FRAMEWORK_INPUTS_FILE`; SIGINT cleanup

**Files:**
- Modify: `scripts/deploy.ts`
- Modify: `scripts/export-cdk-outputs.mjs` (around the authored-inputs path, `:159-169`)
- Modify: `cdk-app/test/deploy-assembly-cleanup.test.ts` (copy every `scripts/*.ts` and `*.mjs` into the fixture)
- Test: `cdk-app/test/deploy-assembly-cleanup.test.ts`, `cdk-app/test/export-cli.test.ts`

**Interfaces:**
- Consumes: Task 4 `assertDeploymentAllowed` and Task 5 `sweepStaleAssemblies`/`acquireDeploymentLock`; `readDeploymentStackPages` from `scripts/resource-export.ts`.

- [ ] **Step 1: Write failing tests**, as two new cases in `deploy-assembly-cleanup.test.ts`:
  - **sweep:** a pre-existing `.cache/deploy/assembly-stale`, dated 2 days back, is gone after a failing run, and a fresh `assembly-recent` is kept.
  - **inputs file:** with `FRAMEWORK_INPUTS_FILE` pointing at a fixture file containing `AWS_PROFILE=fixture-profile-from-inputs`, the failing run still exits 1. This only proves the inputs path doesn't crash. Also assert the `.cache/deploy` sweep result.

  Then fix the fixture copy list so the existing tests pass with the new imports.
- [ ] **Step 2:** Run `npm --workspace cdk-app test`. Expected: the new cases FAIL.
- [ ] **Step 3: Change `deploy.ts`:**
  - `inputFile = process.env.FRAMEWORK_INPUTS_FILE ?? resolve(root, "cdk-app/.env")`.
  - `sweepStaleAssemblies(cache, Date.now())` right after `mkdirSync(cache)`.
  - One `runAws(args): any` helper that runs `execFileSync("aws", [...args, "--output", "json", "--region", r, ...profile])` and parses the JSON. Use it for STS too.
  - After `inspectDeploymentAssembly`, `const release = acquireDeploymentLock(cache, graph.identity.deployment)`, released in the outer `finally`.
  - After the STS check, call `assertDeploymentAllowed(graph.identity, args, { readStacks: () => readDeploymentStackPages(token => runAws(["cloudformation", "describe-stacks", ...(token ? ["--next-token", token] : [])])), readTemplate: name => runAws(["cloudformation", "get-template", "--stack-name", name, "--template-stage", "Original"]).TemplateBody })`.
  - **SIGINT/SIGTERM:**
    - On the first signal, print "Interrupted. CloudFormation operations that already started continue in AWS; check the stacks before deploying again." Let the child exit, so the `finally` blocks run.
    - On a second signal, remove the temporary assembly synchronously, release the lock, and `process.exit(130)`.
- [ ] **Step 4: Change `export-cdk-outputs.mjs`:** `authoredEnvPath = process.env.FRAMEWORK_INPUTS_FILE ? resolve(process.env.FRAMEWORK_INPUTS_FILE) : resolve(process.cwd(), "cdk-app/.env")`. The existing refusal to write the output to the authored file compares against this path.
- [ ] **Step 5:** Run `npm --workspace cdk-app test`. Expected: PASS, including `export-cli.test.ts`.
- [ ] **Step 6:** Commit:

```bash
git add scripts/deploy.ts scripts/export-cdk-outputs.mjs cdk-app/test/deploy-assembly-cleanup.test.ts
git commit -m "feat(deploy): guard deployed identity before secrets, lock, and clean up on interrupt"
```

### Task 7: Documentation and the full gate

**Files:**
- Modify: `docs/DEV-DEPLOYMENT.md` and `docs/PROD-DEPLOYMENT.md` (the new refusals, the lock, `FRAMEWORK_INPUTS_FILE` for deploy and export, and that prod deploys can't use `--yes`/`--require-approval never` until reviewed plans exist)
- Modify: `docs/FRAMEWORK.md` (one paragraph in Configuration and environment: deploy verifies deployed identity)

- [ ] **Step 1:** Update the docs. Keep the dev command `npm run deploy:resources -- --all --profile=<PROFILE> --yes` valid.
- [ ] **Step 2:** Run `npm run verify`. Expected: exit 0. Compare against the baseline; any failure that predates this work is reported, not fixed.
- [ ] **Step 3: Manual, read-only live check.** Synth and deploy are **not** run. With the `dev` profile, call `assertDeploymentAllowed` through a one-off `tsx -e` against the real account for identity `{deployment:"my-aws-app", mode:"prod", …}`. Expected: a `mode` conflict naming `my-aws-app` as a dev deployment. This step reads only, and runs only with the owner's go-ahead.
- [ ] **Step 4:** Commit:

```bash
git add docs/DEV-DEPLOYMENT.md docs/PROD-DEPLOYMENT.md docs/FRAMEWORK.md
git commit -m "docs: describe deployment identity guard and production flag refusals"
```
