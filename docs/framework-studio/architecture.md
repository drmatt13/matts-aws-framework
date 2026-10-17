# Framework Studio architecture

How the studio turns `framework.config.ts` into views, and views back into source edits.
The isometric landscape has [its own document](isometric-view.md).

## Shape of the system

```text
Browser (React 19, TanStack Router + Query)
  Board · Lanes · Isometric · Database · Inspector · Edit preview
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
  ├─ Watcher: framework.config.ts, framework-config/, packages/framework/src/config/,
  │     cdk-app/lib/, and cdk-app/.env (two flags for graph evaluation)
  └─ CommandRunner: framework:check, framework:generate (fixed argv, no shell)
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
  holds one line, `PROD_DEPLOYMENT=true|false`. The framework reads authored inputs only
  from that file, so an evaluator never parses a secret. Graph evaluation reads two keys
  of `cdk-app/.env`: `PROD_DEPLOYMENT`, for the current mode, and
  `DEPLOY_PROD_WEBSOCKET_API`, which decides whether a dev graph holds WebSocket handlers.
  See [server/inputs.ts](../../framework-studio/server/inputs.ts).
- The selected-resource endpoint separately reads `cdk-app/.env` for one declared input
  or secret. Its no-store response goes only to the selected inspector; secrets start
  masked. Values never enter graph evaluation, snapshots, diffs, caches or disk journals.
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

`projectModel(config, { mode, webSocketApi })` reshapes the framework's answers and
decides nothing itself.

| Part | Source in the framework | Notes |
| --- | --- | --- |
| Targets | `getFrameworkTargets` | Id is the canonical reference (`lambda:graphql-api`). `origins` keeps the logical declaration places |
| Routes | `normalizeFrameworkConfig().http` and `.webSocket`, `getAgentBrowserRoutes` | Ids `route:http:/x`, `route:service:/x/*`, `route:ws:$connect`, `route:agent:/x` |
| Catalog | `config.resources`, walked | Stacks, constructs, inputs, secrets, groups. A stack's members come from what workloads read, plus its class (see Source) |
| Edges | Environment references, secrets, `cloud.bindings`, agent tools, workflow steps and integrations | Id `relation:from->to#n`, so two relations between one pair stay two edges. `provenance` is `declared` or `derived` (for example a user-pool variable handed by `userPool: true`) |
| Lanes | `isTargetEnabled`, `isTargetDeployed`, `getToolDeploySetting` | Raw `local`, `cloud` (intent), `dev`, `prod` (outcome) remain available for evaluation. The UI presents Development (`local || dev`) and Production (`prod`) with execution location as supporting detail |
| Placement | `resolveLambdaTarget().subnet`, container `cloud.service/task.subnet`, `subnetEgress`, `usesDualStackEndpoints` | `outside`, `vpc` (with subnet and egress), or `managed` (Step Functions) |
| Network | `resolveNetwork`, `endpointServices`, `NETWORK_PRICES` | Whether production builds the VPC: something is placed in it |
| Local database | Authored Compose `services.postgres`, using the framework's Compose parser | Separate `local:postgres` identity; only image, named volumes and source are projected. Local database bindings point here; AWS bindings retain the catalog reference |
| Workflows | `NormalizedWorkflow` | The IR as plain data, its generated state names, targets and integrations |
| Fields | [server/edits/fields.ts](../../framework-studio/server/edits/fields.ts) | Each editable field's authored, effective and inherited value, and provenance |
| Diagnostics | `validateFrameworkConfig` (warnings captured), `assertCloudEdgesResolvable(mode)` | The framework's messages, verbatim, tied to an entity when a message names an origin |

The snapshot ([server/snapshot.ts](../../framework-studio/server/snapshot.ts)) holds:

- both mode models;
- the declared Prisma schema and sanitized local-database projection problems;
- one source index;
- a sha256 of every editable file;
- the two deployment settings;
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
  module, including spread arrays of modules, and returns each entry's file, key span and
  value span. It refuses the same shapes as `framework:check`, with the same messages. The
  same reader also locates `defaults`, `network`, `resources`, `database` and `userPool`.
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
    Missing endpoints are omitted. These are source inferences, separate from the
    framework's evaluated declarations.

Each snapshot atomically replaces `.cache/framework-studio/cdk-links.json` with the
versioned scan output (file hashes, relationships, limitations; no resource values or
source snippets). This file is ignored, disposable and never used as configuration or
as a cache input. `POST /api/cdk-links/refresh` uses the existing Host, token and origin
guards, rebuilds the snapshot and broadcasts it. The isometric toolbar's **Refresh CDK
links** calls it. The normal CDK source watcher also refreshes the index automatically.

## Editing

[server/edits/](../../framework-studio/server/edits)

The field registry is the only place that decides what is editable:

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

Tools and events show their `deploy` as derived or AWS-invoked, read-only, which is what
the framework says about them.

A change follows one path:

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
   
   Because only a literal in a literal object is ever edited, validating the patch is
   validating the edited source.
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
7. **Journal.** Undo and redo replay the other side of a recorded write. They are refused
   if the file no longer holds the side they expect, and they preflight first.

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
  | `snapshot` | The revision, external files, undo and redo labels |
  | `command` | Which command is running |

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

## Security model

The studio is a local tool that can write source, so the browser is treated as untrusted.

| Guard | Defeats | Where |
| --- | --- | --- |
| Bind to 127.0.0.1 only | Other machines | `server.ts` |
| Host must be `127.0.0.1:<port>` or `localhost:<port>` (else 421) | DNS rebinding | `guards.ts` (`hostGuard`) |
| Per-process token, served inside the page, required on every API call (SSE takes it as a query parameter) | Other origins and processes | `guards.ts` (`apiGuard`) |
| State-changing requests need `Origin: http://<host>` | Cross-site requests | `apiGuard` |
| Writes only to `framework.config.ts` and `framework-config/**/*.ts`, by real path, no symlinks | Writes anywhere else | `files.ts` (`assertWritable`) |
| Two fixed commands, no shell | Command execution | `commands.ts` |
| Evaluators read a synthetic inputs file | Secrets in memory, logs or the snapshot | `inputs.ts` |

No CORS headers are sent. No AWS call is made. The snapshot carries catalog references
(paths and attributes), never resolved values.

## The browser

[src/](../../framework-studio/src)

- **Routing.** [main.tsx](../../framework-studio/src/main.tsx) declares the routes `/`,
  `/lanes` and `/isometric`. The selection is the `?select=<id>` search parameter, shared
  by every view.
- **State.** [studio.tsx](../../framework-studio/src/studio.tsx) is the context every view
  reads: the snapshot, the selected mode, the model and an index, the selection, live
  state, toasts and the open preview.
- **Data.** [api.ts](../../framework-studio/src/api.ts) holds the TanStack Query snapshot,
  the SSE subscription and the edit and command calls.
- **Views.**
  - [Board](../../framework-studio/src/views/Board.tsx), laid out by
    [layout.ts](../../framework-studio/src/layout.ts): absolutely positioned DOM nodes
    over an SVG of curves.
  - [Lanes](../../framework-studio/src/views/Lanes.tsx).
  - [Isometric](../../framework-studio/src/views/Isometric.tsx).
  - [Inspector](../../framework-studio/src/views/Inspector.tsx) and the
    [edit dialog](../../framework-studio/src/views/EditDialog.tsx), in React DOM, never on
    a canvas.
  - [Shell](../../framework-studio/src/views/Shell.tsx): the top bar, the health and
    command drawers, and the toasts.
- **Styles.** [styles.css](../../framework-studio/src/styles.css) holds the tokens. The
  light theme is "drafting film and ink". Environment tracks use teal for Development and
  violet for Production. Compact exception badges use teal for Dev and violet for Prod;
  shared entities have no badge. `src/deployment.ts` supplies the same availability,
  badge paths and descriptions to Board, Lanes, Inspector and the canvas renderer.

## API

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/snapshot` | | `{ snapshot, history, evaluating, commands, busy }`; 503 until the first evaluation |
| `GET /api/events?token=` | | Server-sent events, above |
| `POST /api/edits/plan` | `{ intent, revision }` | `PlanResponse`: diff, both preflights, `ok`, impact |
| `POST /api/edits/apply` | `{ planId }` | `{ status: applied, reverted or unconfirmed, message, revision }` |
| `POST /api/edits/undo`, `/redo` | `{}` | As apply |
| `POST /api/commands/:name` | `{ confirmed? }` | `{ command, exitCode, output, durationMs }` |

The types are in [shared/api.ts](../../framework-studio/shared/api.ts).

## File map

| Path | Holds |
| --- | --- |
| `server/index.ts` | Entry point and `--print` |
| `server/server.ts` | Express, Vite middleware, routes, SSE, watcher wiring |
| `server/guards.ts`, `server/files.ts`, `server/inputs.ts` | Host and token guards, the write allowlist and hashes, the two deployment keys |
| `server/evaluator/` | `evaluate.ts` (child), `pool.ts` (dev and prod children) |
| `server/model/` | `project.ts`, `origin.ts`, `preflight.ts` |
| `server/source/` | `index.ts` (spans and editability), `syntax.ts`, `catalog.ts` |
| `server/edits/` | `fields.ts`, `splice.ts`, `plan.ts`, `transaction.ts` |
| `server/snapshot.ts`, `server/watch.ts`, `server/commands.ts` | Snapshot builder, watcher, command runner |
| `shared/` | `model.ts` (snapshot types), `api.ts` (HTTP contract) |
| `src/` | The page: views, lookups, the Board layout |
| `src/scene/` | The isometric engine, see [Isometric view](isometric-view.md) |
| `test/` | `node --import tsx --test`, against the real repository and disposable fixtures |
