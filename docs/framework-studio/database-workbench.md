# Database workbench

Open **Database** at `/database` after `npm run studio`. **Schema** combines authored
Prisma source and a navigable diagram. **History & migrations** explains evolution and
prepares migration artifacts. **Database status** reports evidence for an explicitly
selected database. These workspaces share a source proposal without treating a diagram,
folder name or migration marker as another schema authority.

The authored contract is `packages/database/prisma/contract.prisma`.
`packages/database/prisma.config.ts` owns the configured target, source, generated output,
migration directory and terminal connection input. Studio uses the installed Prisma 8
interpreter, serializer, schema differ, planner and migration runner; the application
continues to work through normal Prisma commands without Studio. Package versions remain
pinned and the runtime remains Rust-free.

## Authoring and navigation

The page starts with workspace tabs; the help icon opens guidance on demand.
**Open in editor** sits in the Prisma source pane header. The default split workspace
favors sustained source editing while showing its structure.
Source, split and diagram controls stay in the shared toolbar in every layout. Each pane
has a fullscreen button; Escape or **Exit fullscreen** restores the previous layout and
keyboard focus. Fullscreen keeps source review, validation and layout controls available
without resetting text, undo, diagram zoom or selection. It requires browser fullscreen
support. The Schema tab shows change-impact guidance only for a validated modified draft;
history and database inspection live in their own tabs.

Drag the separator, or focus it and use
Left/Right; Home/End select the supported width limits. Diagram search, focus, zoom and
fit remain independent from the source proposal. Selecting a field or relationship locates
its Prisma range; moving the editor cursor identifies its model, column or relation.
The diagram distinguishes logical model/field names from mapped PostgreSQL tables/columns
and displays keys, indexes, nullability, defaults and referential actions.

CodeMirror provides text selection, indentation, undo/redo, search/replace, multiple
selections, bracket matching, folding and a theme using Studio's light/dark colors.
Ctrl/Cmd+F opens search, Ctrl/Cmd+H opens replacement, Ctrl/Cmd+S opens source review,
Shift+Alt+F formats, and F12 navigates a local definition. Tab indents; Escape then Tab
leaves the editor. Completion and contextual help provide syntax and local-name
suggestions. They are not a semantic language server: cross-project references, semantic
completion and safe rename are unavailable. Use **Open in editor** for those workflows.

Validation is debounced and cancellable, and uses Prisma's configured interpreter on the
exact draft. Diagnostics carry codes and UTF-16 source ranges; selecting a diagnostic
locates it. Formatting uses the installed Prisma formatter and is one editor undo action.
Validation and formatting neither write source nor emit artifacts nor query a database.

Temporarily invalid source remains editable with its selection and undo history intact.
The last valid diagram stays visible with an explicit retained-schema notice; it cannot
be mistaken for the current draft or used for current-source navigation. Valid constructs
outside the diagram's projection remain in source with capability explanations. Source is
never regenerated from a lossy diagram representation.

**Review source changes** validates and presents the complete before/after source.
**Save schema** writes only that reviewed Prisma file after rechecking source and config
revisions and validation. Comments, mappings and unsupported constructs are ordinary
editor text. An external edit preserves the draft and offers loading saved source or
reviewing the draft against the latest baseline. Navigation and browser exit protect
unsaved text. Discard, source undo and database rollback have different effects: editor
undo can recover text during the session; no database rollback is implied.

## What the evidence proves

| Representation | Identity and evidence |
| --- | --- |
| Unsaved draft | Exact editor text, local version and validation source hash |
| Saved authored contract | File-content revision and installed Prisma semantic interpretation |
| Emitted contract and migration graph | Configured generated JSON's observed content revision and verified storage/execution identities, plus independent package hashes, graph edges, refs and semantic snapshots |
| Database migration state | Selected target's observed marker and application ledger, with application timestamps |
| Physical database schema | Prisma strict schema verification against saved storage and, when available, the marker's historical contract |

Draft differences do not imply that saved source changed. Execution defaults can change
with no storage SQL. A saved contract at a graph tip does not establish a database's state.
A matching marker alone does not prove physical compatibility. An observed database may
match a known historical contract and have a pending forward path; a difference from saved
source then has a migration explanation. A mismatch with its verified marker contract is
physical drift within Prisma's modeled surface. Missing/inconsistent markers, incomplete
history, connectivity failures and unsupported inspection remain explicit uncertainty.

Workbench loading separately reads the generated JSON output named by Prisma's actual
configuration. The configured target serializer and canonical storage/execution hashing
check its integrity before comparing it with saved source. The browser receives only
status, safe file label, content revision, observation time and semantic hashes, never
the raw generated contract. Missing, invalid, inaccessible and outside-checkout output
remain distinct from a match. This check neither regenerates files nor proves generated
TypeScript, repositories, GraphQL or frontend consumers are current; their normal
generation/typecheck/test workflow remains necessary.

Every observation records target identity, source/history revisions, baseline and time.
Source, target or history changes invalidate evidence. Superseded asynchronous results
cannot replace a newer draft or another target's observation. Physical-schema compatibility
does not prove data correctness, backfill completion or downstream application compatibility.
Views, triggers, functions and other objects outside Prisma's supported comparison surface
need separate review.

The local target resolves the existing literal Compose PostgreSQL binding and configured
loopback port. Connection values remain server-side. Inspection enforces a read-only
PostgreSQL session and never starts Compose: startup can apply migrations and clean data.
Production RDS inspection/application is deliberately unavailable until a private IAM/TLS
access path is integrated. The Development/Production graph switch never selects a database.

## History and migration planning

History reads metadata, `ops.json`, `migration.ts` as text and content-addressed snapshots
under `packages/database/prisma/migrations/`. Each migration is a graph edge from one
storage hash to another; a null origin means empty storage. Creation time is displayed
separately from database application time. Branches, incomplete packages, invalid metadata,
missing or modified snapshots, modified emitted operations and refs outside known history
stay visible. Browsing never executes migration code or changes refs.

Select an edge to compare its before/after contracts, or compare historical, saved and
valid draft contracts. Prisma's serializer hydrates snapshots before the official schema
tree differ compares physical entities. Domain and execution changes use canonical emitted
contracts, preserving the difference between logical mappings and physical storage.
Snapshots preserve semantic contracts; they do not preserve historical authored Prisma text
or comments. Metadata/operation hash verification also does not prove that edited
`migration.ts` still matches its last self-emitted operations.

To create a migration, save the intended source, choose **Plan migration**, name the
change and explicitly select its intended historical baseline. A graph tip is a navigation
hint. Studio never guesses the newest folder, an abandoned snapshot or an unknown database
origin. An empty baseline is offered for a new migration graph.

Pinned Prisma runs `contract emit` and `migration plan` in a disposable source copy with
private environment inputs excluded. The review contains the actual proposed TypeScript,
metadata, operations and snapshot bytes. A no-op storage plan is a valid result. Required
fields, narrowing changes or data transformations may produce placeholders and incomplete
emitted operations; fill `migration.ts` and self-emit through the supported terminal workflow
before applying. Review drops, constraints and backfills deliberately.

**Save migration package** installs only reviewed new artifacts, with source/config/history
revision checks and exclusive creation. Existing packages are never rewritten. Caught
installation failures remove only unchanged files created by that attempt; concurrent edits
are preserved and reported as unconfirmed. This is compensating restoration, not a durable
multi-file crash transaction. Planning/review is ephemeral and expires after 30 minutes.

Restoring an old design means authoring a new source proposal and an appropriate forward
migration. Previously applied packages remain immutable. Git source history, if consulted
separately, is not Prisma migration or database-application history.

## Deliberate effects and progression

| Action | Reads | Writes |
| --- | --- | --- |
| Validate / format / compare | Draft, saved config and selected semantic baselines | In-memory draft only for formatting; no checkout or database writes |
| Review / save schema | Exact source proposal and file/config revisions | Saving writes only `contract.prisma` |
| Plan migration | Saved source and explicitly selected migration origin | Disposable workspace only |
| Save migration package | Reviewed actual artifact bytes and current source/history identities | New migration/snapshot files only |
| Inspect database | Selected private target, saved contract, marker, ledger and modeled schema | No database or source writes |
| Review database application | Current target evidence and Prisma's canonical pending path | In-memory approval only |
| Apply reviewed migration | Target-bound approved path, source and all package byte checks | Selected local database storage, data transforms, marker and ledger |

The normal progression is edit → validate → review/save source → generate and assess
application artifacts → plan offline → review SQL/data impact → save migration package →
inspect/review the target → explicitly authorize application → inspect the result.
`npm --workspace @repo/database run generate` emits application artifacts separately.
Repository, GraphQL, authorization, writable-field and frontend changes follow the
[data-feature automation contract](../playbooks/typed-contract-propagation.md); Studio
never invents CRUD behavior or automatically exposes a new field.

Local database application requires an intact history, a known marker, a physical schema
matching that marker's historical snapshot and a canonical pending path to saved source.
Review shows the selected packages, SQL and migration source. The approval is single-use,
expires in five minutes, and requires typing **Local PostgreSQL**. Immediately before
execution, Studio rechecks connection identity, source/config/history and migration bytes,
marker, baseline and path. Prisma's runner executes the selected migrations and records
their application; migration code can transform or delete data. No reset, direct schema
synchronization, signing, repair or ref advancement is offered as an automatic recovery.

Source/artifact effects, database execution and refresh are reported separately. An
inspection failure after successful application does not undo it or justify repeating it.
An interrupted/failed execution can leave unconfirmed database effects; inspect and review
the target before retrying. This release's offline suites exercise pinned parsing, diffs
and planning; local live runner behavior requires a deliberately disposable PostgreSQL
integration test and explicit authorization before use against application data.

## Implementation ownership

- `src/database-session.ts` owns draft text/revisions, request generations, conflicts,
  last-valid diagrams and observation acceptance; `PrismaEditor.tsx` owns editor state.
- `server/database-workbench.ts` owns configured Prisma compilation, formatting, fixed
  source review/save, metadata-only emitted-artifact observation and private target
  resolution/read-only database observations.
- `server/database.ts` projects syntax into diagram entities with source ranges.
- `server/database-history.ts` owns tolerant graph/snapshot discovery, canonical semantic
  comparison and disposable, reviewed migration-artifact planning/installation.
- `server/database-application.ts` owns separately reviewed local execution through the
  canonical Prisma path and runner.
- `server/server.ts` exposes the existing loopback/session/same-origin guarded APIs.

Generated application artifacts, Prisma configuration and framework declarations keep their
existing owners. Source-review and application approvals live in memory; restarting Studio
expires them. There is no durable browser-draft recovery or general-purpose SQL console.
