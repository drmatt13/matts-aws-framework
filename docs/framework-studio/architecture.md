# Framework Studio architecture

How the studio turns `framework.config.ts` into views, and views back into source edits.
The isometric landscape has [its own document](isometric-view.md).

For the current service map, start with [backend boundaries](../aws-studio-knowledge/studio/backend.md)
and [interface workflows](../aws-studio-knowledge/studio/interface.md). This reference retains
the detailed design of evaluation, indexing and editing. Deployment, identity, database
and lifecycle operations have dedicated authorities rather than extending the generic
configuration writer. Source-verified on 2026-10-29; cloud execution is a separate check.

## Shape of the system

```text
Browser (React 19, TanStack Router + Query)
  Isometric · Database · Deploy · Cognito · Domains · WebSockets · Inspector · Edit preview
        │  JSON over /api, server-sent events on /api/events
        │  per-process token, same origin, Host = 127.0.0.1|localhost:<port>
        ▼
Studio server (host process: node --import tsx framework-studio/server/index.ts)
  ├─ Vite in middleware mode: serves the page, injects the token
  ├─ SnapshotBuilder ── EvaluatorPool ──┬─ dev evaluator  (child process)
  │                                     └─ prod evaluator (child process)
  │     each: require(framework.config.ts) → projectModel() → preflight on request
  ├─ Source index: locateConfigSource + TypeScript syntax (spans, editability,
  │     stack-class members, linkResources sites)
  ├─ EditService: plan → preflight → preview → atomic write → confirm → journal
  ├─ InfrastructureService: explicit synthesis → assembly inventory, per-mode last-good state
  ├─ Watcher: framework.config.ts, framework-config/, packages/framework/src/config/,
  │     cdk-app/lib/, .env.dev/.env.prod and their templates (input metadata/flags)
  ├─ CommandRunner: framework:check, framework:generate (fixed argv, no shell)
  └─ Separate services: Deploy, database workbench/history/application, identity,
        private input values, frontend release, stateful lifecycle and source recovery
```

The server never imports the application's config itself. It holds the snapshot the
children produce, the parsed source, and the edit journal.

## Evaluation

[server/evaluator/](../../framework-studio/server/evaluator)

- Each graph is evaluated by a fresh `node --import tsx` child forked from
  `evaluate.ts`. A module graph cannot be reloaded, so a new process is the only way to see
  an edited section module. A refresh replaces both children.
- The child loads `framework.config.ts` with `require`, as tsx gives the studio's CommonJS
  modules. The config and the projection then share one instance of
  `@repo/framework/config`. The workspace's `package.json` therefore has no
  `"type": "module"`.
- `FRAMEWORK_INPUTS_FILE` points at `.cache/framework-studio/inputs-<mode>.env`, which
  holds one line, `PROD_DEPLOYMENT=true|false`. The parent privately resolves declared
  deployment conditions against each mode's input source and returns only holds/fails/unset
  outcomes. Source parameters such as `enableWebSocketApi` resolve their declared public
  value, not an environment-file override. Children inherit the host environment and execute
  trusted repository code; this is module-lifetime isolation, not a secret-proof sandbox.
  See [server/inputs.ts](../../framework-studio/server/inputs.ts).
- The selected-resource endpoint separately reads the selected mode's input file for one declared input
  or secret. Its no-store response goes only to the selected inspector; secrets start
  masked. Resolved environment-file values stay out of snapshots, source diffs and disk
  journals; public source values and declared defaults are ordinary graph metadata.
- Resource previews send source overlays over IPC to fresh evaluator processes. Their
  private compilation hook loads candidate modules without changing authored files.
  Both graphs and TypeScript must accept a preview before applying it. Multi-file moves
  update imported catalog references, retain env names and preserve concurrent edits.
- Messages travel over the IPC channel, because the config may print to stdout.
- A child that does not answer within 60 s (load) or 30 s (preflight), or that exits,
  becomes a failed model, never a stale one.

## The model

[server/model/project.ts](../../framework-studio/server/model/project.ts),
types in [shared/model.ts](../../framework-studio/shared/model.ts)

`projectModel(config, { mode, inputs })` reshapes the framework's answers and
decides nothing itself.

| Part | Source in the framework | Notes |
| --- | --- | --- |
| Targets | `getFrameworkTargets` | Id is the canonical reference (`lambda:graphql-api`). `origins` keeps the logical declaration places |
| Routes | `normalizeFrameworkConfig().http` and `.webSocket`, `getAgentBrowserRoutes` | Ids `route:http:/x`, `route:service:/x/*`, `route:ws:$connect`, `route:agent:/x` |
| Catalog | `config.resources`, walked | Stacks, constructs, inputs, secrets, groups. A stack's members come from what workloads read, plus its class (see Source) |
| Edges | Environment references, secrets, `cloud.bindings`, agent tools, workflow steps and integrations | Id `relation:from->to#n`, so two relations between one pair stay two edges. `provenance` is `declared` or `derived` (for example a user-pool variable handed by `userPool: true`) |
| Deployment availability | `isTargetEnabled`, `isTargetDeployed`, `getToolDeploySetting` | Raw `local`, `cloud` (intent), `dev`, `prod` (outcome) remain available for evaluation. The UI presents Development (`local || dev`) and Production (`prod`) with execution location as supporting detail |
| Placement | `resolveLambdaTarget().subnet`, container `cloud.service/task.subnet`, `subnetEgress`, `usesDualStackEndpoints` | `outside`, `vpc` (with subnet and egress), or `managed` (Step Functions) |
| Networks | `config.networks`, `resolveNetwork`, `endpointServices`, `NETWORK_PRICES` | Each explicit VPC's settings and production-use evidence from workloads, database and discovered native consumers |
| Local database | Authored Compose `services.postgres`, using the framework's Compose parser | Separate `local:postgres` identity; only image, named volumes and source are projected. Local database bindings point here; AWS bindings retain the catalog reference |
| Workflows | `NormalizedWorkflow` | The IR as plain data, its generated state names, targets and integrations |
| Fields | [server/edits/fields.ts](../../framework-studio/server/edits/fields.ts) | Each editable field's authored, effective and inherited value, and provenance |
| Diagnostics | `validateFrameworkConfig` (warnings captured), `assertCloudEdgesResolvable(mode)` | The framework's messages, verbatim, tied to an entity when a message names an origin |

The snapshot ([server/snapshot.ts](../../framework-studio/server/snapshot.ts)) holds:

- both mode models;
- the declared Prisma schema and sanitized local-database projection problems;
- one source index;
- a sha256 of every editable file;
- public input policy, selected-mode condition outcomes and client mapping metadata;
- a revision string.

Snapshots are rebuilt whole, never patched. Refreshes are serialized: requests made while
one runs share a single follow-up.

`server/database.ts` reads the authored `packages/database/prisma/contract.prisma` with
Prisma's installed PSL syntax parser. It projects models/namespaces, mapped columns,
declared types/defaults, primary and unique keys, indexes, enums and owning `@relation`
foreign keys. Cardinality uses unconditional unique keys; partial indexes do not imply
one-to-one. Composite keys and self references are supported. External model references
and undisplayed declaration kinds produce notes. Syntax errors suppress the incomplete
diagram. This projection does not replace Prisma semantic validation or inspect live
database state. Generated artifacts, migrations and connection settings are not read.

The watcher also observes the authored Compose file and contract source, including
atomic replacements. Their hashes/facts contribute to snapshot revisions. The schema
view has deterministic table geometry, column connectors, selection, search and zoom;
schema selections open source/details in the shared inspector. Both database inspectors
link to it. Local PostgreSQL visibility is based on the authored Compose service rather
than a Docker health check; Compose runtime overrides are outside this source projection.

When a graph stops loading, its last good model is kept, marked `stale`, with the new
diagnostics attached. The UI greys it out and pauses editing until the config loads again.

## The source index

[server/source/](../../framework-studio/server/source)

- **Locations** come from `locateConfigSource` in
  [packages/framework/scripts/config-source.ts](../../packages/framework/scripts/config-source.ts),
  the reader `framework:check` uses. It follows `defineFrameworkConfig` into each section
  module through literal section arrays, and returns each entry's file, key span and
  value span. It refuses the same shapes as `framework:check`, with the same messages. The
  same reader also locates `defaults`, `networks`, `resources`, `database` and `userPool`.
- **Origins bridge the two worlds.** Normalization names a declaration
  `section["key"]` with an optional property chain (`webSocket["$connect"].authorizer`).
  [server/model/origin.ts](../../framework-studio/server/model/origin.ts) parses that
  name, finds the evaluated object it names, and applies semantic patches to it.
- **Editability** is decided per field, from the syntax, as one of five kinds:

  | Kind | Meaning |
  | --- | --- |
  | `literal` | Editable |
  | `absent` | Insertable, because the parent is an object literal |
  | `computed` | An expression; shown read-only |
  | `spread` | A spread may supply it; read-only |
  | `unsupported` | Not editable, with the reason |

  A literal is editable only when its value equals the evaluated value at the same path.
  Otherwise something between source and config changes it, and the studio leaves it
  alone. A target declared by several origins is read-only, because they must agree.
- **Catalog facts** ([server/source/catalog.ts](../../framework-studio/server/source/catalog.ts)):
  - **Conditions.** A ternary around an entry (`PROD_DEPLOYMENT ? … : undefined`).
  - **Stack members.** For `resource.stack<T>()`, the public fields and getters of class
    `T`. They are read from source because the evaluated catalog mints members lazily
    through a Proxy and cannot list them.
  - **Link sites.** The `linkResources`, `linkResource` and `bindPostgresDatabase` calls
    in `cdk-app/lib` and `cdk-app/bin`.
  - **CDK resource links** ([cdk-links.ts](../../framework-studio/server/source/cdk-links.ts)).
    Parse the constructors of catalog stack classes with a direct link site. Resolve
    public-member references and simple const aliases, constructor property references,
    SNS SQS subscriptions and EventBridge rules with explicit source/target references.
    Import aliases for recognized CDK adapters are resolved. Skip branches, helpers,
    loops and dynamic names rather than claiming their execution. No CDK is imported or
    synthesized. Relationships carry `relation: "cdk"`, `provenance: "source"` and source
    spans; they are merged into both graph models after class members are expanded.
    Native Cognito hooks, Lambda event sources, SNS Lambda subscriptions, S3 Lambda
    notifications and EventBridge Lambda targets carry `relation: "trigger"`. Local
    event aliases and constructs later published as public fields are resolved. Version
    2 of the index also records unresolved/conditional native ownership as manual wiring;
    absence of an inferred edge never establishes that a trigger slot is free.
    Missing endpoints are omitted. These are source inferences, separate from the
    framework's evaluated declarations.

Each snapshot atomically replaces `.cache/framework-studio/cdk-links.json` with the
versioned scan output (file hashes, relationships, limitations; no resource values or
source snippets). This file is ignored, disposable and never used as configuration or
as a cache input. `POST /api/cdk-links/refresh` uses the existing Host, token and origin
guards, rebuilds the snapshot and broadcasts it. The normal CDK source watcher refreshes
the index automatically; the map toolbar does not require a manual refresh control.

Read connections carry an in-memory `evidence` list: authored environment/secret/grant
entries (following literal imports and spreads), derived flags, catalog declarations,
public fields, assignments and resource link sites. The Inspector links each location
and its single trimmed TypeScript line to VS Code. Literal contents and comments are
redacted; input names in catalog declarations remain identifiable. No dotenv source
is eligible, and excerpts never enter the disposable CDK index or edit journals.

## Editing

Trigger capability discovery uses a TypeScript Program/TypeChecker on each catalog
stack's public instance surface. Canonical CDK export symbols, aliases, inheritance
and re-exports determine compatibility; displayed type text never authorizes an edit.
Private/protected members, Stack members and secret projections are excluded. Only
serializable capability/source facts are cached in memory, keyed by source hashes.
The capability program and candidate type-checks also share parsed `node_modules`
declaration files (`server/source/declarations.ts`), keyed on `package-lock.json` and
the compiler options and dropped after ten idle minutes; repository and review-overlay
files are always parsed fresh, so the cache never holds authored source or values.
Inherited native wiring and unavailable implementations require manual review.

The event and public-field Inspectors share a collapsed Triggers section. They stage
source-scoped attachment IDs, event destinations, adapter options and a handler-contract
acknowledgement in the existing inspector draft. Native slots remain occupied. Trigger
edits compose through BatchEditor, validate both graphs and TypeScript, check wiring and
capability hashes, and use its reviewed apply/guarded rollback and source-recovery journal. Computed/spread lists
and commented lists remain source edits. Review identifies changed edges and delivery
semantics. Synthesis and deployment remain separate checks/actions.

Native trigger removal is the one batch edit that writes CDK source. The scanner gives each
recognized native edge an exact removal span (a `lambdaTriggers` entry, a direct constructor
statement, or one EventBridge rule target) or a refusal reason. The planner re-locates the
span in the current snapshot and writes only the linked catalog stack's own file
(`assertStackFile`). It prunes only the imports the deletion made unused. Validation
type-checks the proposed text and re-scans it, including the offset-matched link sites. The
result must lose exactly the selected triggers and change no other native edge or manual
wiring. The refreshed snapshot must match that scan before the journal records the change,
which supports interrupted-write recovery. Saved change history belongs to Git. A trigger list emptied in framework config
removes its `triggers` property and the Studio-added imports.

[server/edits/](../../framework-studio/server/edits)

The field registry owns ordinary scalar-field edits. Other typed operations (creation,
resource inputs, connections, network/database settings and identity policy) have dedicated
planners and source-shape checks; see [backend boundaries](../aws-studio-knowledge/studio/backend.md).

`defaults.ts` derives shared Lambda fields from that registry, with explicit container
and database-pool fields. `ModeModel.defaults` groups them under `defaults:<type>`;
`FieldFact.usage` counts current inheritors and overrides. These are projections of
native `FrameworkDefaults`, not additional configuration. Island inspectors choose
relevant groups; the canvas still derives membership and geometry from `buildScene`.
Workflows, stacks and inputs have no shared framework default group and expose their
individual entries instead.

Catalog stack usage is separate from catalog presence. `source/stack-usage.ts` follows
local runtime imports from the entry point named by `cdk-app/cdk.json`, resolving direct,
aliased, default and namespace constructor references and local barrel exports. It skips
type-only imports and never executes constructors or conditions. Missing imports or an
unsupported entry point leave unreferenced usage unknown. Constructor sites are source
evidence, not live deployment status. The database named by the evaluated config marks
itself and its owning stack as framework managed. A literal member constructor's subnet
selection is read alongside its public fields; this places the RDS member in the VPC
without adding a second logical entity.

`source/export-stacks.ts` reads the public stack-output mapping shared with the root
environment exporter in `scripts/root-env-outputs.ts`. Only matching `CfnOutput`
declarations in these stack classes are projected. The snapshot retains output names,
destination variable names, source locations and safe identifier paths; literals,
templates, calls and resolved values never enter it. Complex values use the output name
as a symbolic token. Existing catalog nodes are reused; other selected classes get stable
`framework-stack:<Class>` identities and lock badges. These nodes use the declared
framework stack lifecycle, with WebSocket availability taken from actual model AWS lanes.
Their inspectors expose outputs without adding generic infrastructure controls.
The projection's `frameworkStack` origin flag also identifies a missing resource-catalog
declaration. `ResourceStatus` displays **Not defined in resources** alongside the separate
managed/constructor statuses, including island lists. Catalog lookup happens before adding
a projected stack, so declaring that class as a resource automatically clears this flag
and reuses the authored resource id. Environment absence never implies missing catalog
membership.

Default edits use the existing plan, preflight, atomic write, confirmation and journal.
The locator follows the root `defaults` object into its authored module. Field paths
include the service group, so absent groups can be inserted without reprinting the file.
Required Lambda baselines cannot be removed. A shared default changes only inheritance;
individual workload overrides are preserved. Both environment graphs must validate.

| Field id | Path | Applies to | Domain |
| --- | --- | --- | --- |
| `deploy` | `deploy` | http, webSocket, its authorizer, service, task, agent, workflow (its options object) | `DEPLOY_SETTINGS` |
| `lambda.subnet` | `subnet` | Lambdas | `LAMBDA_SUBNETS` |
| `lambda.memorySize` | `memorySize` | Lambdas | 128–10240 MB |
| `lambda.timeoutSeconds` | `timeoutSeconds` | Lambdas | 1–900 s |
| `lambda.architecture` | `architecture` | Lambdas | `LAMBDA_ARCHITECTURES` |
| `lambda.packaging` | `packaging` | Lambdas | `LAMBDA_PACKAGING` |
| `lambda.runtime` | `runtime` | ZIP Lambdas | `LAMBDA_RUNTIMES` |
| `lambda.logRetentionDays` | `logRetentionDays` | Lambdas | `CLOUDWATCH_LOG_RETENTION_DAYS` |
| `lambda.bundling.minify` / `lambda.bundling.sourceMap` | `bundling.minify` / `bundling.sourceMap` | Node ZIP Lambdas | Booleans |
| `container.subnet` | `cloud.subnet` | services, tasks | `CONTAINER_SUBNETS` |

Enum domains retain their primitive value types: retention is a number, bundling flags
are booleans, and architecture/packaging/runtime are strings. Values are checked before
planning and serialized as their real TypeScript literals. Field applicability follows
`resolveLambdaTarget`; container images have no managed-runtime or esbuild controls.
The inspector's Build and runtime section also shows implementation type, source and
handler, all projected from the resolved spec. Runtime and handler remain Dockerfile-owned
for an image. Packaging previews validate the existing declaration; no handler/Dockerfile
is generated or converted.

Event Lambdas expose deployment settings subject to their trigger constraints. Tools
inherit consuming agents' lanes unless their declaration explicitly overrides them.
The field registry and deployment resolver own applicability and derived facts.

### Inspector sessions and batches

`src/draft.ts` owns one observable `InspectorDraft` per `StudioProvider`. It captures the
persisted snapshot, selected inspector and graph mode. All editable controls stage through
it: typed fields, switches, routes, island default groups, and the resource declaration
form. Entries are keyed by underlying target/field, retain invalid input text, and disappear
when they match the authored baseline. Private environment values use a separate
in-memory environment entry/review within the session; they cannot be mixed with a
normal source batch and never enter source-diff or source-journal payloads.

The inspector's scrolling content and sticky `DraftFooter` are separate flex children.
Only explicit **Review Changes** requests a plan. It opens the review dialog immediately,
with a checking state until validation returns. Planning errors stay in that dialog with
a retry action. **Back to Editing** cancels a pending review and retains the session;
**Discard All** clears it. Successful apply fetches the fresh snapshot and resets the
baseline. Failed planning, refused configuration and failed writes preserve the draft.

`StudioProvider` uses TanStack Router's blocker for selection search parameters, view
links and history navigation. Graph-mode changes use the same session guard. Pending
navigation retains its proceed/cancel callbacks, so **Discard and Continue** completes
the requested action, **Keep Editing** cancels it, and **Review Changes** cancels navigation
and opens review. A native `beforeunload` handler exists only while dirty. Live snapshots
are tracked separately while dirty: a revision conflict freezes the editing baseline,
preserves entered values and blocks applying until the user explicitly discards.

`server/edits/batch.ts` composes the existing `planEdit` literal splices through `SourceFiles`
overlays. HTTP key replacements follow the field splices and run together, allowing
interdependent changes to be checked against the complete candidate source. Fresh
evaluators load the overlays in both modes; target/construct identities and route
destinations must remain stable. The review groups the final exact diff by file.

`events.localReplay` uses the same switch/draft but adds a paired source edit through
`server/edits/local-replay.ts`. Its separate write authority resolves only the selected
event's Node ZIP `index.ts` and declared export; the generic config allowlist stays
unchanged. A recognized exported handler constant is wrapped/unwrapped without rewriting
its body. Imports are reused, or a collision-free import is added. Unsupported capture
patterns and wrapper comments that would be lost are refused. Handler contents are
checked during review and apply, including when the wrapper already matches.
Both changes share the batch journal and rollback. The legacy single-file edit API
refuses this field. Both-mode framework validation still enforces replay for events
requiring local execution. Regenerate the replay manifest before deployment.

The selected output-stack projection derives a `localReplay` edge from each enabled
event to the displayed replay stack, reusing catalog stack identities. Disabled events
have no replay edge. The relationship stays inspectable in Production, where the
development-only stack is absent, and uses the existing shared connection router.

Apply checks revisions and source hashes again, validates the complete candidate, uses
the existing atomic file replacement primitive, then confirms the evaluated fields and
routes from disk. On failure it restores files only while their bytes still match the
write, preserving concurrent external edits. This is one logical transaction with
per-file atomic replacement, rather than a filesystem-wide atomic commit. Batch and resource
transactions use a private write-ahead source journal and checkout lock, with explicit
interrupted-write recovery. Resource inspectors use the same draft/review UX and their
multi-file resource transaction and TypeScript validation. There is no global source
Undo/Redo API; use Git for saved-source history.

The original single-field API remains available for compatibility:

1. **Intent.** The browser sends `{ target, field, value | inherit }` with the revision it
   was looking at. It never sends source text.
2. **Plan** ([plan.ts](../../framework-studio/server/edits/plan.ts),
   [splice.ts](../../framework-studio/server/edits/splice.ts)).
   - **Checks.** The value is checked against the field's domain.
   - **Splice.** The edit replaces, inserts or removes one span:
     - an insertion goes after or before neighbouring properties chosen per field;
     - it follows the object's own layout (one line or several, trailing comma or not, the
       file's quote);
     - it creates a missing parent such as `cloud`;
     - it refuses to remove a property that carries a comment.
   - **Verification.** The result must parse, and `locateConfigSource` must read the same
     entry back with exactly the new value, or with the property gone for `inherit`.
3. **Preflight** ([server/model/preflight.ts](../../framework-studio/server/model/preflight.ts)).
   Both evaluators apply the same change as a shallow patch to the evaluated config, then:
   - run the framework's validators;
   - predict the field's new effective value, the target's lanes and its placement.
   
   Successful proposals also go through batch overlay evaluation of complete candidate
   source. A semantic patch alone is not the proof that the proposed file is correct.
4. **Preview.** The browser shows both verdicts, the unified diff, and impact notes (lane
   changes, `docker-compose.services.yml` needing `framework:generate`, Compose Watch
   restarting the dev servers).
5. **Apply** ([transaction.ts](../../framework-studio/server/edits/transaction.ts)). The
   plan is refused when:
   - the snapshot revision changed, or the file's hash differs from the plan's: 409;
   - the preview has expired: 410;
   - the framework refused the change: 422.
   
   Otherwise the file is written to `.cache/framework-studio/tmp/` and renamed over the
   original, retrying briefly on Windows EPERM, EBUSY and EACCES.
6. **Confirm.** The repository is re-evaluated from disk, and each graph's effective value
   must equal the prediction. If it does not, and the file still holds exactly what was
   written, the original is restored (`reverted`). If someone has changed it since, it is
   left alone (`unconfirmed`).
7. **Journal and recovery.** Before multi-file writes, a private source journal records
   before/after bytes. Interrupted operations expose explicit recovery, guarded by current
   hashes and ownership. Restore preserves intervening edits; Keep current source requires
   validation and an unchanged fingerprint. This is recovery, not saved-source undo history.

Every refresh expires outstanding previews. Writes are serialized through one lock.

## Live refresh

[server/watch.ts](../../framework-studio/server/watch.ts)

- Directories are watched rather than files, so a file replaced by a rename, the studio's
  own write or an editor's save, keeps being seen. Changes are batched over 200 ms.
- The studio recognizes its own writes by hash. A change whose content matches what the
  studio wrote is not reported as external. The studio never writes in response to a file
  event, so there is no feedback loop.
- Events on `/api/events`:

  | Event | Data |
  | --- | --- |
  | `hello` | The current revision |
  | `status` | `evaluating` |
  | `snapshot` | The revision and external files; observers re-fetch source state |
  | `command` | Which command is running |
  | `infrastructure` | Inventory lifecycle changed; refresh the selected mode state |

  The browser invalidates its query on `snapshot` and shows a toast for external changes.

## Commands

[server/commands.ts](../../framework-studio/server/commands.ts)

| Name | Runs | Writes |
| --- | --- | --- |
| `framework:check` | `generate-contracts.ts --check`, then `check-local.ts` | No |
| `framework:generate` | `generate-contracts.ts` | Yes: only after the request says it was confirmed (428 otherwise) |

Each runs through the repository's `tsx`, with `shell: false`. Nothing from a request
reaches argv. One command runs at a time, output is capped at 256 KB, and a command is
killed after 5 minutes.

## Infrastructure inventory

`server/deployment-inputs.ts` projects fixed local `.env.dev`/`.env.prod` files into
the snapshot after framework evaluation. `envfile:dev` and `envfile:prod` share one island;
Catalog `fromEnv` declarations become environment-linked input/secret nodes, retaining their existing
IDs; public `resource.value` declarations remain source parameter nodes without file-supply edges.
Other dotenv names remain file metadata. `supplies` edges carry names, presence and assignment locations,
never values. Multiline contents cannot introduce false parameter names. The file
inspector loads the selected file's values through a guarded, no-store endpoint, outside
snapshots, query caches and evaluator processes. `server/deployment-input-edits.ts` accepts
typed variable edits for only `.env.dev` or `.env.prod`; it does not expand the config
writer's allowlist. Edits join the inspector draft and navigation guards. Reviews redact
all values, including unrecognized keys, and private plans stay in memory. Apply checks
the file hash and snapshot revision again, writes by private sibling/atomic rename, and
refreshes the snapshot. Unchanged assignments and comments are preserved; changed duplicate
keys are consolidated and every value must round-trip through Node's dotenv parser.
Saving inputs does not run infrastructure synthesis or claim complete CDK validation.
The input/secret inspector edits its selected variable inline through the same environment
draft and review service. Its targeted value read also returns the selected file's hash
and presence, never other variables. Input configuration and file-value drafts remain
separate; secrets start masked and individual value edits can be reverted before review.
Missing files expose one typed generation operation that copies the corresponding
`.template` (`cdk-app/.env.<mode>.template`) with exclusive creation; there is no legacy
`cdk-app/.env`. The environment-files island inspector offers it for every missing file, and a
missing file's node wears a red cross. Reads never create files. Watchers
refresh both source projections, while inventory fingerprints track the selected mode's
file. These projections are not framework declarations or a second configuration store.

`framework-config/client-environment.ts` holds literal client-variable references:
one recipe for both modes, or `{ dev, prod }` where sources differ.
`scripts/client-environment-mapping.ts` defines their types (input, public stack output,
deployment region, URL from a port, or empty). Source availability determines values;
there is no independent `enabled` flag.
`server/client-environment-source.ts` reads source literals without executing code and
rewrites only changed fields. Validation rejects secret inputs, raw values and private
outputs. The source file participates in the existing config hashes and watcher.

`shared/client-environment-preview.ts` resolves symbolic sources and declaration availability
for both saved projections and in-memory drafts, without reading values. The client mapping
inspector uses this same resolver so source/status previews cannot remain stuck on a saved binding.
`server/client-environment.ts` binds declarations to current resource IDs after input-file
and output-stack projection. `client-envfile` stands on `island:client-environment`;
its `maps` edges point from declared input parameters or existing stack identities into
`client-envfile`, following variable flow into generated client environment files. CDK environment files
connect only to the input parameters they supply. Client mappings inherit parameter
presence and defaults for the selected mode; undeclared file variables are not sources.
Optional `when: { input, equals }` conditions use sanitized parameter comparison outcomes
in Studio and the same declared input/default during export, writing empty on a mismatch.
An absent-mode or optional unsupplied input leaves its generated field blank; a missing
required input blocks export. Standalone values need no environment-file assignment. The compact
file/island editor joins the inspector draft and batch review/apply flow, including
conflict checks, atomic file writes, confirmation and interrupted-write recovery. New fields start empty
in both modes. Region refers to Cognito's deployment metadata, not the local SDK region.
This projection does not read client values, query deployed outputs or generate files.
`scripts/client-environment-source.ts` supplies the shared literal reader; the exporter
and Studio use the same reference validation. `scripts/client-environment-export.ts`
resolves saved mappings from the selected deployment's metadata, public output allowlist,
and its own mode's authored CDK input file (or explicit inputs override). Declared public values, defaults
and secret classification come from the resource catalog. It validates all results before
the existing guarded multi-file write; private resolved values do not enter Studio projections
or review data. Public authored values/defaults remain visible source metadata.
Environment pills describe resolved availability rather than stage independent enable
flags. Inline renames preserve both recipes and stage an object-key rename; the source
rewriter, review and conflict checks keep their ordinary behavior.

`scripts/cloud-assembly.ts` extends the deployment assembly reader into a shared
manifest traversal. It follows listed stacks and nested cloud assemblies, validates
real paths within the selected assembly, and reads listed metadata/tree artifacts.
Inventory inspection also follows local nested-stack template assets when the template
metadata or asset manifest provides unambiguous evidence. Deployment selection continues
to use only independently deployable stack artifacts.

`scripts/infrastructure-inventory.ts` projects a values-free model from that reader:
stack identity/environment, logical ID, type, construct path, condition and explicit
framework owners. IDs combine AWS environment, manifest-relative stack identity and
logical ID; temporary directories and timestamps do not affect them. Versioned metadata
from `framework-inventory.ts` identifies primary constructs, supporting descendants,
catalog stacks and explicit imported references. It changes no CloudFormation properties,
tags, scopes or logical IDs. Missing ownership remains unknown. Studio attaches captured
owner declaration locations, labeled as such rather than claiming construct source locations.

CloudFormation `DependsOn`, `Ref`, `GetAtt`, `Sub` and resolvable static cross-stack imports
form a separate dependency list, scoped to the same AWS environment. They do not modify
the logical map's framework relationships. Dynamic exports, remote nested templates and
unmarked imports remain unresolved. No deployed status or resource properties are queried.

`scripts/cdk-synthesis.ts` runs only the local CDK CLI with a bounded timeout/output and
no shell. Its caller supplies context, environment and profile; it has no dev/prod policy
or deployment orchestration. Deploy & Run has a separate planning/operation authority
over the shared deployment scripts; it does not gain mutation authority from this inventory.

`server/infrastructure.ts` owns Studio's mode adapter and in-memory last-good states.
The current adapter copies `cdk-app/.env.dev` or `.env.prod` privately, overrides `PROD_DEPLOYMENT` in that
copy and the child environment, and supplies matching `useLocalDevStack` context. The
active inputs are never written. This one adapter is the migration point for future
context-only mode selection. Normal production guards
remain active; the adapter does not silently override development-only security settings.
Normal CDK credential/context lookups and local asset bundling can occur during synthesis.
Synthesis itself performs no deployment or secret upload; private input editing belongs
to the separate DeploymentInputService.

GET reads state without starting work. POST explicitly runs one synthesis at a time in
an isolated assembly, then deletes its temporary inputs and templates. Input values and
their encoded forms are redacted from returned errors. Inventories exclude template
properties, outputs and arbitrary metadata. Fingerprints of relevant authored sources,
inputs, context and dependency versions detect stale results, including edits during a
run. Errors retain the last successful inventory, timestamp and configuration. A server
restart clears inventory history; this service does not persist raw assemblies.

`src/views/Infrastructure.tsx` is an inline inventory shared by the Stacks island inspector
and catalog stack inspectors. The island exposes synthesis directly; a stack lazily opens
its scoped inventory through the shared inspector disclosure. Workload, route, input and
member inspectors omit this action. There is no infrastructure drawer or header action.
Filters for stack, logical owner and resource type expand separately from text search.
The inventory navigates through Studio's guarded logical selection. A catalog stack owner
matches its entire stack collection, including resources with unknown individual owners.
The asynchronous Lambda and WebSocket handler/API stacks are omitted from the browse
view; the underlying synthesis inventory remains complete. RDS remains visible with a
framework-managed label. Synthesis has no profile-entry control in Studio.
No generated infrastructure nodes are added to the map. Synthesis is disabled while an
inspector draft is dirty, validation is pending, or a source operation is running, and never
starts from view/mode changes. Automatic graph health remains in the header; the distinct
`framework:check` generated-file/local-wiring audit lives in health's Additional checks.
Deployment Inputs, creation wizards and deployment planning are implemented through
their separate services. See [interface workflows](../aws-studio-knowledge/studio/interface.md)
and [deployment operations](../aws-studio-knowledge/deployment/operations.md).

## Security model

The studio is a local tool that can write source, so the browser is treated as untrusted.

| Guard | Defeats | Where |
| --- | --- | --- |
| Bind to 127.0.0.1 only | Other machines | `server.ts` |
| Host must be `127.0.0.1:<port>` or `localhost:<port>` (else 421) | DNS rebinding | `guards.ts` (`hostGuard`) |
| Per-process token, served inside the page, required on every API call (SSE takes it as a query parameter) | Other origins and processes | `guards.ts` (`apiGuard`) |
| State-changing requests need `Origin: http://<host>` | Cross-site requests | `apiGuard` |
| Generic edits write only to `framework.config.ts` and `framework-config/**/*.ts`, by real path, no symlinks; paired replay edits resolve only the selected event's TypeScript entry point | Arbitrary source writes | `files.ts` (`assertWritable`), `edits/local-replay.ts` |
| Two fixed generic commands, no shell; operational services have separate typed actions | Arbitrary request-controlled shell execution | `commands.ts`, dedicated service routers |
| Separate synthesis-only CLI runner; validated mode/profile; private isolated assembly | Arbitrary command/input-path execution | `infrastructure.ts`, `scripts/cdk-synthesis.ts` |
| Evaluators receive synthetic mode inputs and condition outcomes | Accidental authored dotenv values in the graph protocol; not hostile repository code | `inputs.ts`, `evaluator/pool.ts` |

No CORS headers are sent. Logical graph evaluation makes no AWS call. Explicit CDK
synthesis may perform credential/context lookups but never deploys. The snapshot and
infrastructure inventory exclude resolved environment-file values; public source parameters
and defaults may appear in the logical snapshot. Mutation requests also check the current
Studio protocol version. Dedicated operational services can make AWS calls only through
their own inspection, review and approval paths.

## The browser

[src/](../../framework-studio/src)

- **Routing.** [main.tsx](../../framework-studio/src/main.tsx) declares the seven
  workspaces, including the GraphQL placeholder, and compatible redirects listed in
  the [interface guide](../aws-studio-knowledge/studio/interface.md). Selection is the
  `?select=<id>` search parameter shared by every view.
- **State.** [studio.tsx](../../framework-studio/src/studio.tsx) is the context every view
  reads: the snapshot, the selected mode, the model and an index, the selection, live
  state, toasts and the shared inspector draft/review. `draft.ts` holds the session's
  transitions independently of React; `DraftControls.tsx` renders its footer and warning.
- **Data.** [http.ts](../../framework-studio/src/http.ts) owns token/protocol transport;
  [api.ts](../../framework-studio/src/api.ts) owns typed source/edit/command calls.
  [snapshot.ts](../../framework-studio/src/snapshot.ts) owns the snapshot query and
  event invalidation. Feature query definitions share read identity while callers
  retain polling/refresh policy; the shared `events.ts` hub retains one stream per tab.
- **Views.**
  - [Board](../../framework-studio/src/views/Board.tsx), laid out by
    [layout.ts](../../framework-studio/src/layout.ts): absolutely positioned DOM nodes
    over an SVG of curves. Set aside and not routed.
  - [Isometric](../../framework-studio/src/views/Isometric.tsx).
  - [Database](../../framework-studio/src/views/Database.tsx).
  - [Deploy](../../framework-studio/src/views/Deploy.tsx): deployment discovery, reviewed plans, authorized operations and local lifecycle controls; see [current operations](../aws-studio-knowledge/deployment/operations.md).
  - [Inspector](../../framework-studio/src/views/Inspector.tsx) and the
    [edit dialog](../../framework-studio/src/views/EditDialog.tsx), in React DOM, never on
    a canvas. Inspector dispatch/lifetime stays at that entry; entity rendering lives
    in [views/inspector/](../../framework-studio/src/views/inspector/). See
    [editing](../aws-studio-knowledge/studio/editing.md) for draft and module contracts.
  - [Shell](../../framework-studio/src/views/Shell.tsx): the top bar, the health and
    command drawers, and the toasts.
- **Styles.** [styles.css](../../framework-studio/src/styles.css) registers Tailwind sources and layers. [theme.css](../../framework-studio/src/styles/theme.css) owns runtime tokens; `src/ui/`, `InspectorUI` and [inspector-ui.ts](../../framework-studio/src/inspector-ui.ts) own reusable utility presentation. See the [design system](ui-design-system.md) for the four CSS owners and [inspector conventions](inspector-design.md). The
  light theme is "drafting film and ink". Compact exception badges use teal for Dev and violet for Prod;
  shared entities have no badge. `src/deployment.ts` supplies the same availability,
  badge paths and descriptions to Inspector and the canvas renderer.

## API

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/snapshot` | | Snapshot, source recovery/watch status, evaluation and command state; 503 until the first evaluation |
| `GET /api/events?token=` | | Server-sent events, above |
| `POST /api/edits/batch/plan` | `{ edits, revision }` | Combined per-file diffs, summaries, both complete-source validations |
| `POST /api/edits/batch/apply` | `{ planId }` | One validated source transaction with guarded rollback/recovery |
| `POST /api/edits/plan` | `{ intent, revision }` | `PlanResponse`: diff, both preflights, `ok`, impact |
| `POST /api/edits/apply` | `{ planId }` | `{ status: applied, reverted or unconfirmed, message, revision }` |
| `GET /api/source-recovery` | | Pending interrupted-write records |
| `POST /api/source-recovery/restore`, `/keep` | Reviewed record, typed approval; keep also requires fingerprint | Explicit source recovery |
| `POST /api/commands/:name` | `{ confirmed? }` | `{ command, exitCode, output, durationMs }` |
| `GET /api/infrastructure?mode=dev\|prod` | | Mode state, freshness, last-good inventory and generation evidence |
| `GET /api/websockets/defaults` | | `{ local, apiGateway }`: the WebSockets page's starting URLs, from two keys of root `.env` |
| `POST /api/infrastructure/synthesize` | `{ mode, profile? }` | Explicit synthesis result; last-good inventory retained on failure |

The generic types are in [shared/api.ts](../../framework-studio/shared/api.ts).
This table covers the original editing/synthesis core. Current dedicated database,
identity, deployment and lifecycle API families are mapped in
[backend boundaries](../aws-studio-knowledge/studio/backend.md).

## File map

| Path | Holds |
| --- | --- |
| `server/index.ts` | Entry point and `--print` |
| `server/server.ts` | Express, Vite middleware, routes, SSE, watcher wiring |
| `server/guards.ts`, `server/files.ts`, `server/inputs.ts` | Host and token guards, the write allowlist and hashes, mode inputs and condition outcomes |
| `server/evaluator/` | `evaluate.ts` (child), `pool.ts` (dev and prod children) |
| `server/model/` | `project.ts`, `origin.ts`, `preflight.ts` |
| `server/source/` | `index.ts` (spans and editability), `syntax.ts`, `catalog.ts` |
| `server/edits/` | `fields.ts`, `splice.ts`, `plan.ts`, `transaction.ts` |
| `server/snapshot.ts`, `server/watch.ts`, `server/commands.ts` | Snapshot builder, watcher, command runner |
| `server/infrastructure.ts`, `shared/infrastructure.ts` | Synthesis lifecycle, mode/input adapter and HTTP state contract |
| `scripts/cloud-assembly.ts`, `scripts/infrastructure-inventory.ts`, `scripts/cdk-synthesis.ts` (repository root) | Shared manifest reader, values-free inventory and synthesis-only runner |
| `shared/` | `model.ts` (snapshot types), `api.ts` (HTTP contract) |
| `src/main.tsx`, `src/studio.tsx` | Route tree and shared application/draft lifetime |
| `src/http.ts`, `src/api.ts`, `src/snapshot.ts`, `src/events.ts` | HTTP mechanics, typed source endpoints, snapshot/query invalidation and shared event stream |
| `src/draft.ts`, `src/draft-entries.ts` | Session coordination versus staged contracts and pure normalization/request conversion |
| `src/deploy/`, `src/identity-api.ts`, `src/identity-queries.ts` | Feature endpoint/query/live-log ownership; explicit operation authority stays with existing server services |
| `src/views/` | Workspace entries and existing specialized editors; use the [source map](../aws-studio-knowledge/REPOSITORY-MAP.md#where-to-change-studio) for common changes |
| `src/views/inspector/`, `src/views/map/` | Cohesive feature rendering beneath the persistent Inspector/map coordinators |
| `src/ui/`, `src/inspector-ui.ts` | Native primitives and existing presentation recipes; see [UI design system](ui-design-system.md) |
| `src/scene/` | Scene contracts in `types.ts`, construction, bounded layout/routing and cached drawing/picking; see [rendering](../aws-studio-knowledge/studio/rendering.md) |
| `test/` | `node --import tsx --test`, against the real repository and disposable fixtures |
