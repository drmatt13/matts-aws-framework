# Moving Framework Studio forward

What to know before changing the studio: the rules it depends on, how to extend it, how to
verify a change, the traps already found, its known limits, and where it could go next.

## Where things stand

- Map, Database, Deploy, Cognito, Domains and WebSockets are the six routed workspaces.
  Board remains unrouted; the shared shell owns source context and selection.
  Supported authoring uses a draft, validated review and guarded source application.
- The [knowledge router](../aws-studio-knowledge/README.md) owns current subsystem
  contracts and verification routes. The [declaration guide](declarations-and-tags.md)
  explains the consolidated workload layout and metadata; filenames do not register
  workloads or establish deployment identity.
- Owner decisions still in force: a TypeScript renderer (no Bevy/WASM), a host process
  (not Compose), and preview-then-apply (never write immediately).

## Invariants

Break one of these and the studio stops being trustworthy:

1. **One authoritative application model.** Normalized declarations come from
   `@repo/framework/config`; source indexing and explicitly observed operational evidence
   add labeled facts. Do not add a second catalog, identity scheme, workflow representation
   or deployment rule. Preserve provenance and show unknown where evidence is missing.
2. **Identities are the framework's.** Targets are `kind:id`, routes are
   `route:<kind>:<path>`, resources are `resource:<catalog path>`. Layout positions and
   workflow node ordinals are not identities, and must not be persisted against.
3. **Authored source owns intent.** Supported writers have bounded file authority:
   configuration, declared native transforms and scaffold/generator outputs use reviewed
   source changes; Prisma and protected environment values have separate services.
   Preserve unrelated bytes and comments. Consult [backend boundaries](../aws-studio-knowledge/studio/backend.md)
   instead of assuming one configuration allowlist covers every editor.
4. **Validate before writing; verify afterward.** Configuration reviews bind to source
   hashes and expected effects, then reevaluate disk state after application. Specialized
   editors have their own validation and recovery rules; a source save does not validate
   the live application or grant deployment authority.
5. **Never overwrite someone else's change.** Stale revisions or changed files refuse
   application. Interrupted-write recovery preserves subsequent edits. Saved-source
   history is Git; there are no global source Undo/Redo endpoints.
6. **Distinguish public metadata from private values.** Public source parameters may
   appear in snapshots. Private environment contents use protected selected-detail
   services and redacted reviews. Synthetic evaluator inputs do not isolate the inherited
   host environment or make an untrusted repository safe. See [environment delivery](../aws-studio-knowledge/runtime/environment.md).
7. **The local boundary.** Loopback, Host/token/origin checks and typed operation adapters
   protect the local tool. Do not add generic shell or arbitrary-file endpoints. See
   [backend authorities](../aws-studio-knowledge/studio/backend.md).
8. **Operational approval is specific.** Deployment scripts and dedicated database,
   identity, DNS and release services have distinct targets, reviews and outcome rules.
   Source approval is not cloud authorization; plan preparation can create AWS change
   sets. See [operational lifecycle](../aws-studio-knowledge/deployment/lifecycle.md).
9. **Views are views.** Selecting, panning or laying out never writes. The isometric scene
   is a pure function of the model.
10. **Graph switching shows facts, not new places.** Presence and ghosting change with the
    mode, and positions never do.
11. **The framework stays usable without the studio.** Changes to `packages/framework` must
    be additive and covered by `framework:check` (as `locateConfigSource` is).

The [decision records](../aws-studio-knowledge/architecture/decisions.md) explain these
boundaries. [Deploy & Run](deploy-and-run.md) preserves the original design history.

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
2. Reuse generic planning/splicing and draft controls where the source shape permits;
   check field projection, preflight, generated artifacts and the applicable transaction.
   A new domain may require a dedicated writer. See the [extension recipe](../aws-studio-knowledge/guides/extensions.md#inspector-editable-property).
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

The Inspector and isometric view use edge categories; the unrouted Board also consumes them. New entity kinds
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
3. Save disposable screenshots and traces in ignored `output/playwright/<task>/`.
   Record useful findings before removing raw output; preserve intentional visual
   references beside the browser specs. Follow the [repository hygiene guide](../REPOSITORY-HYGIENE.md)
   for retention and exact-target cleanup.
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
  framework-studio run build` is only a bundle check (measure the current output rather than relying on an old size). Delete
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
[current status](../aws-studio-knowledge/reference/status.md) for implementation scope.
The [product audit](product-audit-2026-10-22.md) is a historical baseline. The old five-field,
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
