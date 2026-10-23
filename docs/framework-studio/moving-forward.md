# Moving Framework Studio forward

What to know before changing the studio: the rules it depends on, how to extend it, how to
verify a change, the traps already found, its known limits, and where it could go next.

## Where things stand

- Board, Isometric, Database and Deploy share source-linked selection and inspectors.
  Supported authoring uses a draft, validated review and guarded source application.
- The [knowledge router](../aws-studio-knowledge/README.md) owns current subsystem
  contracts and verification routes. The [declaration guide](declarations-and-tags.md)
  explains the consolidated workload layout and metadata; filenames do not register
  workloads or establish deployment identity.
- Owner decisions still in force: a TypeScript renderer (no Bevy/WASM), a host process
  (not Compose), and preview-then-apply (never write immediately).

## Invariants

Break one of these and the studio stops being trustworthy:

1. **One model: the framework's.** Every fact shown comes from `@repo/framework/config`. Do
   not add a second catalog, identity scheme, workflow representation or deployment rule.
   If the framework cannot answer a question, show "unknown". Never guess.
2. **Identities are the framework's.** Targets are `kind:id`, routes are
   `route:<kind>:<path>`, resources are `resource:<catalog path>`. Layout positions and
   workflow node ordinals are not identities, and must not be persisted against.
3. **Source is the only authority.** The studio edits `framework.config.ts` and
   `framework-config/**/*.ts` (`assertWritable`). Catalog moves may additionally update
   imported references in authored TypeScript, through the resource planner. Each edit is a minimal
   span: never re-print a file, never reorder, never drop a comment.
4. **Validate before writing; confirm after.** Every write is previewed against both
   graphs, checked against the file's hash, written atomically, re-evaluated from disk, and
   reverted if it does not resolve as predicted.
5. **Never overwrite someone else's change.** A stale revision or a changed file refuses
   the write. Undo refuses if the file moved on.
6. **Keep values out of the graph.** Evaluators read synthetic inputs. Graph refresh
   reads only the two deployment flags. The selected-resource endpoint can return the
   current `.env` value for a defined authored resource to its inspector, without caching.
   Snapshots, diffs, logs, printed models and disk journals never contain authored secrets.
   Deployment status, plans, logs and job records carry secret *names* only.
7. **The local boundary.** Loopback only, a Host check, the token and the origin check.
   Processes run only as typed registry operations: a fixed script, validated
   parameters, no shell and an explicit working directory. Do not add a generic command
   or file endpoint.
8. **AWS only through the repository's scripts.** The studio holds no AWS SDK or
   credentials. Observation (discover and status) is read-only. Cloud writes happen only
   as an explicit Apply of a reviewed plan, through the same scripts the CLI uses. Database observation and application have their own target-bound review in the [database workbench](database-workbench.md).
9. **Views are views.** Selecting, panning or laying out never writes. The isometric scene
   is a pure function of the model.
10. **Graph switching shows facts, not new places.** Presence and ghosting change with the
    mode, and positions never do.
11. **The framework stays usable without the studio.** Changes to `packages/framework` must
    be additive and covered by `framework:check` (as `locateConfigSource` is).

Invariants 6–8 were revised by [Deploy & Run](deploy-and-run.md).

## Recipes

### Make another field editable

1. Add a `FieldDefinition` to [server/edits/fields.ts](../../framework-studio/server/edits/fields.ts):
   - its id and label;
   - its property path;
   - its domain, from a framework constant where one exists;
   - its `after`/`before` insertion anchors, chosen from the repository's own ordering;
   - `applies(target)`;
   - `resolve()`, which returns the effective value, its provenance in words, and what
     removing it would inherit.
2. Nothing else changes. Planning, splicing, preflight, the transaction, the inspector
   control and undo are generic.
3. The no-op round-trip test in `test/plan.test.ts` already writes back every editable
   literal it finds. Add a targeted plan test for the new field, and a preflight case where
   the framework refuses it.

A field that is not a literal in an object literal (an array entry, a call argument, a
value behind an identifier) needs new splice and editability support first. Do not widen
`propertyAt` to guess.

### Edit something outside the sections (VPCs, defaults)

The locator exposes imported VPC modules in `located.networks`. The typed network and
placement edits in `server/edits/networks.ts` update those declarations through the
existing reviewed batch transaction. Placement changes write the imported VPC reference
and subnet together; settings edits retain the VPC's identity. Evaluation rebuilds each
network with `defineNetwork` in both modes before source is applied.

Other root properties remain available in `located.properties` (`defaults`, `resources`,
`database`, `userPool`). Add dedicated editability support before expanding their UI.

### Add an entity or relationship to the model

1. Project it in [server/model/project.ts](../../framework-studio/server/model/project.ts)
   from a framework function.
2. Type it in [shared/model.ts](../../framework-studio/shared/model.ts).
3. Index it in [src/lookup.ts](../../framework-studio/src/lookup.ts).
4. For an edge, give it a `Relation` and a category.
5. Add a real-repository assertion to `test/model.test.ts`.

The Board, Inspector and isometric view pick up new edges by category. New entity kinds
need a building (see the [isometric view's extension table](isometric-view.md#extending-it)).

## Verifying a change

```powershell
npm --workspace framework-studio run typecheck   # browser and server halves
npm --workspace framework-studio test            # the studio's tests, against the real repository
npm run verify                                   # everything the repository checks, studio included
npm run studio -- --print                        # the snapshot as JSON, for a quick look at the model
```

| Test file | Holds |
| --- | --- |
| `model.test.ts` | Projection against the real repository, lanes and placement rules, catalog members, source locations, editability |
| `splice.test.ts` | The text operations, byte for byte |
| `plan.test.ts` | Planning against the real repository: no-op round trips, inserts, nested fields, workflow options, refusals |
| `transaction.test.ts` | Writes on a disposable copy under `.cache/framework-studio/`: apply, refuse, conflicts, expiry, stale config, atomicity |
| `guards.test.ts` | The Host, token and origin checks, and the write allowlist |
| `iso.test.ts`, `landscape.test.ts`, `isometric-ui.test.ts` | Projection, scene layout against the real repository, presence, walls, camera, picking, card placement, icon silhouettes, metadata search and selection override/restore |

Tests do not prove what a browser does. For a UI change, run the studio and use it:

1. Start a second studio:

   ```powershell
   node --import tsx framework-studio/server/index.ts --port 4591
   ```

   The owner usually has one running on 4590. Leave it alone.
2. Drive it with real input (Playwright or by hand). For the canvas, ask
   `window.__studioLandscape` where something is drawn, then click there.
3. Screenshots from the Playwright tools must be saved inside the workspace (for example
   `.playwright-mcp/`). Delete that folder afterwards.
4. Confirm that `git status` shows no change under `framework-config/` unless you meant
   one.

Config-level checks are not a synth. Infrastructure claims still need both synth paths, as
[Framework](../FRAMEWORK.md#generated-contracts-and-verification) describes.

## Gotchas already found

- **Ports.** The owner's own studio usually holds 4590. `EADDRINUSE` on 4590 means
  "use `--port`", not "kill something".
- **Stopping on Windows.** Stopping `npm run studio` from a tool can leave the `node` child
  running and holding the port. Run `node --import tsx framework-studio/server/index.ts`
  directly, or stop it with Ctrl+C. The evaluator children exit by themselves when their
  parent's IPC channel closes.
- **CommonJS.** The workspace is CommonJS on purpose (see Architecture, Evaluation). There
  is no top-level `await` in server code. A scratch script importing studio modules from
  outside the workspace must be `.mts` and import by `file://` URL.
- **React 19.** `useRef<T>()` needs an explicit initial value
  (`useRef<T | undefined>(undefined)`).
- **Vite** runs in middleware mode, from `vite.config.mts`. `npm --workspace
  framework-studio run build` is only a bundle check (about 136 KB gzipped). Delete
  `framework-studio/dist` afterwards.
- **Dependencies.** Change the lockfile only with npm 11, then run
  `node scripts/check-lockfile-platforms.mjs`. The studio deliberately reuses packages
  the repository already locks.
- **Scratch directory.** `.cache/framework-studio/` holds the synthetic inputs files, the
  temporary files for atomic writes, and test fixtures. It is gitignored.
- **Compose Watch.** It restarts the dev servers and the invocation runner whenever
  `framework-config/` changes, so local executions in flight, and their histories, are
  lost. The edit preview says so.
- **Generated files.** Source reviews must include any framework projections changed by
  the declaration. Always use the framework generator and verify source plus generated
  output together; never hand-author the projection.
- **The isometric canvas is always dark**, whatever the page's theme. Its chrome uses its
  own dark styles.
- **Mid-gesture changes.** Events that change the canvas's size or the selection while a
  gesture is under way move the camera. Recompute screen positions after any click that
  might open the inspector.
- **Two clicks inside a double-click.** A double-click toggles the selection on and off;
  the double-click handler then selects explicitly. Keep that when changing click handling.

## Current boundaries and next work

Use the [capability matrix](../aws-studio-knowledge/reference/capabilities.md) and
[product audit](product-audit-2026-10-22.md) for implementation scope. The old five-field,
no-network/no-relationship/no-observability roadmap is superseded by source-reviewed
creators, networks, resource references, database workbench and deployment operations.

- Computed declarations and commented removals still require a deliberate source edit
  when a lossless transformation cannot be proved.
- The map represents declarations, with separately labeled CDK source inferences.
  Deploy reports observed cloud/local status; neither view proves application health.
- Native file watching has visible failure reporting, periodic content comparison and
  retry. Platform-specific event delivery still needs real-device verification.
- Layout remains computed. Search, filtering, selection and resource navigation never
  change infrastructure identity. Manual arrangement is a future view preference.
- CloudWatch application logs/metrics/traces and workflow execution overlays are future
  capabilities; CloudFormation events and local container logs already exist.
- Production deployment, private IAM database access, runtime model calls and recovery
  require separately authorized live tests. Offline tests are evidence of their own scope.

Meaningful next additions include a read-only workflow execution overlay using the
existing invocation runner, a structured workflow IR view, and measured touch/GPU
performance work. Native resource templates should expand through the typed creator
and exact-file review contract, not a generic code-writing endpoint.
