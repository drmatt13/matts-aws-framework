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
| `shared/` | The types both halves share |

Tests (`npm --workspace framework-studio test`) run against the real configuration in
memory, and against a disposable copy under `.cache/framework-studio/` when they write.
