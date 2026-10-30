# Repository hygiene and artifact retention

Keep source, reusable tests and useful architectural evidence easy to find. Disposable
output should have a clear owner and destination; directory names alone do not prove
that something is safe to delete.

## Locations and retention

| Material | Location / retention |
| --- | --- |
| Application/framework source, manifests and lockfile | Retain; ordinary feature work owns changes |
| Tests and support fixtures | Existing workspace test directories; retain glob-discovered entrypoints, fixtures and benchmarks |
| Reviewed visual references | `framework-studio/test/browser/*.spec.ts-snapshots/`; tracked inputs, never disposable screenshots |
| Browser fixture fonts and licenses | `framework-studio/test/browser/assets/fonts/`; retain binaries, provenance and licenses |
| Browser results, reports, traces, videos and ad hoc screenshots | Ignored `output/playwright/<task>/`; normal suite owns `output/playwright/studio/` |
| Tool-default browser snapshots | Ignored `.playwright-mcp/` and `.playwright-cli/`; close owned sessions and review contents before removal |
| Other one-off experiment output | Ignored `.framework/artifacts/<task>/` or a task directory outside the checkout; keep it separate from runtime state |
| Durable findings and historical decisions | Existing canonical guides or a concise dated report; a useful small receipt may live in `docs/framework-studio/evidence/` |
| Build outputs and transform caches | Regenerate through the owning workspace command; retain caches used by an active process |
| `.cache/` and `.framework/` | Mixed-use directories: inspect ownership and contents; never blanket-purge |

Private environment files, source recovery journals, saved approvals/plans, deployment
identities, retained-resource evidence, SQL, database files and volumes remain protected.
In particular, retain `.framework/local/`, `.framework/retained-resources/`,
`.cache/deploy/` and Studio's journals/jobs/preferences/private-input stores. A copied
test workspace can contain real or private inputs even when its name starts with
`fixture-` or `creation-`.

Generated files are not interchangeable with build output. The committed framework,
GraphQL and route projections named in [AGENTS.md](../AGENTS.md) are part of the source
contract. Use their generators. The optional frozen Tailwind assets used by
`STUDIO_BROWSER_BASELINE=1` are historical inputs, not a cache of the current app.

## Simple cleanup workflow

1. Record `git status --short`, the revision and `du -sk` measurements. Inventory hidden,
   tracked, untracked and ignored files; do not follow symlinks outside the checkout.
2. Identify each candidate's producer and consumers, including scripts, package globs,
   runtime discovery, Docker contexts, docs and external tool conventions. Classify it
   as disposable, regenerable, archive candidate, manual review or retain.
3. Check the exact target list for environment/data/state files and active writers.
   Close only your own previews/tests; preserve the developer's running services.
   Recheck membership/size/mtime immediately before deletion and stop if it changed.
4. Record useful findings before discarding raw captures. Preserve unique receipts and
   the source/hash provenance needed to interpret them. Remove exact reviewed targets
   with native tools, rather than running a repository-wide clean or cache purge.
5. Check the diff and protected-file fingerprints, regenerate/check with existing tools,
   and run the required [verification gates](aws-studio-knowledge/guides/verification-and-maintenance.md).
   Run cleanup, browser cleanup and the full offline gate sequentially: CDK tests may
   be walking the same filesystem.
6. Record after measurements and remaining review candidates. Leave no cleanup daemon,
   retention scheduler or dependency installation behind.

Ignore rules prevent future additions; they do not remove files already tracked by Git.
Keep permanent fixtures out of output folders. Do not use blanket PNG/JSON/ZIP/test
ignore rules. Raw browser traces and local reports may contain private material, so
review their filenames/metadata without dumping values into audit output. Git history
is retained; removing a tracked artifact from the working tree does not erase old commits.

The [browser guide](../framework-studio/test/browser/README.md) owns screenshot approval
and test behavior. Existing [development guidance](DEV-DEPLOYMENT.md) owns local state
and Docker/image lifecycle; filesystem hygiene does not authorize infrastructure actions.

## October 30, 2026 audit and cleanup

Starting revision: `e4c81f153cb6559a94463cf179d16d130347f6c3`. The working tree was clean:
2,012 Git paths and no untracked files. Measurements include all regular files under
the checkout, including ignored dependencies and `.git`; symlinks were not followed.
Logical bytes and filesystem-reported allocated bytes are recorded separately.

The initial tree contained 291,061 regular files, 8,224,773,155 logical bytes and
9,014,878,208 allocated bytes. Most avoidable volume came from repeated CDK packaging,
raw browser output, old report builds and inactive transforms. Root dependencies and
Git objects were retained. The detailed temporary ledger is under
`/tmp/aws-studio-hygiene-20261030/`; it records the before inventory, exact reviewed
targets, archived receipt hashes and verification results without adding another
generated report tree to the repository.

### Retention decisions

| Classification | Decision |
| --- | --- |
| Safe to remove | Generated browser YAML/screenshots/results/report trees; exact duplicate `docs/assets/framework-sections.zip` after comparing all 16 members |
| Safe to regenerate | Specifically reviewed archived experiment CDK `asset.<hash>` payloads and inactive Vite caches; retain parent templates/manifests/source and private inputs |
| Archive | Unique [UI audit receipt](framework-studio/evidence/aws-studio-audit.json) and [routing verification receipt](framework-studio/evidence/routing-second-pass.txt), moved byte-for-byte out of disposable output |
| Retain | Current architecture/wiki and historical decision reports, all tests/benchmarks, 36 golden PNGs, pinned fonts/licenses, generated source contracts, state, secrets, SQL, root dependencies and Git history |
| Manual review | Mixed Job3/Job4 copied workspaces and archives; interrupted Studio fixtures with private input filenames; large `framework-overview.svg` artwork; operational cache/journal data |
| Active / retain | Studio on port 4590 and its Vite cache; simulated-AWS trees whose call log changed during the pre-delete check |

No permanently obsolete test or application component was established with enough
evidence to remove it. Dynamic icon maps, package/test globs and migration-hash discovery
explain many apparently unreferenced files. Historical reports and tool-specific
`.agents`/`.claude` guidance serve distinct retention/discovery roles and were retained.

### Cleanup performed

The reviewed deletion manifest contained 362 exact targets. Each target's membership,
size and modification time was checked again before removal. The first check detected
an actively growing simulated-AWS call log and stopped before deleting anything; both
simulated-AWS trees were excluded from the final manifest. No developer process was
stopped. All 30 interrupted fixture workspaces containing private-input filenames were
retained as complete workspaces.

| Removed from artifact locations | Regular files | Logical bytes | Tracked files / ignored files |
| --- | ---: | ---: | ---: |
| `.playwright-mcp/`, `.playwright-cli/`, `output/playwright/` | 4,851 | 529,937,700 | 522 / 4,329 |
| Duplicate `docs/assets/framework-sections.zip` | 1 | 10,774,671 | 1 / 0 |
| Inactive Vite caches | 1,024 | 229,159,822 | 0 / 1,024 |
| Historical CDK staging payloads | 54,501 | 2,102,949,279 | 0 / 54,501 |
| Duplicate maintainability campaign output | 2,553 | 333,961,484 | 0 / 2,553 |
| **Total** | **62,930** | **3,206,782,956** | **523 / 62,407** |

Two of the 523 tracked paths were the archived receipts linked above; their contents
remain byte-identical at the new locations. The other 521 tracked files were disposable.
The deletion ledger accounts for 3,350,401,024 allocated bytes. File allocation is not
a guarantee of physical disk space reclaimed on a filesystem using clones or snapshots.

The regenerable payload scope was deliberately narrow:

- Only immediate `asset.<64 lowercase hexadecimal characters>` directories under
  reviewed `.cache/tag-refactor/`, `.cache/rds-implementation/`, and
  `.framework/job4/{build,acceptance}/` historical assembly parents were removed.
  Parent CloudFormation templates, manifests, asset manifests, source and evidence remain;
  those archived assemblies need regeneration before any future use of their bundles.
- Port-specific Studio Vite caches 4591–4596 and 4605, plus copied historical Job4
  Vite caches, were removed. Port 4590's active cache remains.
- In `.framework/artifacts/studio-maintainability-2026-10-30/`, duplicate preview builds,
  generated reports/results, contact sheets, duplicate golden copies and four temporary
  preview configurations were removed. Baseline source copies, patches, hashes, logs
  and compact receipts remain. The frozen Tailwind baseline is separate and remains.

The extracted architecture assets remain in `docs/assets/framework-sections/`; all
16 archive members matched those retained files exactly. No Markdown architecture
report was removed. Existing guide updates now link to this policy instead of repeating
conflicting output-location advice. The two evidence moves are the only retained-file
relocations.

### Measurements

The following measurements were taken immediately before and after the cleanup, before
verification regenerated current build outputs. Categories are disjoint: dependencies
nested inside an artifact directory count as dependencies. Bytes are logical sizes.

| Category | Before files | After files | Before bytes | After bytes |
| --- | ---: | ---: | ---: | ---: |
| Source, configuration and assets | 1,377 | 1,377 | 22,924,358 | 22,926,556 |
| Dependencies | 164,684 | 164,684 | 2,134,829,255 | 2,134,829,255 |
| Build output | 472 | 472 | 10,115,805 | 10,115,805 |
| Root cache and fixture output | 90,474 | 49,675 | 4,113,527,381 | 2,471,574,324 |
| Git metadata | 5,237 | 5,237 | 148,468,069 | 148,468,069 |
| Documentation, including duplicate ZIP and retained evidence | 120 | 122 | 27,995,860 | 17,241,260 |
| Browser tools and output | 4,851 | 0 | 529,937,700 | 0 |
| Historical Job4 output, excluding nested dependencies | 20,291 | 5,565 | 889,917,271 | 201,274,352 |
| Framework artifacts | 3,553 | 1,000 | 346,537,267 | 12,575,783 |
| Framework local state | 1 | 1 | 1,345 | 1,345 |
| Retained-resource state | 1 | 1 | 518,844 | 518,844 |
| **Total** | **291,061** | **228,134** | **8,224,773,155** | **5,019,525,593** |

Allocated size fell from 9,014,878,208 to 5,664,358,400 bytes. All 161 symlinks remained.
Tracked regular files present fell from 2,012 to 1,489; ignored files from 283,812 to
221,405. Three new untracked files are this guide and the two archived receipts. The
Git index still names the original 2,012 paths until the changes are staged. The starting
working tree contained no untracked files, so no untracked user-authored file was deleted.

These are point-in-time measurements. New documentation and receipt locations add files,
and retained active fixture logs continue growing; the exact deletion ledger therefore
differs slightly from the net size reduction. Verification output is accounted for
separately below.

### Retained items requiring owner review

| Path / family | Why it remains |
| --- | --- |
| `.cache/job3*` and copied source/acceptance workspaces under `.framework/job4/` | May explain interrupted work or contain authored source, SQL and private inputs; only reviewed generated children were removed |
| `.framework/job4/acceptance/source-head.tar` and other source archives | Potential recovery material; no assumption that current HEAD supersedes it |
| Studio `creation-*`, `fixture-*`, database-placement and lifecycle fixture roots under `.cache/framework-studio/` | Recursive inspection found private-input filenames in 30 roots; directory names alone cannot establish disposability |
| `.cache/fake-aws-kvGdig/` and `.cache/fake-aws-VTIRCS/` | Active simulated CLI work; retain complete trees, logs and packaged assets |
| `.cache/deploy/`, Studio jobs/transactions/preferences/resource observations, `.framework/local/`, `.framework/retained-resources/` | Operational or recovery state, outside disposable-output cleanup |
| `framework-overview.svg` | Large original artwork without sufficient evidence of obsolescence |
| Frozen Tailwind baseline and historical reports | Unique comparison inputs or architectural decisions, retained intentionally |

Review these with their owner after relevant processes and experiments are closed.
No automatic expiry policy applies to private inputs or operational/recovery state.

### Prevention changes

`.gitignore` now excludes root tool-default `.playwright-mcp/` and `.playwright-cli/`
folders, and standalone Playwright `test-results/`, `playwright-report/` and
`blob-report/` folders. Existing `output/playwright/`, coverage, cache and build ignores
remain. No image, JSON, archive or test-source extension was broadly ignored.

`.dockerignore` now excludes those browser outputs, generated browser gallery output,
coverage and NYC output from repository-root image contexts. The existing Docker-context
regression test exercises CDK's actual ignore strategy and proves application source,
browser specs, golden PNGs, fonts and generated route source remain included.

AGENTS, the documentation index, the browser README and the earlier Studio development
guide point here for retention. Existing tests, configs, fixtures and benchmarks remain
in their established locations. Future work should use task-named ignored output,
record durable findings concisely, close owned sessions, and review exact targets before
removal; no scheduled cleanup service or additional dependency was introduced.

### Verification

| Evidence | Result |
| --- | --- |
| Before-cleanup baseline | Studio/browser typechecks, styling contract (1/1), framework check, wiki (36 pages / 769 links / 251 source references) and repository documentation links passed |
| Docker-context regression | 2/2 passed; disposable output excluded while source/fixtures/goldens remain included |
| Production and browser-gallery builds | Both passed through the existing browser command |
| Focused Chromium light browser run | 3/3 passed: primary destinations/source context, baseline Inspector/reviewed-draft visual comparison, native dialog keyboard focus and accessibility |
| Independent diff review | All tracked removals confined to disposable browser output and duplicate ZIP; receipts unchanged; no application-source changes |
| Full `npm run verify` | In progress; completion receipt pending |

The browser run used the existing sandboxed browser and pinned references, without
updating snapshots or loosening assertions. Its previews/contexts were closed. The two
new report/result files it generated were recorded and removed after the run; normal
workspace/gallery build output remains regenerable. Known large-chunk and `NO_COLOR`
warnings remained visible.

Unit and fixture integration checks run in the offline gate, including mocked CDK and
source-transaction tests. Live database checks, Docker lifecycle/image builds, full
application dev/prod synth and deployed/AWS checks are separate evidence categories;
none were performed or implied by this maintenance task. No dependency was installed,
and no environment, secret, database, cloud resource, Git history or account was changed.
