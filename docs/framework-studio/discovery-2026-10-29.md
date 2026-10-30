# AWS Studio documentation reconstruction — October 29, 2026

This is the evidence and handoff record for the product discovery and documentation
reconstruction. Start with the resulting [product overview](../AWS-STUDIO.md),
[documentation index](../README.md) and [knowledge router](../aws-studio-knowledge/README.md).
This record is dated evidence, not authorization to repeat cloud operations.

## Scope and method

The reviewed baseline was `ffc8a6d` plus the substantial pre-existing working-tree
changes. Those changes include standalone source inputs, source/environment conversion
and client-environment recipes. The documentation describes that checkout, not a claimed
published release. Recent history was inspected over October 15–29; commit subjects
were often just dates, so changed implementation files established the milestones.

Three parallel researchers inspected framework internals, Studio frontend/backend and
deployment/operations. They updated their owned references, then independently reviewed
other authors' documents against source. The primary pass integrated product identity,
vision, architectural decisions, navigation and real browser observations. Existing
historical reports, design documents and unrelated working-tree changes were preserved.

The authored documentation inventory covers root guides, `docs/`, workspace READMEs,
`.agents`/`.claude` procedures and browser guidance. Generated output snapshots are not
treated as authored knowledge. The canonical hierarchy is now product overview → guide
or knowledge router → subsystem contract → source/test owner. Historical plans are
explicitly classified and linked to current guidance.

## Source-backed architectural findings

1. **Studio is a consumer and bounded editor of the framework model.** Normalization,
   source indexing, CDK inference, synthesized inventory and observed deployments are
   complementary evidence. The canvas is not another authoritative configuration.
2. **Native capabilities are the resource abstraction.** Linked native CDK attributes,
   grant methods, triggers and explicit runtime bindings drive consumer wiring. A type
   being discoverable does not imply universal Studio CRUD or local emulation.
3. **The environment model has independent axes.** Source mode, local/cloud execution
   lane, named deployment identity and runtime observations differ. Staging can reuse a
   mode, but there is no independent third mode or promotion pipeline.
4. **Values have different authorities.** Public source values, dotenv inputs, authored
   secrets, native secret handles, exported runtime identifiers and public client recipes
   must not be collapsed into one environment file or graph payload.
5. **Operational review is specific to an effect.** Source save, AWS deployment, secret
   delivery, database application, identity administration, DNS and frontend publication
   do not share one approval or rollback mechanism. Plan preparation may create AWS
   review objects; offline migration planning does not contact the database.
6. **Local/cloud parity is contractual.** Shared IDs, bindings, contracts and workflow IR
   reduce divergent application code. They do not reproduce cloud durability, IAM
   isolation or successful managed-service integration on a laptop.
7. **Identity and data outlive source.** Stable construct/stack/output identities,
   retained-resource evidence, explicit reuse and dependency-aware teardown matter when
   declarations are removed. Source removal does not prove cloud deletion.

The [decision records](../aws-studio-knowledge/architecture/decisions.md) preserve the
reasoning and consequences; the [capability matrix](../aws-studio-knowledge/reference/capabilities.md)
and [status](../aws-studio-knowledge/reference/status.md) separate current support,
bounded journeys and proposals.

## Recent evolution recovered from Git

These are representative source changes, not a complete changelog or assertion that
every related capability first appeared in the named commit.

| Period | Representative commits | Architectural change evidenced by files |
| --- | --- | --- |
| Oct 15–16 | `039003c`, `fe7084c` | Database/network settings, IAM pool/runtime work, scoped local-image reconciliation and early isometric view |
| Oct 17 | `3e7c0e1`, `925e586`, `808e04e` | Deployment identity/discovery/review/teardown, Studio deployment services, job registry and supervision |
| Oct 18–21 | `eadb9ff`, `458f093`, `b135e2e` | Typed trigger adapters, reviewed source creators and explicit network declarations/editing |
| Oct 22 | `4717417`, `488afbb` | Prisma workbench and database operations, connection authoring, generated previews, source recovery journal and local-startup safeguards |
| Oct 23 | `976bee3` | Retained-resource lifecycle, Cognito/domain operations, local SQL and frontend release artifacts |
| Oct 24–26 | `22ec077`, `4371555` | Conditional deployment, managed gateways, selected-mode input dependencies and client mappings |
| Oct 27–28 | `3c53e58`, `bae627f` | Connection routing/benchmark work, shared UI primitives and browser gallery/visual coverage |
| Oct 28–29 | `69dbe22`, `07ea656`, `ffc8a6d` | Declaration-owned inputs/requirements, tag ownership and contextual Inspector navigation |

The existing dirty `resource.value` and client shared-recipe work is current source
evidence, not an additional committed release milestone.

## Browser observations

Playwright MCP interacted with the actual application. Chrome DevTools MCP reproduced
representative pages in its isolated context to inspect console/network behavior.
The existing server on port 4590 was left running. A task-owned loopback instance on
4591 loaded current backend modules after the filesystem sandbox initially refused
port binding; the approved retry succeeded. No application containers were started.

| Surface | Action actually performed | Observed result and limit |
| --- | --- | --- |
| Map | Opened both source modes; used Resources and search, inspected source input/client mappings, opened creation menu and took desktop screenshot | Fresh instance showed 43 resources and 66 connections in this checkout. Multiple VPC islands, subnet terraces, source/client islands and typed connection groups were visible. Counts are fixture observations, not product invariants |
| Empty state | Searched for a deliberately unmatched resource name | Navigator reported zero matches and offered Clear filters |
| Input source | Inspected `enableWebSocketApi`; staged Link to .env file; reviewed and discarded | Fresh backend accepted both graphs and TypeScript and displayed the source diff. No conversion was applied |
| Creation | Opened input creator, chose standalone public value, entered `documentationProbe` / `preview-only`, reviewed and discarded | Review accepted both graphs and showed the input module plus catalog import/registration changes. Apply was not invoked; no probe remained in source |
| Client environment | Opened generated client settings Inspector | Eight symbolic mapping recipes and source-derived Dev/Prod availability were visible; no values were exported and no generated client file was edited |
| Database | Visited Schema, History & migrations, Database status, Saved SQL and Data retention; opened help | Current UI has five subsections. History showed three migration packages and one graph head. Database state stayed explicitly unknown without inspection |
| Invalid Prisma draft | Replaced only browser draft text with an unresolved type, validated, navigated away and discarded | `PSL_UNRESOLVED_REFERENCE` identified line 3. Leaving opened the unsaved-schema guard; Discard and continue reached Cognito. No schema or migration was saved |
| Cognito | Visited User Pools, Identity Pools, Providers and Permissions & RBAC | Source context, unverified AWS metadata and unverified sign-in/effective access remained distinct. No pool inspection or user/group operation was requested |
| Domains | Opened source-intent and diagnostics sections | Production input intent was distinguished from deployed metadata, domain health and DNS writes. No certificate, DNS or health operation was executed |
| WebSockets | Opened local and AWS connection panels | Disconnected message inputs were disabled; no connection or message was sent |
| Deploy | Opened target overview, prerequisites and available review controls | Automatic read-only identity/discovery/status evidence loaded. Docker-stopped and dependency-install freshness warnings were visible. No plan, change set, Apply, teardown, release or local-start action was invoked |
| Keyboard | Enter opened Add menu; Tab advanced from review Back to Editing to Discard All; Escape closed Database help; Tab reached narrow Inspector close control | These specific paths worked. This is not a complete keyboard or accessibility conformance audit |
| Narrow layout | Inspected Deploy and client Inspector at 390 × 844; desktop at 1440 × 1000 | Document width stayed 390; Inspector occupied available width below the map. Main navigation scrolled horizontally. Screenshots were visually inspected; not a complete device matrix |

Chrome DevTools reported no warnings/errors on the inspected fresh Map, Database,
Cognito and Deploy pages. Observed snapshot, source-recovery and deployment GET requests
returned 200. This does not cover every API or guarantee error-free operational flows.
The server printed a Vite HMR-option deprecation warning at startup; source was left
unchanged because the task was documentation-focused.

The older 4590 process rejected a source-input conversion preview with “Select a defined
authored input or secret.” A fresh process accepted the same conversion. Its map also
included client-mapping edges absent from the older process. This supports a stale-backend
explanation; it is not evidence of a current source defect. Restart a task-owned Studio
after backend changes when checking new contracts. Some browser-tool calls encountered
stale references/session resets; those calls were retried and are not credited as product
verification.

Screenshots under ignored `output/playwright/discovery-*.png` are local inspection
artifacts, not canonical docs or a fresh UI regression baseline. They are not required
to understand this record. Raw browser snapshots can contain local operational context
and are not published as knowledge artifacts.

## Documentation delivered and discrepancies corrected

**Created:** the canonical product overview and documentation index; framework
architecture, Studio interface/backend, operational lifecycle, implementation status
and nine reconstructed architectural decisions; this discovery record; reproducible
documentation link and Mermaid checkers. New diagrams explain the whole system,
framework projections and separately approved operational branches.

**Modernized:** root README/AGENTS navigation; framework, development, production,
database, AgentCore and shared-utility guides; resource/configuration/workflow/runtime
references; Studio entrypoints, architecture, editing/creation guidance, inspector-related
context, environment/secret operations and contributor recipes. Existing user edits in
overlapping docs were preserved and extended.

**Consolidated:** product identity and future direction now have explicit canonical
homes. The wiki routes to focused contracts; deep operational and design guides remain
in place. Source authority, evidence limits and approved effects are cross-referenced
instead of treating every representation as equivalent.

**Deprecated as current guidance, preserved as history:** old global source Undo/Redo,
routed Board assumptions, single-VPC descriptions, manual generated-client editing,
environment-only WebSocket toggles, outdated setup/teardown commands, and milestone-era
claims that Inputs/creation/deployment were future-only. Three root prompts, the early
deployment plan and dated campaign reports now point to current documentation. No
historical investigation was deleted.

Other substantive corrections include IAM database connection settings in helper
examples, explicit VPC declarations, generated CloudFront-domain AgentCore routing,
five Database subsections, authored versus native secret handles, source-derived client
availability, and public-subnet migration tasks accessing private databases over IAM/TLS.

## Validation and remaining evidence gaps

The independent passes checked source paths, actual route/service owners, npm-script
references, deployment-parser behavior and environment/security wording. The broad link
checker covers authored Markdown, local anchors and navigation reachability; the wiki
checker additionally validates metadata and source references. Mermaid is parsed using
temporary tooling, without changing repository dependencies or lockfiles. Exact final
check results from the final run:

| Check | Result |
| --- | --- |
| `python3 docs/check-links.py` | Passed: 113 authored Markdown files, 1,419 local links, 58 heading references; all 113 pages reachable from README/AGENTS. The 73 external links were not fetched |
| `node docs/aws-studio-knowledge/check.mjs` | Passed: 36 knowledge pages, 724 local links, 222 source references; all 36 pages reachable |
| `node docs/aws-studio-knowledge/check.mjs --self-test` | Passed: 11 checker regression fixtures |
| `node docs/check-mermaid.mjs <temporary-tooling-directory>` | Mermaid 11.17.2 parsed 10/10 diagrams across 109 non-hidden Markdown files; malformed control rejected. This validates syntax, not renderer layout |
| Independent command/source review | 107 links and 72 npm-script references across 10 guides checked against source/manifests; deployment modes/flags/review expiry and runtime boundaries independently inspected |
| `git diff --check` | Passed |

The Mermaid scan's file count differs from the broader link check because `rg --files`
does not include hidden agent-guidance directories by default; those hidden guides contain
no Mermaid blocks. Reproduction instructions live in
[knowledge maintenance](../aws-studio-knowledge/guides/verification-and-maintenance.md).

No application source was changed by this work. Hash comparison confirmed the 52
pre-existing modified non-documentation files were unchanged during discovery. Source
review/creation and Prisma exercises ended in discard. No source-application, deletion,
database execution, cloud mutation, frontend publication or model-inference success is
claimed.

The following remain unverified by this pass:

- Unit/integration application suites, CDK dev/prod synthesis and logical-ID comparison.
- Docker startup/readiness, local invocation, database initialization/migrations/SQL and
  actual application end-to-end data/auth behavior.
- AWS deployment/apply/teardown/recovery, retained-resource reuse, live identity changes,
  provider sign-in, DNS mutation, frontend publication and AgentCore/model invocation.
- All creator variants, destructive source removal, source recovery after an actual
  interrupted write, a full keyboard/accessibility audit and measured performance.
- External documentation links and AWS service behavior beyond inspected implementation;
  the older external AgentCore reference retains its original verification date.

Per this task's explicit instruction, expensive unrelated application suites and
`npm run verify` were not run for documentation-only changes. That is not a claim that
the existing dirty implementation passes those gates. Future code work still follows
[AGENTS.md](../../AGENTS.md) and the relevant subsystem verification procedure.
