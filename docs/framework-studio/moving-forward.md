# Moving Framework Studio forward

What to know before changing the studio: the rules it depends on, how to extend it, how to
verify a change, the traps already found, its known limits, and where it could go next.

## Where things stand

- Phase 1 (Board, Lanes, Inspector, edit loop) is committed in `d1e3d1d`.
- Phase 2 (the isometric view) is in the working tree: `src/scene/*`,
  `src/views/Isometric.tsx`, `test/landscape.test.ts`, and edits to `main.tsx`,
  `Shell.tsx`, `styles.css`, `scene/iso.ts` and the README. It passes `npm run verify`. It is
  not yet committed.
- `FRAMEWORK_STUDIO_ISOMETRIC_PHASE_PROMPT.md` at the repository root is untracked. Keep
  it, move it here, or delete it, as you prefer.
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
7. **The local boundary.** Loopback only, a Host check, the token, the origin check, and
   two fixed commands with no shell. Do not add a generic command or file endpoint.
8. **Nothing outward-facing.** No AWS calls, no synth or deploy, no secret upload, no
   database action from the studio.
9. **Views are views.** Selecting, panning or laying out never writes. The isometric scene
   is a pure function of the model.
10. **Graph switching shows facts, not new places.** Presence and ghosting change with the
    mode, and positions never do.
11. **The framework stays usable without the studio.** Changes to `packages/framework` must
    be additive and covered by `framework:check` (as `locateConfigSource` is).

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

### Edit something outside the sections (the network, defaults)

Origins today are section entries (`http["/x"]`, …). The locator already finds the other
properties in `located.properties` (`network`, `defaults`, `resources`, `database`,
`userPool`).

- To edit `framework-config/network.ts`, add an origin form for it in
  `server/model/origin.ts` and a `declarationObject` case for the `defineNetwork({ … })`
  argument.
- In `applyPatch`, rebuild the network with `defineNetwork` rather than patching the
  frozen evaluated object, because `defineNetwork` applies defaults and brands its result.
- Preflight will then report cost and endpoint consequences in the framework's words.

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
| `iso.test.ts`, `landscape.test.ts` | Projection, scene layout against the real repository, presence, walls, camera, picking, card placement, atlas, silhouettes |

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
- **Generated files.** Some edits make generated files stale. Changing a service's
  `deploy` changes `docker-compose.services.yml`, so `framework:check` fails until
  `framework:generate` runs. The studio offers the generator after a failed check.
- **The isometric canvas is always dark**, whatever the page's theme. Its chrome uses its
  own dark styles.
- **Mid-gesture changes.** Events that change the canvas's size or the selection while a
  gesture is under way move the camera. Recompute screen positions after any click that
  might open the inspector.
- **Two clicks inside a double-click.** A double-click toggles the selection on and off;
  the double-click handler then selects explicitly. Keep that when changing click handling.

## Known limitations

- **Editing:**
  - Only five fields can be edited.
  - No relationship, catalog, network or workflow editing yet.
  - A target declared by two routes is read-only.
  - Removing a commented property is refused.
- **Workflows.** Shown as a step list in the inspector. There is no graph view and no run
  overlay.
- **Watching.** `fs.watch` behaviour on Windows under heavy saves is unmeasured; a polling
  fallback may be needed. A refresh costs about 0.7 s (two child processes).
- **Isometric:**
  - Layout is computed only, with no manual arrangement or persistence.
  - Cards are canvas text, and below 0.55× only island titles and emphasised cards show.
  - Arcs are drawn between roofs and do not follow network topology.
  - Performance was measured headless only.
  - Narrow screens leave the canvas small when the inspector is open.
- **No AWS observability.** Nothing from deployed accounts or CloudWatch is shown, and none
  is claimed.

## Roadmap

These are ranked by value for effort. Each is a separate change with its own tests.

1. **Commit Phase 2.** It is verified and self-contained.
2. **Local run overlay.**
   - **Source.** The invocation runner already serves `GET /workflows` and
     `GET /workflows/:executionId` (callback tokens redacted) on `127.0.0.1`, at
     `LOCAL_INVOCATION_RUNNER_HOST_PORT`. Its history events name states exactly as
     `workflow.names` does.
   - **Plumbing.** Add a GET-only, read-only proxy route to the studio server, polled or
     streamed over SSE. Then light buildings and arcs in the isometric view as executions
     touch them.
   - **Caveat.** Histories are in memory and are lost when Compose Watch restarts the
     runner.
3. **Workflow view.** A structured layout of the IR (sequence, parallel, map, choice,
   retry, attempt) as nested boxes. The IR is a tree, so no graph-layout library is needed.
   Clicking a workflow island could open it in place. Map steps to source by replaying
   builder-call order against the source, and show nothing rather than guess when the
   counts disagree.
4. **Network panel and edits.**
   - **Show:** what each workload can reach (IPv4, IPv6, endpoints, the database), and the
     monthly cost from `NETWORK_PRICES`.
   - **Edit:** `natGateway`, `egressOnlyInternetGateway` and endpoints, previewed with the
     framework's endpoint and cost messages. This needs the non-section editing described
     above.
5. **Relationship edits.** Add or remove `runsTask`, `startsWorkflow` and grants, and
   environment references to catalog attributes. This needs array-element splices and
   import management, so design the transaction first.
6. **Catalog authoring.** `resource.fromEnv` and `resource.secret` declarations, together
   with the `cdk-app/.env.*.example` lines AGENTS.md requires. Native CDK stays code-first,
   with links to the stack class and its `linkResources` site.
7. **Isometric polish.** The two-environment presentation (Development/Production), quiet
   exception badges, thin background grid, official AWS SVG icons, quieter
   terrain and source-inferred CDK resource links are now implemented. The link index is
   disposable under `.cache/framework-studio/cdk-links.json`, rebuilt on refresh; see
   [Architecture](architecture.md#the-source-index) before extending its inference rules.
   - **Layout overrides** in a separate, clearly non-configuration file (under `.cache`
     for personal use, or a checked-in editor file if a team should share it), keyed by
     entity id.
   - **Text.** DOM overlays for card text at extreme zooms.
   - **Keyboard.** Navigation between entities.
   - **Touch.** Testing on real devices.
   - **Performance.** A measured GPU profile, before any WebGL backend.
8. **Machine-readable diagnostics.** Framework errors already name their fixes. Structured
   fixes would let the studio offer them as one-click previews (for example "add `ecr.api`
   to `interfaceEndpoints`").

## Open questions for the owner

- Should Phase 2 be committed as it is, or after further art direction?
- Should layout overrides be personal (ignored) or shared (checked in)?
- Which comes next: the run overlay, the workflow view, or network editing?
- Should `AGENTS.md` point agents at these documents for studio work?
