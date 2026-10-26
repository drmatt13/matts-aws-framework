# Framework Studio

Framework Studio is a local, source-linked visual environment for applications built
with this framework. It reads `framework.config.ts` the way the framework does, shows what
the configuration declares, where each piece runs and how the pieces relate. It creates
declarations and edits supported settings and connections in TypeScript source, after a
validated review.

The framework never depends on it: declaration views use framework normalization,
and reviewed writes remain ordinary source and migration files consumed by the existing
framework and Prisma workflows. The Database workbench edits its fixed authored Prisma
contract through a separate source authority; it does not expand the configuration writer.

```powershell
npm run studio            # http://127.0.0.1:4590/   (--port <n>, or STUDIO_PORT)
npm run studio -- --print # the whole model as JSON, then exit
```

## Views

| View | Path | What it is for |
| --- | --- | --- |
| Map | `/` | The isometric view: the application as a lit, navigable landscape: gateways, compute, the VPC's subnet terraces, catalog stacks. `/isometric` redirects here |
| Database | `/database` | Prisma source and diagram editing, semantic migration history, offline artifact review and selected-target database evidence |
| Deploy | `/deploy` | Deployment discovery, reviewed plans, authorized operations and local development controls |
| WebSockets | `/websockets` | ws-tester's two connection panels, local-ws-dev-server and the deployed API Gateway stage, with its launch-link handoff |
| Inspector | beside any view | One entity: source location, resolved settings and where they come from, relationships, and the editable fields |

The Board (`views/Board.tsx`, three columns of routes, workloads and catalog entries) is set
aside: its source and tests remain, but no route or navigation link opens it.

A Development/Production switch picks which deployment graph Isometric describes.
Deploy owns its named deployment/profile/account/region selection; Database requires an
explicit database target and separate approval for database changes. When the
configuration does not load, the canvas banner's **Show why** opens Configuration health.
Configuration health contains an optional saved-source audit for generated files and local
wiring under **Additional checks**. This runs `framework:check`; it is separate from the
automatic configuration validation and inspector preflight. The **Stacks** island inspector
owns CDK synthesis and its resource inventory; catalog stack inspectors offer a scoped
inline disclosure. These actions build local templates and never deploy or rewrite stacks.

The isometric view uses a thin world-anchored grid and local official AWS SVGs, with
Lucide outlines for generic concepts. Startup and watched CDK edits automatically rebuild
an ignored JSON index from linked stack source. Source-inferred edges
have a separate filter and source links, including the resource flow in `referenceExamples`.

Declaration placement uses two framework modes. Isometric omits
badges for entities available in both; Dev (flask), Prod (diamond) and Off
badges identify exceptions. The Inspector shows two environment cards. Development
combines local execution and its AWS-managed workloads; it does not treat these as
separate deployment states.

## Documents

| Document | Read it when |
| --- | --- |
| [Resource baseline (2026-10-20)](resource-baseline-2026-10-20.md) | You are experimenting with resources and need the original application inventory, source revision and scoped restoration procedure |
| [Product audit (2026-10-22)](product-audit-2026-10-22.md) | You need the original persona journeys, reproduced failures and sequenced implementation plan |
| [Implementation and second pass](implementation-second-pass-2026-10-22.md) | You need the implemented changes, regression evidence and remaining live-verification boundaries |
| [Knowledge router](../aws-studio-knowledge/README.md) | You need current source-linked ownership, contracts, verification and selective architecture context |
| [Job 4 performance and developer acceptance](job4-performance-2026-10-23.md) | You need reproducible source, graph, build and runtime measurements and the current campaign verification status |
| [Declarations and tags](declarations-and-tags.md) | You are authoring declaration modules or changing metadata ownership and tag filtering |
| [Network and database declarations](network-database-declarations.md) | You are changing explicit VPC/database ownership, placement or identity-sensitive infrastructure |
| [Database workbench](database-workbench.md) | You are authoring Prisma, comparing migration contracts, planning artifacts or reviewing explicit local/private-task database operations |
| [Report](report.md) | You need the original October 16 investigation and its design rationale |
| [Architecture](architecture.md) | You need detailed implementation context; confirm current contracts through the knowledge router |
| [Isometric view](isometric-view.md) | You are changing the landscape: layout, terrain, buildings, camera, picking or rendering |
| [Inspector interaction system](inspector-design.md) | You are adding or refining inspector sections, forms, disclosures, menus or edit workflows |
| [UI design system](ui-design-system.md) | You are styling a Studio surface or checking shared control, spacing, responsive and keyboard conventions |
| [Lambda invocation design](lambda-invocations-design.md) | You are adding Lambda type conversion, resource-specific event triggers or function creation |
| [Moving forward](moving-forward.md) | You are about to extend the studio: invariants, recipes, gotchas, known limits, the roadmap |
| [Deploy & Run](deploy-and-run.md) | You are working on deployment discovery, planning, deploys, teardown or the local development lifecycle |

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
