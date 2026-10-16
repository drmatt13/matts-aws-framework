# Framework Studio

A local view of `framework.config.ts` that you can also edit, for a few fields. It shows:

- what each declaration is;
- where it runs: locally, in a development deployment, in a production deployment;
- what it reads, grants and invokes;
- where it was written.

```powershell
npm run studio            # http://127.0.0.1:4590/  (--port <n>, or STUDIO_PORT)
npm run studio -- --print # the whole model as JSON, then exit
```

It runs on your machine beside your editor, not in Compose. When it writes a file,
Compose Watch carries the change into the running dev servers, just as a save in your
editor would.

The design, history and roadmap are in [docs/framework-studio](../docs/framework-studio/README.md).

## What it shows, and where that comes from

Every fact is the framework's own answer, never a second model:

- **Targets, routes and relationships.** These come from `getFrameworkTargets` and
  normalization. Env references, grants, `database: true`, invocations, workflow steps and
  integrations, and agent tools are all shown.
- **Lanes.** These come from `isTargetEnabled` and `isTargetDeployed`, for both graphs,
  including the special rules: a tool follows its agents, an event has no toggle, and a
  development deployment builds only what AWS invokes.
- **Production placement.** This comes from `resolveLambdaTarget` and the network helpers.
- **Source locations.** These come from `locateConfigSource` in
  `packages/framework/scripts/config-source.ts`, the same reader `framework:check` uses.
- **Stack members.** These are read from each `resource.stack<T>()` class.
- **Link sites.** These are `linkResources` calls found in `cdk-app/lib`.

Each graph is evaluated in its own child process, with a synthetic inputs file holding
only `PROD_DEPLOYMENT`. The studio reads exactly two keys from `cdk-app/.env`:
`PROD_DEPLOYMENT` and `DEPLOY_PROD_WEBSOCKET_API`.

## The isometric view

`/isometric` draws the same model as a landscape of floating islands, on a 2D canvas.
It is a view, not a second model:

- Every building is an entity the model names, under the model's own id.
- Selecting a building selects that entity everywhere, and opens the same inspector, with
  the same edits.
- Positions, islands and colours are layout, computed from the model on every refresh.
  Nothing about them is written to disk or read back as configuration.

The regions mean something:

| Region | What stands there |
| --- | --- |
| Entry islands | Routes, one island per gateway that serves them: HTTP API, WebSocket API, agent routes |
| Compute | Lambdas outside the VPC; AgentCore agents and their tools; Step Functions workflows |
| The VPC | A terraced mesa, stepping down from the public subnet to the private and isolated ones. Each workload stands on the terrace its production placement names |
| Catalog | One island per `resource.stack<T>()`, its members on it, plus authored inputs and secrets |

The Development/Production switch changes how each building is drawn, never where it
stands:

| Drawing | Meaning |
| --- | --- |
| Solid | That deployment builds it |
| Amber hologram | Only Compose runs it |
| Dashed ghost | It is absent from that graph, or runs nowhere |

The VPC is drawn as a blueprint wherever no deployment builds it. Lane dots on each card
always show all three lanes.

| Input | Action |
| --- | --- |
| Drag | Pan (a press that moves less than 6 px is a click) |
| Wheel or pinch | Zoom about the pointer |
| Double-click | Fly to a building |
| Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |

Edges are the model's typed relationships, in the Board's five categories, and can be
filtered. Hovering an edge, a building, a gateway or the ground explains it. Packets move
only along the selection's edges, and the Pause button or reduced-motion stops them. A
still picture draws no frames.

`window.__studioLandscape` exposes read-only camera, picking and frame statistics, for
tests and the browser console.

## What it edits

It edits `deploy`, a Lambda's `subnet`, `memorySize` and `timeoutSeconds`, and a
container's `cloud.subnet`, and only where the source writes a literal, or writes nothing
and the parent is an object literal. Anything an expression computes is shown read-only.

Every change goes through these steps:

1. **Plan.** It becomes a one-span text edit, never a re-print of the file. Before it is
   offered, the new text must parse, and the locator must read the same entry back with
   the new value.
2. **Preview.** The framework's own validation runs for both graphs on the changed config.
   You see its verdict, in its own words, beside the exact diff.
3. **Write.** The write is refused if the file changed since the preview. Otherwise the
   file is replaced atomically, re-evaluated from disk, and must resolve as predicted; if
   it does not, the write is undone.
4. **Undo and redo.** These restore exact bytes, and refuse if the file has changed since.

The checks are config-level. They do not prove a CDK synth or a deployment: run those
separately, as Framework describes.

## Safety

- It binds to 127.0.0.1 only.
- It answers only to `127.0.0.1:<port>` or `localhost:<port>` as the Host.
- The API needs a per-process token that is served in the page.
- Changes must come from the studio's own origin.
- It writes only `framework.config.ts` and `framework-config/**/*.ts`.
- It runs two commands, `framework:check` and `framework:generate`, with fixed arguments
  and no shell. The generator runs only after you confirm it.

## Layout

| Path | What it does |
| --- | --- |
| `server/model/` | Projection, origin parsing, preflight |
| `server/source/` | Source locations, editability, stack members, link sites |
| `server/edits/` | Field registry, text splices, planning, transactions |
| `server/evaluator/` | The per-graph child processes |
| `src/` | The page, with the board, the lanes, the inspector and the preview |
| `src/scene/` | The isometric view: projection, layout, building shapes, the generated block atlas, camera, picking, the canvas renderer |
| `shared/` | The types both halves share |

Tests (`npm --workspace framework-studio test`) run against the real configuration in
memory, and against a disposable copy under `.cache/framework-studio/` when they write.
