---
id: guides.maintenance
summary: Targeted verification, documentation schema/checks, and contract-driven maintenance.
read_when:
  - Choosing checks or updating architectural knowledge after implementation changes
source:
  - AGENTS.md
  - package.json
  - framework-studio/package.json
  - docs/aws-studio-knowledge/check.mjs
related:
  - reference.invariants
  - reference.capabilities
  - guides.retrieval
---
# Verification and knowledge maintenance

[AGENTS.md](../../../AGENTS.md) owns repository requirements. Run `npm run verify` after changes; it checks committed projections, regenerates ignored database artifacts, checks GraphQL generation, typechecks and runs schema/workspace tests without a live database/AWS. It does not replace synth, browser, Docker or live integrations. Use npm 11 for lock changes and preserve unrelated/deleted user files.

| Change | Focused checks / additional evidence |
| --- | --- |
| Studio fields/transactions/creation | `node --conditions=development --import tsx --test framework-studio/test/plan.test.ts framework-studio/test/transaction.test.ts framework-studio/test/draft.test.ts framework-studio/test/creation.test.ts`; add relevant refusal/rollback fixtures |
| Graph/rendering | Studio model/layout/landscape/labels/hover tests; actual browser resize/zoom/picking and representative timing measurements |
| Workflow/agent | Framework workflow/agent contract, compiler/interpreter tests; runner engine/agent E2E; live service behavior requires separate authorized evidence |
| Infrastructure/resource/identity | Relevant cdk-app/test and framework deploy tests; synth **both explicit dev/prod modes** using [Framework's procedure](../../FRAMEWORK.md#generated-contracts-and-verification), compare logical IDs for identity-sensitive moves |
| Deployment/secret review | Fake AWS/CDK plan/apply/guard/secret-review suites; reject stale/mismatched input before writes. No real deployment just to test a source edit |
| Application data/auth | Follow [data automation](../../playbooks/typed-contract-propagation.md) / [auth checklist](../../playbooks/auth.md). Build client before typecheck for changed routes. Migration planning is offline; application requires separate authorization |
| This wiki | `node docs/aws-studio-knowledge/check.mjs`; checker regression fixtures: `node docs/aws-studio-knowledge/check.mjs --self-test` |

For a documentation-only discovery pass, explicit task instructions may call for targeted
link/source/diagram checks and browser inspection instead of expensive application suites.
Record that scope rather than claiming `verify` passed. Code changes still follow the
repository gates above.

For a single test command run from the repository root, preserve workspace conditions (`--conditions=development --import tsx`). When failures appear in a changing checkout, report the actual failure and working-tree context; don't restore unrelated source to make verification pass.

## Contract-driven updates

1. Decide whether behavior, authority, identity, data flow, capability, enforcement or a public type changed. A private implementation cleanup often needs no wiki edit.
2. Find that contract's canonical page through the [router](../README.md) / [change-impact graph](../reference/change-impact.md).
3. Verify current source/symbols and update only affected facts, dependency links and workflow/extension steps.
4. If support changed, update [capabilities](../reference/capabilities.md); if a guarantee changed, update [invariants](../reference/invariants.md). Keep enforcement and limitations distinct.
5. Run the checker and applicable code checks; rerun the relevant [retrieval route](retrieval-checks.md). Record unverified external behavior without converting it into a guarantee.

Every Markdown page uses restricted YAML-style frontmatter: unique `id`, one-line `summary`, and nonempty `read_when`, `source`, `related` lists. IDs are stable graph identifiers. `source` paths are repository-relative and may name directories. `related` contains IDs; meaningful body links provide navigation. One concept has one canonical home; other pages summarize only enough to link there.

[check.mjs](../check.mjs) uses Node built-ins. It checks the schema, duplicate IDs, related-ID existence, source-path existence/containment, relative inline/reference Markdown links and Markdown heading anchors, and Markdown-page reachability from the router. It ignores fenced examples/external URLs and does not crawl all repository docs. It does **not** prove symbol semantics, evidence accuracy, diagrams, external links, or live integration behavior; source/symbol review remains human/agent work. Prefer simple relative links/ATX headings supported by the checker.

Existing [Studio design documents](../../framework-studio/README.md) retain detailed UI conventions and history; consult [Inspector interaction guidance](../../framework-studio/inspector-design.md) for visual controls. Use the source-linked capability matrix and current implementation to resolve conflicts with historical descriptions; don't propagate old roadmap statements as current behavior.

The wiki was reconstructed against source on 2026-10-29, including pre-existing working-tree changes; the [discovery record](../../framework-studio/discovery-2026-10-29.md) distinguishes current checks from historical evidence. It is a navigational memory, not a frozen compatibility promise. Never read private inputs merely to refresh these docs.

## Repository Markdown link validation

Run `python3 docs/check-links.py` from the repository root, or add `--json` for
machine-readable counts. [check-links.py](../../check-links.py) uses only Python 3.9+
standard-library modules, discovers its checkout from its own location and makes no
network calls. It checks authored Markdown across the repository, including hidden
agent/skill guidance. Dependencies, generated directories, caches, builds and the root
browser-output directory are excluded.

The checker validates local inline and reference links, file/directory existence and
Markdown heading or explicit HTML heading anchors. It ignores fenced examples,
frontmatter and inline code. It reports documents unreachable from the root README
or AGENTS as navigation observations; broken paths/anchors fail the command. External
links are counted but never fetched. Supported Markdown is intentionally bounded:
prefer ordinary relative destinations or angle-bracket destinations for paths with
spaces, rather than complex nested-link syntax or generated renderer-specific anchors.

This complements `node docs/aws-studio-knowledge/check.mjs`, which additionally
validates wiki metadata, related IDs, declared source paths and router reachability.
Neither checker proves command correctness, symbol semantics, external-service
behavior or historical claims; those require independent source review.

## Mermaid syntax validation

[check-mermaid.mjs](../../check-mermaid.mjs) validates repository Markdown diagrams
with the real Mermaid parser in an isolated Node/jsdom process. It leaves repository
dependencies and the lockfile unchanged and does not open a browser or send diagram
content to an external service. Install tooling once into a temporary directory
(network required), then run the check from the repository root:

```sh
mermaid_tools=$(mktemp -d "${TMPDIR:-/tmp}/aws-studio-mermaid.XXXXXX")
npm install --prefix "$mermaid_tools" --cache "$mermaid_tools/cache" --ignore-scripts --no-audit --no-fund mermaid@11.17.2 jsdom@26.1.0
node docs/check-mermaid.mjs "$mermaid_tools"
```

The check itself is offline. It scans the Markdown files returned by `rg --files`
(excluding ignored files and dependencies), checks standard triple-backtick `mermaid`
fences, reports file/line/type and rejects an intentionally malformed control first.
It exits unsuccessfully if a diagram fails or none are found. The 2026-10-29 pass
parsed ten diagrams (nine flowcharts and one sequence) across 109 scanned Markdown
files, including historical proposal/evidence diagrams. Counts can change as documentation grows.

Parsing establishes syntax for the installed version, not readable layout, renderer
compatibility in every Markdown host, or architectural truth. Review edges against
source separately. Historical/proposed diagrams retain their explicit status and
must not be treated as the current implementation. Rendering in an isolated browser
is an additional check when visual layout or export quality matters.
