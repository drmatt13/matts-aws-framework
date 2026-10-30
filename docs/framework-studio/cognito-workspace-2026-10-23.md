# Cognito workspace engineering report — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

This is Job 1, following the [October 23 campaign](campaign-2026-10-23.md).
The checkout already contained that campaign's uncommitted source, tests and
documentation; this work preserves it. No live infrastructure, Cognito users,
groups, providers, IAM policies, secrets, DNS or databases were mutated.

## Product and component ownership

Cognito is one top-level destination. Its four internal routes expose User Pools,
Identity Pools, Providers and Permissions & RBAC. The nested parent preserves
subsection state and owns the common inspection context. Legacy identity-pool
links remain compatible. Domains continues as a separate production workspace.

Routes are `/cognito` and `/cognito/user-pools`, `/cognito/identity-pools`,
`/cognito/providers`, and `/cognito/permissions`; `/identity-pools` and `/identity`
redirect with history replacement. There is one Cognito entry in the application
bar, with explicit active state and keyboard-focusable internal navigation.

The workspace reuses TanStack Router, React Query, Studio's environment/draft,
Deploy preferences, the existing creator and reviewed source journal, and Studio's
design tokens. It introduces no routing, state or visual framework. User Pools
leads with pool and app-client evidence; federation authoring moves to Providers;
policy editing/simulation lives with permission and role evidence. Backend User
Pool/Identity Pool operations retain their existing separate services.

| Owner | Affected source |
| --- | --- |
| Persistent workspace, context and evidence | `framework-studio/src/views/AuthenticationWorkspace.tsx`, `authentication.css` |
| Routing and navigation guard | `framework-studio/src/main.tsx`, `src/studio.tsx`, `src/views/Shell.tsx` |
| Shared read-only transport; separate domain view | `framework-studio/src/identity-api.ts`, `src/views/IdentityWorkspace.tsx` |
| Policy drafts/simulation; live-operation approval | `framework-studio/src/views/IdentityPolicyEditor.tsx`, `CognitoManagement.tsx` |
| Legacy-domain deployment protection | `scripts/deployment-cognito-domains.ts`, `scripts/deploy.ts`, `cdk-app/deployment.ts` |
| Windows atomic journal replacement | `scripts/atomic-replace.cjs`, its typed contract, `scripts/deployment-artifact.ts`; shared by simulated AWS/CDK transports |
| Failed snapshot recovery | `framework-studio/server/snapshot.ts`, `framework-studio/test/snapshot-recovery.test.ts` |
| Windows generated-file replacement | `packages/framework/scripts/replace-generated-file.ts`, `packages/framework/test/replace-generated-file.test.ts` |
| Source-writer initialization race | `framework-studio/server/edits/journal.ts`, `framework-studio/test/source-lock-race.test.ts` |
| Predictable CDK test scheduling | `cdk-app/package.json`: four file workers, matching Studio |
| Regression fixtures | `framework-studio/test/cognito-workspace-ui.test.ts`, `cdk-app/test/cognito-domain-guard.test.ts`, `cognito-domain-mode.test.ts` |

See the [identity guide](identity-and-domains.md) for the user workflow and the
[authentication knowledge page](../aws-studio-knowledge/studio/authentication.md)
for routing, source authority, evidence distinctions and component owners.

## Domain compatibility finding

Previously development could consume the Cognito custom-domain hostname and
certificate pair. The campaign made these inputs production-only. The native
`CognitoStack` still uses its existing domain construct/logical ID, but development
now synthesizes a generated prefix instead of the custom FQDN and removes
`CustomDomainConfig`. The hostname change can replace the domain and change
hosted-login and federation redirect URLs. Pool/client IDs need not change for
authentication to break. The legacy development custom-domain-only
`UserPoolDomainCloudFrontEndpoint` output also disappears in that proposed
transition. CloudFormation documents `Domain` and `UserPoolId` as
replacement properties; certificate configuration alone is not a replacement.
See the [AWS resource contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooldomain.html).

The default remains production-only. `deploy:resources` compares existing owned
development templates with the exact next assembly after account and stack-ownership
checks. Its direct path refuses template-visible removal, rename or reparenting
of an existing custom domain before reading or writing managed secrets in AWS. It requires a new
saved plan that explicitly describes the authentication consequence and typed
deployment-name approval. Apply repeats the comparison before secret writes and
refuses older reviews that omitted that consequence. This is a wrapper boundary;
using CDK directly bypasses wrapper guarantees. No migration or removal was run.
This comparison does not resolve every intrinsic, physical pool replacement behind
an unchanged reference or drift; ordinary full template/change-set review remains
required.

Historical synthesis restores only the old mode-independent domain resolver in
an isolated shim; the current entrypoint supplies all remaining source. These
identity comparisons skip asset bundling; separate ordinary CLI synths use normal
bundling in both modes. The
3-stack development comparison has exactly one domain-resource change and four
output differences. All resource logical IDs are preserved. The 11-stack
production comparison preserves all template sections/resources/outputs except two
ECS image URI tags. Staged-context inspection shows those tags differ only because
this report and the new UI test changed concurrently between synths; Dockerfile,
platform and runtime/build configuration are identical. The comparator restricts
normalization to those image URI fields. Raw comparisons, staged asset analysis,
ordinary-synthesis scripts and logs are in `.cache/cognito-domain-job1/`.

## Evidence and verification

The verification ledger below records only completed checks. Browser fixtures use
disposable source and simulated AWS where stated; those observations do not prove
live sign-in, token claims, secret access or effective AWS authorization.

| Check | Completed result |
| --- | --- |
| Original full monorepo `npm run verify` | Exited 1 before corrections; failure details and complete affected reruns are recorded below. The original command is not relabeled green. |
| Existing authentication backend regression | 19/19 passed: identity diagnostics, identity policy and Cognito operation service suites; simulated AWS, no cloud writes |
| Complete framework workspace after replacement correction | 480/480 passed; package typecheck passed |
| Final Studio typecheck and production bundle | Passed after the final provider handoff fix; existing bundle advisory for chunks above 500 kB |
| Independent workspace UI regressions | 11/11 passed: internal history/draft retention, guarded mode/exit, context loading, local-policy recovery after source removal, late simulations, stale/failed inspection, and successful/failed provider Apply selection |
| Cognito/domain operation UI regressions | 5/5 passed; existing separate operation approval gates preserved |
| Domain guard/mode regression | 4/4 passed, including the real wrapper against isolated simulated AWS and source fixtures |
| Concurrent guard/mode/existing plan-apply regression | 15/15 passed; new fixture uses separate checkout/cache and retains real lock enforcement |
| Complete CDK workspace after corrections | 237/237 passed, no skips, using `npm --workspace cdk-app test -- --test-concurrency=4`; all test files included |
| Complete affected Studio backend gate after corrections | 69/69 passed, no skips: full transaction, editing-lifecycle, model, snapshot-recovery and source-lock-race files; npm 11 context, two file workers |
| Explicit development and production CLI synth | Passed with normal bundling: 3 development stacks; 11 production stacks with WebSockets enabled; empty credentials, metadata disabled, lookups false, no AWS calls |
| Knowledge links, whitespace, UTF-8 | Job 1's 29-page knowledge check and strict UTF-8/whitespace checks passed; a later global knowledge check encountered an unrelated new orphan page, described below |

Lead's independent Chromium smoke used the actual shared checkout on port 4590 at
1440px and 420px. Both legacy redirects, all subsections, reload, keyboard Enter,
active navigation and browser back/forward worked. Measured viewport/document/body
width at narrow size was 420/420/420; provider tables scroll within their own
region. Source-only pool/app-client/provider empty states did not claim deployment
or successful sign-in. Local screenshots and exact metrics are in
`.cache/job1-cognito-20261023/root-{user-pools-desktop,providers-420}.jpg` and
`root-browser-evidence.json`.
The final Providers editor handoff was also rechecked at 420px against the shared
server; exact href, widths and action label are in `root-providers-final-evidence.json`.

Browser HTTP goes through a Docker-to-host loopback proxy preserving the expected
Host. SSE was stubbed and Vite HMR WebSockets could not cross that proxy; manual
reload was used. The three console errors in this smoke are those HMR connection
failures. This is not live-update transport validation.

Independent browser QA used a separate source project on port 4595:

| Journey | Actual result and evidence boundary |
| --- | --- |
| Beginner authentication setup | Source-only pool was labeled unverified; mock metadata exposed clients/users/groups. OIDC review covered three files, Back retained form values, Cancel wrote nothing, Apply wrote only disposable input/catalog/provider source; exact journal bytes proved Undo restored them. Google setup links to the exact dev/prod input file in the editor, with presence-only evidence. |
| Scoped AWS access | Real Identity Pool source review/apply created its catalog/native stack/entrypoint. Wildcard `s3:*` refused. Narrow Allow plus explicit Deny reviewed/applied only the generated stack; guests stayed false. Subsection/back navigation retained edits; policy Undo restored exact stack bytes and preserved earlier pool creation files. IAM results were explicitly mocked and did not establish runtime access. |
| Experienced inspection | Mock stale metadata and credential errors retained prior observations with destination/time and actionable error. User search survived navigation/back. Production selection used production inputs and did not display development metadata as production evidence. Unsupported native source spreads showed an exact-file handoff, no Review action and unchanged SHA-256. |
| Compatibility | Both legacy routes, all direct routes, history, refresh, heading focus, and 1440/420 layouts passed. Domain replacement/output consequences were independently tested with real offline synths and the real deployment wrapper against simulated AWS. No live migration or domain operation ran. |
| Final OIDC secret handoff | A synthetic stored secret existed in the disposable input file before creation. Real Apply, Undo, Redo and final cleanup Undo all applied successfully and stayed on Providers with no value inspector or resource/environment-details request. All 55 audited API responses, DOM/control values and complete React object-graph scans after Apply/Redo contained no sentinel. Undo restored all three provider source files exactly and preserved earlier identity-pool files. |

The fixture was restored after its invalid-source probe; only its verified port
4595 process was stopped. Shared port 4590 and user drafts were untouched. Detailed
steps, exact fixture source paths, mock/live distinctions and cleanup are in
`.cache/job1-cognito-20261023/independent-browser-qa.md`, with
`browser-user-pools-desktop.jpg` and `browser-providers-420.jpg`. Four console
messages in this fixture were Vite proxy/HMR failures, including Vite's attempted
error-report send; no product application exception was observed.
The final synthetic-secret fixture input was restored and its verified port 4595
listener (PID 36388) was stopped after the final browser probe.
The final request/state audit and exact-Undo results are recorded in
`.cache/job1-cognito-20261023/provider-secret-browser-evidence.json`.

Offline checks initially encountered sandbox child-process `EPERM`; the same
backend suites passed with child-process support. Raw local evidence is under
`.cache/job1-cognito-20261023/` and the isolated QA directories referenced below.
The initial full gate stopped at new QA-test TypeScript errors, which were fixed.
DOM-node equality diagnostics also exhausted the test worker while waiting for
dialog dismissal; compact boolean assertions preserve the same checks and the
workspace suite then passed. One interrupted fake deployment test left its own
dead-PID lock; exact fake-runner calls/time/token were inspected, its record was
archived, and only that lock was explicitly removed. Lock enforcement was not
weakened.

The subsequent consolidated gate reproduced three Windows `EPERM` failures:
replacement of simulated CDK state before the new guard test, and two existing
teardown result-journal replacements. These were actual atomic-rename errors,
not authorization/test-assertion bypasses. A shared helper now retries only the
same rename for Windows `EPERM`/`EACCES`/`EBUSY`, bounded to five seconds, retaining
the old destination until success. It never unlinks the destination or changes
permissions. This retries local file replacement, never an AWS request. Four
injection/integration tests cover preserved bytes, exhausted budget, permanent or
non-Windows errors, and journal temp cleanup. Independent review also verified
an exact 25ms injected budget and original-error identity.
The isolated script-copy filters in `agent-route-preflight.test.ts` and
`deploy-assembly-cleanup.test.ts` now include `.cjs`, so their checkouts carry
the shared atomic helper as well as TypeScript and MJS scripts.

The uncapped default-concurrency CDK run finished 236/237: one existing teardown
journal still exhausted five seconds. On this host Node reports 24 available
processors, allowing 23 file workers by default. The complete rerun at four
workers passed all 237 cases. A diagnostic boundary wrapper observed actual
writable-file rename denials lasting up to 4,038ms before successful replacement;
the teardown journal recovered after 1,978ms. Read-only handle captures did not
identify an owner, so scanner/process attribution is unproven. The five-second
ceiling was retained. The CDK test script now standardizes the proven four-worker
limit, matching Studio; explicit competing-process tests still run. Its effective
Node flags and complete file glob match the passing run, so option placement alone
does not trigger another identical suite. This script-only edit changes no
dependencies or lockfile metadata. Final log:
`.cache/cognito-domain-job1/cdk-workspace-concurrency4-final.log`. An earlier
diagnostic invocation leaked `npm_config_call` into nested npm bundling and failed
with `EUSAGE`; it is an invalid harness run, not a product result.

The earlier complete `npm run verify` command exited 1. Its Studio suite finished
765 passed, 2 failed and 2 skipped: the second HTTP-authorizer toggle reverted,
then the following service-authorizer case encountered stopped evaluators. The
generation/lockfile checks, all workspace typechecks, GraphQL schemas and other
workspace suites passed, including 478 framework tests. Those passing results are
reused; focused replays do not change the failed consolidated command's status.

Fault injection reproduced a snapshot lifecycle defect: failure to replace the
disposable CDK-link projection left the old successful snapshot pointing to
evaluators that refresh had disposed. Refresh now publishes a new revision with
the last successful graph/source explicitly stale/error, disposes the failed
generation and refuses preflight and edit review with a safe diagnostic. Initial
failure still rejects; a successful explicit refresh restores usable evaluators.
Two permanent-I/O regression cases verify old bytes, temporary-file cleanup,
repeated-failure revisions, secret-safe diagnostics, blocked edits and recovery.
This addresses the reproduced lifecycle defect; it does not establish the cause
of every earlier transaction failure whose assertion lacked diagnostics.

A separate disposable preview reproduced a generated-contract replacement
`EPERM` after its existing one-second retry budget. The package-local helper now
uses the same five-second ceiling, retaining its package boundary and the complete
old destination. Four deterministic cases cover recovery, exact deadline, byte
preservation, immediate non-Windows/non-sharing refusal and original-error
identity. No evaluation, generation-process or deployment timeout was increased.

The complete pre-recovery transaction diagnostic replay finished 24/26 passed.
Both originally failing HTTP-authorizer cases passed in that replay. Its route
case instead recorded an exact generated `framework-routes.ts` replacement
`EPERM`; local-replay Redo reverted without an explanatory assertion message.
The final transaction assertions retain bounded model/evaluator diagnostics for
every Apply/Undo/Redo check so a later failure cannot lose that evidence.

The affected lifecycle gate also exposed a real writer race: a second
`SourceJournal.begin` could read the owner's newly created, not-yet-populated
exclusive lock and report it as invalid. A deterministic paused-owner probe
reproduced that result. `begin` now acquires exclusive ownership before reading
pending records. Three regression cases verify refusal during initialization,
preservation of unknown incomplete locks, and removal of only the refusing
attempt's new lock when a prior pending record blocks it. Abandoned-lock recovery
remains explicit; no lock is automatically reclaimed. Both infrastructure and UX
specialists independently reviewed the ordering and recovery overlap.

The final complete affected Studio gate passed all 69 cases, including both
original HTTP-authorizer failures, the complete transaction and lifecycle files,
and all snapshot/lock recovery regressions. It used an npm 11 child harness that
removes only `npm_config_call`, retaining `npm_execpath` for nested generation.
An earlier direct-Node lifecycle invocation lacked that npm context and failed two
creation cases with `spawn npm ENOENT`; those workflows passed in the corrected
complete gate. Final log: `.cache/job1-cognito-20261023/studio-affected-final.tap`.
The original failed monorepo command was not rerun in full: complete affected
gates were rerun, and passing unaffected workspace/schema/generation results were
reused.

During final handoff, concurrent RDS retention/reference work appeared in the
shared checkout (`rds-stack.ts`, `database-lifecycle.ts`, framework database/network
modules and `docs/aws-studio-knowledge/framework/stateful-database.md`, with writes
at 14:40–14:44 UTC). This team did not create or validate that work and left it
untouched. The new page was not linked into the knowledge router, so the later
global knowledge check failed with an orphan-page diagnostic. The earlier passing
Job 1 checks and synth comparisons describe their recorded source state; they do
not establish correctness of these concurrent database changes.

## Independent review and remaining boundaries

Three actual specialist agents own UX/navigation, infrastructure safety, and
independent browser QA; the lead integrates and cross-reviews. The infrastructure
review explicitly challenged old saved-plan approval, secret-write ordering and
parameter/condition-sensitive domain comparisons. UX review challenged late
simulation responses and source revisions that could otherwise appear current.
Resulting fixes also cover changed condition definitions, parameter/mapping-backed
domain evidence, old-plan re-review, inaccessible templates, disabled local-discard
recovery, removed policy sources, declared-account precedence, custom input paths,
and domain code accidentally loaded by authentication transport. The new domain
test was moved to an isolated checkout after review identified a shared test-lock
contention risk.
Final secret-boundary review found that the generic preexisting environment
and resource value inspectors retrieve stored values into component state for
masked display; their payloads are not redacted. The new
Google setup action was changed to an editor-file handoff, so the new Google setup
flow never requests stored values. OIDC creation could also automatically select
its newly declared secret and mount that inspector. Successful provider Apply now
clears automatic selection and keeps Providers open; a failed Apply preserves the
draft and context. The generic creator's source expectations, descriptions and tags
stay intact. Undo/Redo show history outcomes without consuming the returned
selection. The generic value editors were not redesigned in this job.

Live authentication, provider-side setup, secret access, credential issuance and
resource authorization remain outside this offline/source-focused job. Retained
resource recovery and the complete AWS integration campaign remain Jobs 2 and 3.
The shared Studio process was preserved. Restart it with `npm run studio` after
preserving any drafts to load the changed server modules; Vite refresh alone
updates frontend modules. No deployment or database action is required for these
local source changes.
