# Framework Studio: what has been built, and why

Status as of 2026-10-16.

## Summary

Framework Studio is a local web application in the `framework-studio` workspace. It shows
the application `framework.config.ts` declares, as a board, a lanes diagram and an
isometric landscape, and it edits five kinds of field back into the TypeScript source. Every
fact it shows is computed by `@repo/framework/config`. There is no second model of the
application, no second resource catalog and no second identity scheme.

It was built in two phases:

| Phase | Contents | State |
| --- | --- | --- |
| 1, Studio v0 | Model projection, source map, Board, Lanes, Inspector, validated edit loop, live refresh | Committed in `d1e3d1d` ("10/16-framework-studio") |
| 2, Isometric view | A Canvas2D landscape of the same model, wired to the same selection and inspector | In the working tree, not yet committed |

Both phases pass `npm run verify`, which runs the studio's 60 tests alongside the rest of
the repository's suites.

## Where it started

The owner's brief was a unified visual development environment for this framework: one
that understands its workloads, resources, workflows, networking and deployment lanes;
edits the real TypeScript configuration; and might be rendered as an isometric world,
possibly with a Rust/Bevy/WebAssembly engine. The brief arrived with a
[handoff document](../../UNIFIED_AWS_FRAMEWORK_VISUAL_EDITOR_HANDOFF.md). It asked that
document, and the owner's own ideas, to be treated as hypotheses to test against the
repository rather than as instructions.

### What the repository already provided

The investigation found that most of what an editor needs already exists in the framework:

| Finding | Where |
| --- | --- |
| Composition merges section arrays by key and normalizes eagerly. `normalize()` is recomputed on every call, so a patched in-memory config can be validated freely | `packages/framework/src/config/index.ts` (`defineFrameworkConfig`, `normalizeFrameworkConfig`) |
| Identity is canonical and separate from routes: a target is `kind:id`, routes are keys, construct ids are derived or pinned. Normalized targets carry logical origins such as `http["/graphql"]` | `NormalizedTarget`, `origins` |
| Every relationship worth drawing is already typed data: environment references, `cloud.bindings` (native grants, `runsTask`, `startsWorkflow`, `invokesAgent`, `completesCallback`), `database: true` as `connectsTo`, startup secrets | `resolveTargetSettings` |
| Lanes are computed, not guessable from `deploy`: tools follow their agents, events have no toggle, a development deployment builds only what AWS invokes, and the WebSocket API flag changes that | `isTargetEnabled`, `isTargetDeployed`, `getToolDeploySetting` |
| Network placement and egress are computed | `resolveLambdaTarget().subnet`, `subnetEgress`, `hasEndpoint` |
| The workflow IR is a pure-data tree with generated state names, and the local runner's history names states the same way | `workflow-ast.ts`, `workflow-normalize.ts`, `local-invocation-runner` |
| Static source resolution exists: `framework:check` already follows the composition root into each section module with the TypeScript compiler API | `packages/framework/scripts/config-source.ts` |
| Framework error messages are precise and name the fix | throughout `config/index.ts` |

### Where the brief was wrong

| Brief | Repository |
| --- | --- |
| A new graph schema and identity scheme | Unnecessary: the normalized targets, routes and bindings are the graph |
| Reuse the Bevy renderer | Its source is not in this repository. A TypeScript renderer was chosen instead |
| Docker Compose sidecars for repository access | Compose Watch syncs one way, host to container, and AGENTS.md forbids mounting the checkout. Writes have to happen on the host |
| Scrape `workflows:inspect` | Its data path (`getWorkflows`) is directly reusable |
| Workflow step ids are durable | They are construction-order ordinals: fine for run overlays against the same source, wrong for persisted layout |
| Secrets are a large risk | The studio can avoid reading `cdk-app/.env` altogether, except two non-secret keys |

## Decisions the owner made

| Question | Decision | Why |
| --- | --- | --- |
| What should the first experiment emphasize? | The edit loop and a 2D board; the isometric view later | Safe round-trip editing of TypeScript was the riskiest assumption, so it was proven first |
| Bevy/WASM or TypeScript? | A TypeScript port of the isometric math | No Rust toolchain or WASM bundle for contributors, and the renderer source was not available |
| How do edits reach the files? | Preview, then apply | Every change shows both graphs' validation and the exact diff before anything is written |
| Where does the studio run? | A host process, `npm run studio` | It must write the checkout, and Compose cannot |

For the isometric phase, the owner asked for implementation over further planning, with
creative freedom over art direction.

## Phase 1: Studio v0

### What it does

- **Model.** Both deployment graphs, dev and prod, are evaluated and projected into a
  sanitized snapshot. It holds 29 targets, 17 routes, 28 catalog entries and 79 typed edges
  for this repository.
- **Source map.** Every target, route and catalog entry maps to `file:line:col`, with an
  *Open in VS Code* link. It also shows stack-class members, including ones nothing reads
  yet, and the `linkResources` call sites that bind them.
- **Board.** Entry points, compute and catalog in three columns, with relationship curves
  you can filter by category.
- **Lanes.** A transit-map diagram of local, dev AWS and prod AWS for every workload,
  with the framework's reason for each answer.
- **Inspector.** For one entity:
  - lanes, and its production placement;
  - each field's authored value and its resolved value, with where that comes from
    (entry → section default → `defaults.lambda` → framework default);
  - environment and relationships;
  - for a workflow, its steps.
- **Edits.** `deploy`, a Lambda's `subnet`, `memorySize` and `timeoutSeconds`, and a
  container's `cloud.subnet`.
- **Edit transaction.**
  1. **Plan.** The intent becomes a one-span text splice.
  2. **Preflight.** The framework's own validators run against the patched config for both
     graphs.
  3. **Preview.** You see the verdicts, the diff and the impact notes.
  4. **Apply.** The file is written atomically, but only if it is unchanged since the
     preview.
  5. **Confirm.** The studio re-evaluates from disk and auto-reverts if the result differs
     from the prediction.
  
  Undo and redo follow.
- **Live refresh.** Files are watched, and changes made outside the studio are flagged.
  If the config stops loading mid-edit, the last good model stays on screen, greyed, with
  editing paused.
- **Commands.** `framework:check`, and `framework:generate` after confirmation, run with
  fixed argv and no shell.
- **Security.** It binds to loopback only, checks the Host header, needs a per-process
  token and the studio's own origin, and writes only `framework.config.ts` and
  `framework-config/**/*.ts`.

### Why it is built this way

- **One framework, two processes.** Each graph is evaluated in a child process, the way
  `workflows:inspect` loads the config. That is the only way to see an edited module fresh,
  and it keeps a misbehaving config out of the server. Each child gets a synthetic inputs
  file that holds only `PROD_DEPLOYMENT`, so it never parses an authored secret.
- **Splices, not re-printing.** Edits replace, insert or remove one span and leave every
  other byte alone: comments, quotes, `satisfies`, imports. A no-op edit reproduces the
  file byte for byte, and that is tested for every editable literal in the repository.
- **The source must agree with the evaluated config.** A literal is editable only when the
  value the AST holds equals the value the framework evaluated. Anything an expression
  computes, a spread may supply, or two routes share is shown read-only, with the reason.
- **Validation before the file exists.** The text edit and a matching in-memory patch of
  the evaluated config are computed together. Validating the patch is validating the edit,
  without writing a file that Compose Watch would immediately restart the dev servers on.
- **The framework's reader, extended rather than copied.** `config-source.ts` gained
  `locateConfigSource`, and `readSectionKeys` is now built on it. `framework:check`
  exercises the shared code on every run.

### Verified

- `npm run verify` passed.
- A real edit end to end: `example-service` `deploy` from `local-only` to `both`.
  - The diff was one line in `framework-config/services/example.ts`.
  - The board refreshed: prod AWS now holds it.
  - `framework:check`, run from the studio, passed in 2.1 s.
  - Undo restored the file byte for byte (`git diff` empty).
- A refused edit: setting `invocation-test-task` to `local-only` was refused in both graphs,
  with the framework's own message (`/test/run-task` still calls it from the cloud lane).
- A broken file edited outside the studio: the health indicator named `database.ts:18:25`,
  the last good model stayed on screen with editing paused, and the studio recovered when
  the file was fixed.

## Phase 2: the isometric view

### What it does

`/isometric` draws the same model as floating islands on a dark field. Islands have
textured pixel-art tops and side walls that fade into the void. Raised ground hides
whatever stands behind it.

- **Regions that mean something:**
  - **Entry points:** one island per gateway that serves them (HTTP API, WebSocket API,
    agent routes).
  - **Compute:** Lambda outside the VPC, AgentCore, and Step Functions.
  - **The VPC:** a terraced mesa stepping down from the public subnet to the private and
    isolated ones, with its gateways and endpoints. Each workload stands on the terrace
    its production placement names.
  - **The catalog:** one island per `resource.stack<T>()`, and one for authored inputs and
    secrets.
- **Buildings per kind.** Each kind of route, workload and resource has its own small
  building. A Lambda's roof shows how it is invoked.
- **Presence follows the selected graph.** Each building is drawn one of three ways:

  | Drawing | Meaning |
  | --- | --- |
  | Solid | That deployment builds it |
  | Amber hologram | Only Compose runs it |
  | Dashed ghost | It is absent, or runs nowhere |

  The VPC is a blueprint wherever no deployment builds it. Switching graphs never moves
  anything.
- **The model's typed relationships** are drawn as arcs in the Board's five categories.
  The selection lights its arcs, with a few moving packets, and dims everything else.
- **Interaction:**
  - drag to pan, with a 6 px click threshold;
  - wheel or pinch to zoom about the pointer;
  - fit, focus and fly-to;
  - keyboard controls;
  - hover readouts for buildings, arcs, gateways and ground;
  - a hidden list of entities for screen readers.
- **Integration.** Selection is the same URL parameter as the other views, so the inspector,
  its edits and the preview dialog are the existing ones.

### Why it is built this way

- **Canvas2D, not SVG, PixiJS or WebGL.** The view draws about 1,200 textured tiles and 74
  buildings, with depth interleaving and polygon picking. Canvas2D does that in 2–4 ms a
  frame with no new dependency and full control of draw order. The plan's SVG would have
  meant thousands of DOM nodes for the terrain. All drawing sits in one module, so a WebGL
  backend could replace it.
- **A view, never a model.** Layout is a pure function of the model: deterministic, and
  identical for both graphs. Nothing about positions is persisted or read back as
  configuration.
- **Regions from framework semantics.** The VPC terraces come from `placement`, so a
  Lambda outside the VPC is shown as "in no subnet", not as "public". Presence comes from
  `lanes` and `absent`, and the gateway island captions quote the framework's rules (no HTTP
  API in a development deployment, `DEPLOY_PROD_WEBSOCKET_API`).
- **The doc's technical references were adopted where they fit.** These include:
  - 2:1 projection with height, and height-aware picking;
  - diagonal painter's order with buildings interleaved by row;
  - 32×32 sprites drawn at 2× into 64×64 quads, in an edge-extruded 34×34 atlas;
  - pointer-anchored exponential wheel zoom;
  - sparse, selection-driven packets.

  The doc's pixel numbers (64 × 32 tiles, 16 per step) are used as given.

### Departures from the phase brief

- **Labels.** They are canvas-drawn cards with leader lines, and DOM overlays were not used.
  Cards are dropped by priority where they would collide, rather than shrunk.
- **No manual layout.** There are no overrides and no persistence. Positions are computed.
- **No workflow run overlays and no relationship editing.** Both were explicitly out of
  scope for the phase.

### Verified

- **Scene against the real repository.** Every route, target and catalog entry stands
  exactly once under its own id, and all 79 edges are the model's. Layout is identical across
  graphs and deterministic. Presence matches lanes and absence. Placement matches subnets,
  and walls appear only where the ground drops.
- **Camera.** The point under the cursor stays within 1 px through zoom, over 45 zoom
  steps (three viewports, three anchors, five wheel deltas) in unit tests. In the browser it
  held at (320.0, 430.0) through 0.44× → 1.30×, and within 0.18 px at device pixel ratio 2
  after a resize.
- **Picking.** In unit tests, overlapping cards pick the one painted last, a card beats
  a building, and overlapping silhouettes pick the front one. Terrain is picked at its own
  height. In the browser, buildings picked correctly at 0.61×, 1.04× and 1.79×, and cards
  over other buildings won.
- **Interaction in the browser:**
  - a drag starting on a building pans and selects nothing;
  - a 3 px wobble is still a click;
  - opening the inspector shifts the world by 0 px;
  - inspector relation links fly the camera to their entity;
  - the camera survives switching views;
  - keyboard and screen-reader-list selection work.
- **Integration.** From the isometric view, a memory edit previewed with both graphs'
  verdicts and the diff, and cancelling wrote nothing.
- **Performance, headless Chromium:**

  | Case | Cost |
  | --- | --- |
  | Full overview, 1,300 items | 3.5–3.8 ms a frame |
  | Busiest selection animating at overview | 2.9 ms median, 5.7 ms p95 |
  | No selection, or motion paused | 0 frames drawn |
- `git status` showed no change outside `framework-studio/` after any camera, layout or
  selection interaction.

## Changes outside `framework-studio/`

| File | Change |
| --- | --- |
| `packages/framework/scripts/config-source.ts` | Added `locateConfigSource`; `readSectionKeys` is a projection of it, with identical errors |
| `packages/framework/test/config-source.test.ts` | New: spans for every origin, a spread-array fixture, identical refusal messages |
| `package.json` | The `framework-studio` workspace and the `studio` script |
| `package-lock.json` | The workspace link and three nested packages, updated with npm 11. The platform-binding check passes |
| `README.md` | One row in the "I want to…" table |

Nothing in `cdk-app/`, the runtime, local execution, Compose, generated files or
`cdk-app/.env` was changed.
