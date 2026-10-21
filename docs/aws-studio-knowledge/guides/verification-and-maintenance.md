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
| Studio fields/transactions/creation | `node --conditions=development --import tsx --test framework-studio/test/plan.test.ts framework-studio/test/transaction.test.ts framework-studio/test/draft.test.ts framework-studio/test/creation.test.ts`; add relevant refusal/undo fixtures |
| Graph/rendering | Studio model/layout/landscape/labels/hover tests; actual browser resize/zoom/picking and representative timing measurements |
| Workflow/agent | Framework workflow/agent contract, compiler/interpreter tests; runner engine/agent E2E; live service behavior requires separate authorized evidence |
| Infrastructure/resource/identity | Relevant cdk-app/test and framework deploy tests; synth **both explicit dev/prod modes** using [Framework's procedure](../../FRAMEWORK.md#generated-contracts-and-verification), compare logical IDs for identity-sensitive moves |
| Deployment/secret review | Fake AWS/CDK plan/apply/guard/secret-review suites; reject stale/mismatched input before writes. No real deployment just to test a source edit |
| Application data/auth | Follow [data automation](../../playbooks/typed-contract-propagation.md) / [auth checklist](../../playbooks/auth.md). Build client before typecheck for changed routes. Migration planning is offline; application requires separate authorization |
| This wiki | `node docs/aws-studio-knowledge/check.mjs`; checker regression fixtures: `node docs/aws-studio-knowledge/check.mjs --self-test` |

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

The initial wiki reflects source inspected on 2026-10-20, including creation/secret-review changes present in the working tree. It is a navigational memory, not a frozen compatibility promise. Never read private inputs merely to refresh these docs.
