# Framework Studio: one Dev|Prod model for environment variables

You are working autonomously in `/Users/matt/Desktop/code/framework-fix/matts-aws-framework`.
It is a TypeScript npm-workspace monorepo: an AWS application framework plus **Framework
Studio**, a local, source-linked visual editor (`framework-studio/`). Make the changes
below, then verify them. The user wants finished, verified work. A plan alone is not enough.

---

## Part 0: Ground rules (apply to every workstream)

1. **Read before you change anything:** `AGENTS.md`, then
   `docs/aws-studio-knowledge/README.md` (the knowledge router). From the router, load only
   these pages: `deployment/secrets.md`, `runtime/environment.md`,
   `deployment/environments.md`, `studio/editing.md`, `studio/graph-model.md`. Also read
   `docs/framework-studio/inspector-design.md` and `docs/framework-studio/ui-design-system.md`.
   Check every contract this prompt cites against current source. This prompt was
   written against commit `9fc3844` with a clean tree. Line numbers may have drifted.
2. **Other agents share this checkout.** Run `git status` before you start, before each
   phase and before you report. Never revert or overwrite changes you did not make. If
   another agent is changing a file you need, work around it and report the conflict.
3. **Never restart or disturb the user's Studio on http://127.0.0.1:4590.** For browser
   checks, start your own instance:
   `node --import tsx framework-studio/server/index.ts --port 4591` (in the background),
   and stop it when you are done. API calls need the page's
   `<meta name="studio-token">` value as the `x-studio-token` header, plus
   `x-studio-protocol` (currently `"6"`, from `framework-studio/shared/protocol.ts`).
   Playwright is not a repo dependency. A copy is cached at
   `/Users/matt/.npm/_npx/31e32ef8478fbf80/node_modules/playwright` (load it with
   `createRequire`; chromium-headless-shell is installed). Use `colorScheme: "dark"`.
   The sr-only list `.landscape-entity-list button[data-hover-kind]` contains one button
   per map entity. Click one with `el.evaluate(b => b.click())`; a normal Playwright
   click hangs on the visibility check. The click opens that entity's inspector in
   `.workspace-panel`.
4. **The user often runs `npm run dev:containers` (Compose Watch).** Editing
   `framework.config.ts`, `framework-config/**` or `packages/framework/src/**` restarts
   their live containers. That is acceptable for real source changes. Do **not** make
   temporary or experimental edits to the real config. Use fixtures or a scratch copy.
5. **Secrets and values.** Never print, log, screenshot into the repo, or commit values
   from `cdk-app/.env.dev`, `cdk-app/.env.prod` or `client-app/.env*`. The graph and
   snapshot carry names, presence and metadata only. A secret never gets a source
   default and is never mapped into the client. Never hand-edit generated files (the
   list is in AGENTS.md).
6. **Studio UX rules the user has set:**
   - No transition or entrance animations.
   - Generated copy must never repeat what an adjacent line already says.
   - Qualify Dev/Prod only where the two environments differ.
   - **Exception:** aggregated rows (connections, input groups) keep a Dev|Prod pill pair
     beside every field, even when every field shares one availability. Do not hoist
     those pills to the title.
   - Use one vocabulary everywhere.
   - Prefer explicit config that reads naturally, and literal-string unions with type
     completion over booleans.
   - When an option is an AWS trap, say so and offer a better alternative instead of
     implementing it silently.
7. **Finish with `npm run verify`** and the relevant workspace test suites, then do a
   browser pass on :4591 (Part 5).

---

## Part 1: The user's intent (their words, lightly organised)

The user looked at the **CDK environment files** island, opened `cdk-app/.env.prod` in
the inspector, and said:

> Every variable has a sub header dubbed "configured", then at the very bottom of the
> scrollable view we have the expandable menu "Not set in this file". Remove the
> redundant "configured" sub headers. Then, intelligently and dynamically: if a variable is
> defined in either counterpart (`cdk-app/.env.prod` / `cdk-app/.env.dev`), it should just
> exist in the other env file, even if it's empty. Then we won't need "Not set in this
> file" either.
>
> We map these env variables into **Input parameters and secrets**. So if an env var is
> defined in Input parameters and secrets, it should appear in the .env files and
> dynamically show its default value. Even if it's empty in the env file, we can see
> whether it has a default.
>
> We should be able to mark an input parameter or secret as **required** and leave it
> without a default. When that's the case, the env files should show a flag and label on
> that variable saying it's required. And we should be able to say whether a parameter
> or secret is required by **dev and/or prod** separately.
>
> In the **client-app environment** file there is currently logic to toggle whether dev
> or prod should be mapped from inputs and params. If a client var maps from inputs and
> params, we should **infer** whether it's dev or prod. "Input parameters and secrets"
> can be the defining layer, based on: whether a param/secret is required, whether it
> has a default for prod|dev, and whether the CDK env files for dev|prod have a value.
>
> I really want the best model for dev|prod logic, defined and inferred as elegantly as
> possible.

Treat this as the goal, not as a literal spec. Where a literal reading would cause harm
(see the traps in Part 2.4), implement what the user is actually after and explain the
difference in your report.

---

## Part 2: What exists today (checked against the source)

### 2.1 Three surfaces, three separate dev|prod mechanisms

| Surface | Where | How dev/prod is expressed today |
| --- | --- | --- |
| **CDK env files** (`envfile:dev`, `envfile:prod`) | `framework-studio/server/deployment-inputs.ts` (`withDeploymentInputs`), `framework-studio/src/views/DeploymentInputs.tsx` (`EnvironmentFileView`) | Two separate files. Each file's rows are the union of its own keys, its template's keys, and catalog `fromEnv` names (`deployment-inputs.ts:84`). Whether a row applies in that mode is not modelled. |
| **Input parameters and secrets** (catalog) | `framework-config/resources/inputs.ts`, `packages/framework/src/config/resources.ts` (builders around lines 330–372), Studio `src/views/ResourceEditor.tsx`, `src/views/LocalValue.tsx`, `server/input-requirements.ts`, `server/resources-source.ts` | **Presence:** the ternary `PROD_DEPLOYMENT ? undefined : resource.fromEnv(...)` (`client.*` in inputs.ts). **Required:** `.required()` is one global boolean, plus per-workload `cloud.requirements` with `when` conditions (e.g. `framework-config/shared/models.ts`: `OPENAI_API_KEY` is required when `LANGGRAPH_MODEL_PROVIDER = openai`). **Default:** `.default(v)` is a single value. |
| **Client-app env** (`client-envfile`) | `framework-config/client-environment.ts`, `scripts/client-environment-mapping.ts`, `framework-studio/shared/client-environment-preview.ts`, `src/views/ClientEnvironment.tsx`, `scripts/client-environment-export.ts` | Every field has hand-written `dev` and `prod` bindings, plus `enabled: false` toggles driven by Dev/Prod pills. Some fields restate the same binding in both modes (all four Cognito fields). Others restate the fact that a dev-only input is absent in prod (`prod: { kind: "empty" }` on `VITE_LOCAL_WS_URL` and `VITE_WS_TESTER_URL`). |

These three mechanisms do not inform one another. That is the root cause of what the
user sees.

### 2.2 What the env file inspector shows today

Studio snapshot at `9fc3844`. Names only; no values were read.

- `DeploymentInputs.tsx:91` prints `metadata?.status ?? "configured"` under every row,
  so 24 of the 30 prod rows say "configured" and nothing else.
- `DeploymentInputs.tsx:100` adds "Not set in this file" with "Referenced by the example
  or resource catalog." For **prod** it lists `LOCAL_API_DEV_SERVER_HOST_PORT`,
  `LOCAL_WS_DEV_SERVER_HOST_PORT`, `WS_TESTER_HOST_PORT` and `VITE_API_GATEWAY_URL`.
  Those are `client.*` inputs that are **absent in the prod graph** (dev-only by
  ternary), so prod is inviting the user to add lines nothing in prod will read. It also
  lists `ENABLE_WEBSOCKET_API`, which has a default of `"true"` and drives conditional
  deployment of five WebSocket handlers. Nothing on that row says so.
- "empty · declaration default applies" appears on `LANGGRAPH_*`, but the default
  itself is never shown (`bedrock-mantle`, `gpt-4.1-mini`, …).
- Enum inputs such as `LANGGRAPH_MODEL_PROVIDER` get a free-text `<textarea>` in the file
  editor, while the input's own inspector (`LocalValue.tsx`) uses a `<select>`.
  Single-line values render as resizable textareas.
- **Most rows have no owner Studio knows about** (`targets: []`): 15 of the 26 dev rows
  and 19 of the 30 prod rows. There are four real owners outside the catalog, plus
  orphans:
  1. **Database setting overrides.** These are `DATABASE_*` in
     `packages/framework/src/config/database.ts` (`DATABASE_SETTING_INPUTS`, about line
     37) and `resolveDatabaseSettings`. Precedence is CDK context, then the env line,
     then `defineDatabase({ settings })` in
     `framework-config/databases/application/index.ts`, then the framework fallback. The
     declaration's own comment says: *"Removing an override lets this declaration supply
     the setting."* Yet `cdk-app/.env.prod.template` writes every default out explicitly.
     Every prod `DATABASE_*` line therefore restates the declaration, and the inspector
     can't show that.
  2. **Deployment policy flags** read in `cdk-app/deployment.ts` (`resolveDeploymentInputs`):
     `SKIP_EMAIL_VERIFICATION` (dev-only; **production refuses it**, ~line 86),
     `COGNITO_SES_*`, `USE_COGNITO_CUSTOM_DOMAIN` + `COGNITO_DOMAIN_*`,
     `USE_FRONTEND_CUSTOM_DOMAIN` + `FRONTEND_URL` + `FRONTEND_CLOUDFRONT_CERTIFICATE_ARN`,
     `RETAIN_STATEFUL_RESOURCES`, `GOOGLE_CLIENT_ID`, and others. Also `CDK_APP_NAME`:
     dev names the deployment with it, while a prod target ignores it with a warning
     (~line 69).
  3. **Local and Compose runtime** (dev-only): `LOCAL_*` ports, `POSTGRES_HOST_PORT`,
     `PGADMIN_HOST_PORT`, `LOCAL_AWS_PROFILE`/`REGION`, `LOCAL_DEV_URL`,
     `LOCAL_LAMBDA_WARM*`, `LOCAL_TEST_USER_*`. Readers: `docker-compose.yml`,
     `scripts/local-export.ts`, `packages/framework/src/local/*`,
     `packages/database/scripts/seed-test-user.ts`, and
     `packages/framework/scripts/check-local.ts`.
  4. **Retired or legacy keys.** `DEPLOY_PROD_WEBSOCKET_API` is in **both** of the user's
     files and is shown as plain "configured". It is retired (`docs/FRAMEWORK.md` ~1089;
     `cdk-app/deployment.ts` ~153 warns on `true`) and replaced by `ENABLE_WEBSOCKET_API`.
     `PROD_DEPLOYMENT` is also legacy.
- Templates `cdk-app/.env.{dev,prod}.template` are hand-maintained. They restate
  defaults that already live in declarations. `packages/framework/scripts/check-repository.ts`
  (`undocumentedRequiredInputs`) only checks that required workload inputs are listed.

### 2.3 What the input inspector shows today (`enableWebSocketApi`)

- "Connected workloads: **No workloads use this input yet**"
  (`WorkloadPermissions.tsx:193`). The same inspector then lists five WebSocket workloads
  under "Workload requirements", and the map draws five `deployWhen` edges plus a client
  mapping. "Connected" counts only env reads. It ignores `deployWhen` and `maps`.
- "Local value" edits only the **currently selected graph's** file. Nowhere does the
  inspector show Dev and Prod side by side.
- "Required input" is one switch, and "Default value" is one value. Neither can be set per
  mode. The Dev/Prod pills in the header reflect presence (the ternary) but cannot be
  edited.
- The creation wizard (`framework-studio/shared/creation.ts` ~line 106) offers
  `required: boolean` for input and secret, but no environment scope. Stacks and auth
  providers in the same file do offer `scope: "both" | "dev" | "prod"` (~lines 36, 39).
- `server/resources-source.ts` `builderExpression` (~lines 54–100) preserves a
  `PROD_DEPLOYMENT ? … : undefined` ternary. It refuses any conditional where both
  branches are declarations, so a per-mode default or requirement cannot be written as
  a ternary today.

### 2.4 Traps in the literal request (design around these; don't ignore them)

- **"If it's defined in one file, it exists in the other"** is right for variables that
  apply in both modes, and wrong for mode-scoped ones:
  - `SKIP_EMAIL_VERIFICATION=true` in prod is a synth **error**.
  - `CDK_APP_NAME` in prod is ignored with a warning.
  - `DATABASE_*` in dev is inert, because dev builds no RDS.
  - `LOCAL_*` ports in prod are inert.

  The union must be filtered by **where the variable applies**, and showing a row must
  not silently write a line. Writing an empty line is only safe when the owner treats
  blank as unset. Verify each owner's blank handling: `optionalBoolean`, `stringFlag`,
  `resolveDatabaseSettings` `read`.
- Named prod targets can point at a custom inputs file (`cdk.json` → `framework:targets`
  → `inputs`). Studio addresses only the two conventional files by design. Keep it that
  way; model per **mode**, and let the file path come from selection.
- The client export writes `client-app/.env.development.local` and
  `client-app/.env.production.local` (`scripts/environment-export.ts`). The island is
  titled and pathed as `client-app/.env`. Keep that in mind when you name things.

---

## Part 3: The target model

### 3.1 Principles

1. **Each variable has exactly one declared owner.** That owner answers four questions
   per mode, and nothing else restates the answers:
   - **Applies:** is the variable read in this mode at all?
   - **Default:** what value applies when the line is blank or missing? (A literal, a
     declaration such as a `defineDatabase` setting, a framework fallback, or none.)
   - **Required:** always, in specific modes, or conditionally ("when
     `LANGGRAPH_MODEL_PROVIDER` = `openai`", from active workloads' `cloud.requirements`)?
   - **Sensitive / choices:** is it a secret, and is it an enum?
2. **Env files store values only.** Templates, the env-file inspector, the input
   inspector, client mappings and generated client files are all *derived* from the
   owners plus the file values.
3. **Dev|Prod pills are the one visual vocabulary for per-mode facts.** Reuse
   `EnvironmentPills` (`src/views/DeploymentBadge.tsx`) and `catalogAvailability`
   (`src/deployment.ts`). Do not invent a second idiom.
4. **Inference over toggles.** If a fact follows from declarations, show it as derived
   and don't ask the user to toggle it. Keep an explicit override only where real
   ambiguity remains.
5. **Showing is not writing.** Studio writes a line only through the existing reviewed
   draft (`draft.setEnvironment` → plan → apply), and only when the user acts.

### 3.2 The catalog API (framework layer)

Design the declaration surface in `packages/framework/src/config/resources.ts` so that
per-mode **presence**, **requirement** and **default** are first-class, literal, typed
and editable by Studio. My recommended shape is below. You may improve it. If you
diverge, justify the change in your design note.

```ts
// Both modes (unchanged).
resource.fromEnv("LANGGRAPH_MODEL_PROVIDER").enum("bedrock-mantle", "bedrock", "openai").default("bedrock-mantle")

// Present only in one graph. Same semantics as today's
// `PROD_DEPLOYMENT ? undefined : …`: an absent reference that still type-checks everywhere.
resource.fromEnv("LOCAL_API_DEV_SERVER_HOST_PORT").only("dev")

// Required per mode. `.required()` with no argument keeps meaning "both modes".
resource.secret("GOOGLE_CLIENT_SECRET").required("prod")

// A per-mode default, for inputs only. A secret's `.default()` stays a type error.
resource.fromEnv("LOCAL_LAMBDA_WARM").default({ dev: "true", prod: "false" })
```

Requirements:

- Reuse the vocabulary that already exists: `CloudMode` = `"dev" | "prod"`, and the
  `"both" | "dev" | "prod"` scope in `shared/creation.ts`. Check the workload `deploy:`
  vocabulary too. Pick one name for "present only in" and use it everywhere: API,
  Studio copy, creation wizard.
- Reject contradictions at declaration time with refusals that name the fix. Examples:
  `.only("dev")` together with `.required("prod")`; a `.default({ prod })` on a dev-only
  input; a per-mode default outside `.enum()` choices.
- Keep the module browser-safe and serializable (see its header). Per-mode metadata
  must become plain data on the `ResourceReference`. Absence must still resolve the
  way `PROD_DEPLOYMENT` does today, and `stableStringify` agreement must keep working.
- **Update the header doc in `resources.ts`.** It currently says *"Nothing here
  annotates a resource with the deployments it belongs to."* If you add per-mode
  declarations, rewrite that rationale honestly. Keep ternary support for stacks
  (`rds`) and for existing catalogs, and decide whether `client.*` in
  `framework-config/resources/inputs.ts` migrates to the new form. Recommendation:
  migrate it, because it is the canonical example.
- **Make the CDK lane and the local lane enforce per-mode requirements identically.**
  The shared policy lives in `packages/framework/src/config/requirements.ts`. Keep it
  the single place that decides.
- `server/resources-source.ts` must round-trip the new builder calls. Studio must be able
  to toggle presence, per-mode required and per-mode default from the inspector,
  through a reviewed source diff.

### 3.3 Owners that are not catalog inputs

Give each one a typed descriptor table, exported from the code that reads it, so
Studio can import names, modes, defaults, choices, refusals and one-line descriptions
instead of guessing:

- **Database overrides:** `DATABASE_SETTING_INPUTS` already exists. Add the effective
  default per field (declaration value, else framework fallback) and mode = prod. Studio
  should show "Same as declaration" when an override equals the declared setting, and
  offer to remove the line (reviewed).
- **Deployment policy:** extract a descriptor table from `cdk-app/deployment.ts` (or a
  framework module, whichever owns it more naturally). Include `refusedIn: "prod"` for
  `SKIP_EMAIL_VERIFICATION` and the ignored-in-prod note for `CDK_APP_NAME`.
  `resolveDeploymentInputs` must read through the same table, so the two can't drift.
- **Local/Compose runtime:** one dev-only descriptor table. Find the right owner
  (`scripts/local-export.ts`, `packages/framework/scripts/check-local.ts`, or the
  framework's local module).
- **Retired keys:** a small table (`DEPLOY_PROD_WEBSOCKET_API` → `ENABLE_WEBSOCKET_API`,
  `PROD_DEPLOYMENT` → `-c prodDeployment`). Studio flags these as "Retired" with the
  replacement and offers a reviewed rename or remove.
- **Anything in a file that no owner claims** is shown as "Not read by anything", with a
  reviewed remove action. Never delete automatically.

Then decide on **templates**. Recommendation: generate `cdk-app/.env.{dev,prod}.template`
from the owners: comments from descriptions, defaults as commented lines, required
inputs uncommented and blank. Add the generator to the generated-artifact check in
`npm run verify`, the same way GraphQL and framework artifacts are checked. If you
generate them, keep their comment quality: cost, constraints, and AWS traps stated
plainly. The current templates' prose is good; preserve it as descriptor text. Move
`undocumentedRequiredInputs` onto the same data. If you decide against generation,
explain why and add a drift check instead.

### 3.4 The server read model

Build one server-side read model of every variable across both modes. Studio already
evaluates the dev and prod graphs, so per-mode facts can be computed by reading both
`ModeModel`s together; `withDeploymentInputs(..., models)` already receives both. For
each variable it should hold:

```
name, owner (catalog id | database field | deployment flag | local | retired | unowned),
sensitive, choices?,
per mode: { applies, inFile: "set" | "blank" | "absent", default?: { value, source },
            requirement: "required" | "optional" | { when: { name, equals }, reason },
            effective: "file" | "default" | "none", status: "ok" | "missing-required" | "refused" | "retired" | "unread" }
```

Keep values out of the snapshot. Only the existing protected details endpoint
(`api.inputDetails`) returns values. The `default.value` of a non-secret declaration is
source metadata, not an authored value, so it may appear in the graph (the snapshot
already carries `resource.default`). Reuse `inputRequirements` instead of creating a
second evaluator. Feed this model to the env file inspector, the input inspector, the
input group, connection hovers (`src/connection-presentation.ts` "Not set in this
file." ~line 89/335) and the client preview.

---

## Part 4: Work plan

Do these in order. Before Phase B, write a short design note (one page) in
`docs/framework-studio/` that states the final API names, the owner tables, the read
model shape, and each decision you made against a recommendation here. Update the
affected canonical knowledge pages (`deployment/secrets.md`, `runtime/environment.md`,
`studio/editing.md`, the `docs/FRAMEWORK.md` resources section) as contracts change. Run
`node docs/aws-studio-knowledge/check.mjs`.

### Phase A: Framework declarations (3.2)
Per-mode presence, required and default on the catalog builders, with types, runtime
validation, serialization, and requirement-policy enforcement in both lanes. Add tests
next to the existing framework config tests for:
- each builder form
- each contradiction refusal
- absent-in-other-graph semantics
- per-mode required in CDK synth (fixture) and the local lane

Migrate `framework-config/resources/inputs.ts` `client.*` if you adopt the new form.
Then run `npm run framework:check` and synth both modes as documented in
`docs/FRAMEWORK.md`.

### Phase B: Owner tables and templates (3.3)
Descriptor tables for database overrides, deployment flags, local runtime and retired
keys. Readers go through the tables. Then template generation or a drift check.
`cdk-app` tests stay green, including `database-settings.test.ts` and the deployment
isolation and auth tests that mention the retired flag.

### Phase C: Server read model (3.4)
Replace the ad-hoc union in `withDeploymentInputs` with the cross-mode model. Extend
`framework-studio/test/deployment-inputs.test.ts` and `input-requirements.test.ts` to
cover:
- dev-only, prod-only and both
- a default in one mode only
- required in one mode only
- a conditional requirement
- a retired key
- an unread key
- refused-in-prod

### Phase D: CDK env file inspector (`EnvironmentFileView`)
- **Remove the per-row "configured" line.** A row shows text only when it says
  something the value box doesn't. Allowed examples: `Required`,
  `Required when LANGGRAPH_MODEL_PROVIDER = openai`, `Retired → ENABLE_WEBSOCKET_API`,
  `Not read by anything`, `Same as declaration`.
- **Remove "Not set in this file".** Every variable that **applies in this mode** gets a
  row in this file's list, whether or not the file has the line yet. An absent line
  shows an empty control. Typing into it stages a `create` edit through the existing
  draft. Rows that apply only in the *other* mode do not appear here. If you think a
  hint helps, use one quiet line at the end, e.g. "6 development-only variables".
  Never show a sentence per row.
- **Defaults are visible in place.** Use a placeholder "Default · bedrock-mantle" (or
  "Declaration · db.t3.micro" for database overrides). Use a `<select>` for enums (reuse
  the `LocalValue.tsx` pattern), a single-line input for single-line values, and a
  textarea only for multiline values. Secrets keep the masked control.
- **Required flag:** a visible badge when the variable is required in this mode, with
  the reason (from `reasons`). Tint the row as "missing" when it is required and no
  value or default supplies it.
- **Per-row Dev|Prod pills show where the variable applies.** For a catalog entry, the
  pills are **editable** from the row and stage the reviewed source change from Phase
  A. For non-catalog owners they are read-only and link to the owner. Each row keeps a
  link to its owner (catalog entry, database declaration field, deployment setting,
  local runtime).
- Sort or group rows by owner (Inputs and secrets / Database / Deployment / Local
  runtime / Retired & unread). If you group, keep search working across groups.
- Keep "File and template", generation, and the description section. Fold the
  "Required inputs (N)" section into the per-row badges plus a one-line summary at the
  top, if you can do that without losing the "Set X" jump.
- Fix the island inspector (`IslandInspector.tsx` ~line 46–53). Today each file row says
  "exists" and then a sentence repeats "Both files exist." Replace that with what is
  useful per file: count of required-missing, count of retired/unread, last-modified.

### Phase E: Input parameter and secret inspector (`ResourceEditor`, `LocalValue`)
- **Show Dev and Prod side by side.** One block per mode, with value (from that mode's
  file; secrets masked), effective source, requirement, and default. The user should be
  able to set both without switching the global graph. The existing draft keys
  environment edits by mode; confirm it can stage edits to both files in one review.
  If it can't, add that.
- Replace the single "Required input" switch and "Default value" switch with per-mode
  controls backed by Phase A, using the Dev|Prod pill idiom. Example: a "Required in"
  pill pair, a "Present in" pill pair, and a default field per mode that collapses to
  one when both modes match.
- Fix "Connected workloads". It must count every consumer kind: env reads, secret
  reads, `deployWhen`, `cloud.requirements` selectors, and client `maps`, labelled by
  role. Never say "No workloads use this input yet" while the same panel lists
  consumers.
- Add the presence scope (`both | dev | prod`) and per-mode required to the input and
  secret creation wizard (`shared/creation.ts` and `CreationWizard.tsx`), matching the
  stack and auth-provider scope field.
- Update the input-group inspector (`InputGroup.tsx` `entryStatus`) so each entry shows
  per-mode status with the pills. Keep a pill pair on every row, per Part 0.6.

### Phase F: Client-app env inference
Goal: the client mapping says **what** a field is built from. Whether it exists or is
empty in each mode follows from the catalog and stacks.

- **Collapse identical bindings in source.** Today:
  `VITE_USER_POOL_ID: { dev: X, prod: X }`. Change the format so it accepts a single
  binding for both modes, `VITE_USER_POOL_ID: { kind: "output", … }`, and keeps
  `{ dev, prod }` only when the two differ. Update `clientMappingsError`,
  `parseClientMappings`, `rewriteClientMappings` (which must round-trip and preserve
  comments), the exporter, and `framework-config/client-environment.ts`. Migrate the
  file through the rewriter, not by hand. Keep backward-compatible parsing of the old
  two-key form.
- **Infer per-mode availability.** In `previewClientBinding` and the exporter, a binding
  whose input is **absent** in a mode (e.g. the dev-only `LOCAL_WS_DEV_SERVER_HOST_PORT`)
  resolves to "not generated in that mode" (or empty; see below), and needs no
  `prod: { kind: "empty" }`. A stack output from a stack that is absent in a mode is
  treated the same way, which replaces the `optional` flag where you can prove it is
  equivalent.
- **Decide empty versus omitted from client usage.** Check `client-app/src` and
  `ws-tester/src`: `VITE_LOCAL_WS_URL`, `VITE_API_GATEWAY_WS_URL` and
  `VITE_WS_TESTER_URL` treat empty and absent the same; `VITE_COGNITO_DOMAIN` throws if
  missing. Choose one rule, write it into the design note, and apply it. My
  recommendation: an inferred-unavailable field is omitted. Keep explicit
  `kind: "empty"` only where a value must be written as blank.
- **Required propagates.** If a client field maps from an input that is required in a
  mode, the field is required in that mode. If it maps from an optional input with no
  default and the env file is blank, show "Will be empty" in that mode's preview, so a
  blank `VITE_*` value can't reach a build unnoticed.
- **Inspector:**
  - Each field row's Dev|Prod pills become *derived* by default: lit where the field
    will be generated, with a hover reason such as "LOCAL_WS_DEV_SERVER_HOST_PORT is
    development-only".
  - Keep a manual "Omit in this mode" override only if a real case still needs one, and
    show the override distinctly from the derived state.
  - Drop the global Development/Production segmented switch if every row can show both
    modes at once (`binding` per mode, or one shared binding). If you keep it, state why
    in the design note.
  - Rewrite the help copy ("Each field's Dev / Prod pills choose which environments
    generate it…") to match the new model.
- Make the **island/file naming honest**: the generated files are
  `client-app/.env.development.local` and `.env.production.local`. Decide whether the
  island shows one "Client environment" entity with two outputs, mirroring the CDK env
  files island, and make the header, path and hover copy say the same thing.
- Keep every existing guard: no secret inputs in the client, public outputs only, URL
  protocol validation, round-trip refusal.

---

## Part 5: Verification

1. Unit and integration tests for every phase, in the existing test files listed above,
   plus `framework-studio/test/client-environment*.test.ts`,
   `resources.test.ts`, `connection-presentation.test.ts`, `draft-ui.test.ts`,
   `cdk-app/test/environment-export.test.ts`, `database-settings.test.ts`, and
   `packages/framework` config tests.
2. `npm run verify`. Run `npm run framework:check`. Synth both explicit modes
   (`docs/FRAMEWORK.md` documents the commands). Synth must not need AWS writes. Never
   deploy, never `deploy:resources`, never upload secrets.
3. **Browser pass on :4591** (dark scheme). Screenshot into a scratch directory, never
   into the repo. Then stop the server.
   - `cdk-app/.env.prod` and `.env.dev` inspectors:
     - no "configured" lines and no "Not set in this file"
     - defaults visible
     - enum as select
     - required badges
     - retired `DEPLOY_PROD_WEBSOCKET_API` flagged
     - dev-only `LOCAL_*`/`client.*` rows absent from prod
     - `SKIP_EMAIL_VERIFICATION` absent from prod or marked refused
   - `enableWebSocketApi`, `openaiApiKey` and the `client` group:
     - side-by-side Dev/Prod
     - per-mode required and default controls
     - "Connected" lists the WebSocket handlers
   - Client env inspector:
     - derived pills
     - `VITE_LOCAL_WS_URL`/`VITE_WS_TESTER_URL` are dev-only by inference, without an
       explicit prod `empty`
     - Cognito fields show one shared binding
   - Stage edits in both env files and one catalog change, open review, check the diff,
     then **discard**. Don't apply changes to the user's real env files. Apply only
     against fixtures.
   - Check that every map hover touching env files and inputs reads cleanly. Focus each
     relevant `.landscape-entity-list` button and screenshot
     `.landscape-hover[role=tooltip]`.
4. `git status`: only intended files changed, and no env values or screenshots in the
   tree.

## Part 6: Handoff report

End with a concise report for the user:

1. **Final model:** the API names and one example per form.
2. **Decisions:** each place you diverged from this prompt's recommendations, and why.
3. **What changed in each surface:** before and after, one line each.
4. **Checks run:** exact commands and results. Say plainly which checks failed or were
   skipped.
5. **Not verified:** for example real AWS synth with credentials, or a live
   `dev:containers` restart.
6. **What the user must do:**
   - Remove retired keys from their local env files (Studio offers this in review).
   - Regenerate client env files.
   - Whether their live Compose stack restarted.
7. Anything left for a follow-up.
