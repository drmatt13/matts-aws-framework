# Framework Studio

Framework Studio is a local, source-linked visual environment for applications built
with this framework. It reads `framework.config.ts` the way the framework does, shows what
the configuration declares, where each piece runs and how the pieces relate. It edits a
small set of fields back into the TypeScript source, after a validated preview.

It is an experiment. The framework never depends on it: everything it shows comes from the
framework's own normalization, and everything it writes is an ordinary edit to
`framework-config/`, which `framework:check`, synthesis and the dev servers read as usual.

```powershell
npm run studio            # http://127.0.0.1:4590/   (--port <n>, or STUDIO_PORT)
npm run studio -- --print # the whole model as JSON, then exit
```

## Views

| View | Path | What it is for |
| --- | --- | --- |
| Board | `/` | Every route, workload and catalog entry in three columns, with typed relationship curves |
| Lanes | `/lanes` | Two tracks: Development and Production, with the execution location inside each environment |
| Isometric | `/isometric` | The same application as a lit, navigable landscape: gateways, compute, the VPC's subnet terraces, catalog stacks |
| Inspector | beside any view | One entity: source location, resolved settings and where they come from, relationships, and the editable fields |

A Development/Production switch picks which deployment graph the views describe. Health
indicators for both graphs, undo and redo, and a `framework:check` button sit in the top bar.

The isometric view uses a thin world-anchored grid and local official AWS SVGs, with
Lucide outlines for generic concepts. **Refresh CDK links** rebuilds an ignored JSON index
from linked stack source; CDK edits also refresh it automatically. Source-inferred edges
have a separate filter and source links, including the resource flow in `referenceExamples`.

Deployment is presented as two environments throughout Studio. Board and Isometric omit
badges for entities available in both; Dev (flask), Prod (diamond) and Off
badges identify exceptions. The Inspector shows two environment cards. Development
combines local execution and its AWS-managed workloads; it does not treat these as
separate deployment states.

## Documents

| Document | Read it when |
| --- | --- |
| [Report](report.md) | You want to know what exists, why it was built this way, and what was verified |
| [Architecture](architecture.md) | You are changing the server, the model, source editing, or the browser's data flow |
| [Isometric view](isometric-view.md) | You are changing the landscape: layout, terrain, buildings, camera, picking or rendering |
| [Moving forward](moving-forward.md) | You are about to extend the studio: invariants, recipes, gotchas, known limits, the roadmap |

The code lives in [framework-studio/](../../framework-studio/README.md). Its README is
the short user-facing guide. These documents hold the design and the history.

## Background

- [UNIFIED_AWS_FRAMEWORK_VISUAL_EDITOR_HANDOFF.md](../../UNIFIED_AWS_FRAMEWORK_VISUAL_EDITOR_HANDOFF.md)
  is the original product brief. It is a hypothesis, and the [report](report.md#where-the-brief-was-wrong)
  records where the repository disagreed with it.
- `FRAMEWORK_STUDIO_ISOMETRIC_PHASE_PROMPT.md`, at the repository root, is the brief for the
  isometric phase. It is untracked at the time of writing.
- The framework itself: [Framework](../FRAMEWORK.md). The studio's semantics (lanes,
  placement, resources, workflows) are the framework's, so that document is the reference
  for what the studio shows.
