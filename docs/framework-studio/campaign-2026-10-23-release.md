# Frontend release and deployment identity campaign — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

Owner: release/identity agent. Scope: original families F/G; no AWS mutation, no change to real authored `.env` files. Root owns the Studio process, Docker and cloud experiment. All source-apply GUI work below used `.cache/studio-campaign-20261023/app` on port 4591.

| Initial capability | Status | Current-source evidence |
| --- | --- | --- |
| Public client mappings and dev/prod exporter | Working, with a target-authority defect | `scripts/client-environment-*`, `environment-export.ts`, `resource-export.ts`; existing client mapping tests. Named-target export incorrectly read conventional mode inputs instead of the named target's custom inputs. |
| Env generation without Docker | Partial | Existing complete dev export also required replay/control outputs; no focused public-client-only refresh. |
| Full frontend release in Studio | Missing | Deploy registry/UI had no build, artifact manifest, S3 publication or CloudFront invalidation workflow. |
| Separate deployment identities | Working in core; partial GUI | Core `framework:targets`, CDK_APP_NAME, mode/account/region guards existed. Generic file inspector edited values; Deploy had no reviewed fresh-target flow or preservation explanation. |
| Per-environment target identity continuity | Unverified | Existing synth isolation tests and historical reports were evidence, not a new campaign execution. |

Implementation paths:

- `server/frontend-release.ts`, `frontend-release-routes.ts`, `shared/frontend-release.ts`: target/account/output evidence, public-env export before local build, fresh generated output, exact staged/hash manifest, settings source review, separate typed publication/invalidation gate, confirmed-progress retry, durable outcomes and restart history.
- `src/views/deploy/FrontendRelease.tsx`, `frontend-release.css`, `Deploy.tsx`, `Detail.tsx`: **Client environment & frontend release** and **Development & production deployment names** disclosures inside the selected deployment detail.
- `framework-config/frontend-release.json`: code-owned static frontend project/script/args/output/filter/prefix/delete/invalidation settings. Existing public mapping authority stays `framework-config/client-environment.ts`.
- `server/deployment-identities.ts`, `shared/deployment-identities.ts`: reviewed fresh target keys, pinned account/region, mode-specific input bootstrap and dev default. Existing declared keys are preserved; the previous personal dev default becomes an explicit target so it remains selectable. No existing target/resource rename or adoption.
- `scripts/export-cdk-outputs.mjs`: resolves named target custom inputs and validates pins against deployed metadata; `--client-only`, `--client-env-file`, `--expected-mode` support public frontend refresh without Compose/replay requirements or Docker.

Independent review found a consequential source-safety defect in the first release draft: a configured `outputDirectory: src` could move source aside before running the build. The repaired path rejects reserved source/public/config folders, tracked output files (`git ls-files`), linked paths and existing source/config descendants. It also binds private authored-input bytes by hash, public mapping source and package.json to the review. No raw input values are persisted. Output history now uses atomic fsynced writes; unreadable prior results report unknown effects instead of an empty history. The parent reviewer also requested these outcome/input protections.

| Verification | Observed result |
| --- | --- |
| Focused real-export/release tests | 10/10 passed: public-only dev/prod export uses a custom target input file; no Docker/root env/local manifest writes; alternate Node/HTML frontend script consumes its generated public env; secrets/maps excluded; previous output retained; no-op build refused; exact approval required; artifact/input changes blocked before upload; invalidation failure/retry preserves confirmed uploads and the same idempotency token; corrupt result history reports unknown; source-folder move blocked; forged website output/wrong CloudFront origin refused; old dev/prod identities/comments/secrets preserved. AWS commands use a file-backed fake CLI. |
| Existing TanStack reference | `npm --workspace client-app run build` passed. Existing Vite warning: configLoader native compatibility (extensionless imports/CommonJS) remains. No frontend publication followed. |
| Studio typechecks | Passed after release UI/service implementation and after integrated SQL/identity changes. Parent owns final full `npm run verify`. |
| Complete Deploy UI regression | 15/15 passed from `framework-studio` workspace after adding realistic release endpoint fixtures and an unapplied-settings test. Editing release settings now blocks env/build until source is reviewed/applied, avoiding silent use of old saved settings. A root-cwd test invocation used the wrong JSX configuration and was rerun from the owning workspace. |
| Knowledge links | `node docs/aws-studio-knowledge/check.mjs` passed (28 pages, 550 local links at this checkpoint). |
| Explicit offline dev/prod synth | Baseline fixture and current root each synthesized 5 dev / 11 prod stacks with isolated inputs and asset bundling disabled. Stack names, output IDs/export names and deployment metadata match. Only logical-ID-set difference is the fixture's disposable CampaignEvent Lambda/role/log group, absent current root; preexisting logical IDs remain intact, including historical AsynchronousLambdaFunctionsStack. Evidence: `.cache/studio-campaign-20261023/release-synth/identity-comparison.json` and four logs. No AWS diff/change set was prepared by this agent. |
| Author GUI: settings | Real Chrome → Deploy → release disclosure → project settings → change bucket prefix → Review source → Apply. Inspected actual fixture JSON with campaign-preview/; reviewed/applied restoration to blank prefix. No bucket operation occurred. |
| Author GUI: per-mode names | Real Chrome source review/applied campaign-release-dev and campaign-release-prod in scratch fixture; cdk.json retains my-aws-app-prod and preserves prior personal my-aws-app as dev target. `.env.dev` CDK_APP_NAME changed to campaign-release-dev while RETAIN_STATEFUL_RESOURCES=true and human/template content survived. Missing `.env.prod` initialized from production template, with no competing CDK_APP_NAME. UI explicitly says source saved, infrastructure unchanged. |
| GUI regression during integration | Hot frontend loaded before backend restart initially encountered an old /history response and crashed on `.some`. Hardened response shape handling; latest backend + reload displayed both disclosures and source reviews. |
| Independent security reviews performed | SQL service plus Windows journal change independently reviewed; initial SELECT INTO/schema and linked history-ancestor findings sent to author and corrected. Independent SQL+journal rerun: 11/11 passed. Minimal isolated dev Lambda packet reviewed for parent: three resources, no networking/DB/auth/secret infrastructure; standard broad log managed policy and retained-log cleanup limitations explicitly recorded. |
| Shared event transport review | Parent found multi-tab HTTP/1 connection exhaustion from two SSE subscriptions per Deploy tab. Independently reviewed its refcounted stream hub and listener teardown; 2/2 focused tests passed. One stream per tab preserves snapshot observation on leaving Deploy. Six or more tabs can still occupy the browser's per-origin HTTP/1 connection budget. |

The identity/domains agent independently reviewed the final release and fresh-name services. Its review required actual CloudFormation physical-resource and CloudFront account/origin/config evidence, plus expected-owner enforcement on every upload. These are implemented and regression-tested; S3 also receives the reviewed SHA256 checksum. The reviewer found no remaining source-level blocker. It explicitly did not claim live publication/IAM/network verification.

Official AWS contracts checked during implementation: [CloudFront create-invalidation](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/create-invalidation.html) documents CallerReference retry idempotence; [HeadBucket](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-bucket.html) supports expected bucket owner; [DeleteObject](https://docs.aws.amazon.com/cli/latest/reference/s3api/delete-object.html) supports ETag If-Match for general-purpose buckets. Optional deletion sends the reviewed ETag and expected owner; an old CLI without that flag fails closed after uploads, requiring inspection/review rather than a weakened deletion.

F/G are implemented locally and with isolated integration evidence; actual production release health is unverified. No live client-env export, S3 upload, CloudFront invalidation or deployed website sign-in was performed by this agent. A real destination needs completed website outputs; the reviewed fake-production plan is not a real production approval packet. Read-only STS/output inspection and a separately authorized exact destination are prerequisites to that packet. Invalidating is visibly separate from uploads, and HTTP status is not labeled application/auth health or cache completion.

Limits: static output only; alternative scripts must consume their generated public env file; no arbitrary destination-bucket override; output must be generated/untracked and Git must be available. Fresh targets share conventional per-mode authored inputs unless the developer declares a custom target input path in code. Production identity remains the target key, rather than a misleading `.env.prod` value. Private input edits use the existing staged/compensating file writer and stale hashes; no dotenv values enter a disk source journal. A process crash between files can leave a source-only partial edit requiring inspection, rather than a cross-file crash-atomic guarantee. Old process reviews cannot automatically resume; durable results must be inspected and a new review prepared. Retained previous-output backups consume local disk until deliberately removed. There is no automatic remote rollback/version restore. Tests prove guarded transport behavior against simulated AWS, not live IAM permissions or CloudFront cache completion.

Cleanup: integration-test roots were removed by their fixtures. Author GUI changes remain only in the parent's disposable app for independent replay; no real input files changed. This agent created no AWS resources or charges. Generated TanStack `dist` and ignored synth evidence remain locally. Root owns disposal of the shared campaign fixture/server and any separate run-owned cloud resources.

Independent Pass 2 of B/C used a fresh Chrome tab on the identity agent's isolated
4593 server, without its click sequence. The Identity Pools tab's creator rejected
`arn:aws:s3:::*` with a precise inline error. A corrected fake bucket with `readonly/`
prefix produced a review explicitly separating the permissionless default role from
the reader-group role, restricting the latter to GetObject, denying ambiguous role
claims and disclaiming effective IAM evidence. Applying created a source-reflected
pool/inspector with five public fields. Undo removed only the replay stack, catalog
entry and imports; the author's prior pool remained. Native helper trust/policy tests
were independently rerun with final SQL tests: 12/12 passed.

On Cognito, the fresh replay switched the provider form to SAML, which replaced OIDC
client-secret controls with metadata/SP/ACS instructions. HTTP metadata was rejected
before review. HTTPS fake metadata produced the expected source diff; Apply added
ReplaySAML beside the existing OIDC declaration. The tab labeled metadata acceptance,
deployed state and real sign-in unverified. Undo removed the replay provider while
preserving the prior OIDC source. Both journeys worked at a 420px viewport; measured
document/body width was 420px, with the inspector usable below the content and a
conversation screenshot captured. Viewport was reset afterwards. No provider/AWS
inspection or mutation was invoked, and no fake IdP URL was fetched. These are source
round-trip and UX observations, not proof of live credential issuance or external IdP
authentication. Both independently created replay declarations were cleaned through
the product's Undo operation and their absence confirmed on disk.

Wave 2 closed the remaining C policy authoring/simulation gap. The recognized
native identity-pool helper now accepts bounded ReaderRole Allow/Deny statements
and an explicit permissionless guest opt-in; default authenticated access remains
permissionless, classic auth disabled and aud/amr/group mapping fixed. The editor
replaces legacy bucket/prefix convenience fields with one literal policy authority,
using the existing reviewed native batch, two-mode evaluation, TypeScript preflight,
source journal, stale hashes and Undo. Custom/computed/shadowed helper bindings and
nonconstructor calls refuse with the source path. Authored comments inside removed
convenience settings or replaced policy/guest settings also refuse. Shared native
helper and validator hashes bind both source review and asynchronous simulation.

Focused policy/native tests passed 7/7, shared draft and actual draft UI regression
tests passed 83/83, and Studio/CDK typechecks passed. Native template assertions prove
the exact ReaderRole policies and that default/guest roles have no inline or managed
API policies; guest trust has the pool aud plus unauthenticated amr. The simulator
fixture independently exercises allowed reads, explicit-deny precedence, implicit
write denial, missing-group default no grants, wrong-account refusal, stale revision
and changed helper bytes. The identity/domains agent independently reviewed trust,
validator, native edit authority, comment preservation and asynchronous hashes, and
reran its combined policy/DNS tests (13/13). No source-level widening blocker remained.

Own real Chrome journey on isolated 4593 rejected `s3:*`, reviewed scoped GetObject
and PutObject with an explicit PutObject deny under `protected/`, enabled permissionless
guests, applied source, checked actual stack bytes, then used Undo and Redo. The
saved source reflected in the policy controls; the legacy bucket fields were removed
only in the reviewed native stack. Explicit offline dev/prod fixture synth both passed
with isolated fake inputs and asset bundling disabled; dev emitted the edited
CampaignIdentityStack, while prod respected its development-only registration.
Evidence remains in `.cache/studio-campaign-20261023/policy-synth/`. No real environment
input was changed and no identity-pool deployment was attempted.

Root independently used the GUI's read-only live IAM simulation with profile dev,
account 734849394764, us-east-1 and the saved fixture source. At
2026-10-23T07:10:41.348Z AWS IAM returned GetObject **allowed**, PutObject
**explicitDeny**, DeleteObject **implicitDeny** on
`arn:aws:s3:::campaign-private/tenant/example/protected/example.json`.
Root captured `iam-real-simulation.png`. At 07:11:25.884Z the default-role context
verified STS then explicitly reported `source-empty-policy`, all three implicit denies,
without claiming an IAM simulator call. No resource API operation, credential
issuance or IAM mutation occurred. Boundaries/SCP/session/resource policies, attached
deployment policies, actual group/provider/trust behavior, network access and
application RBAC remain unverified. Root released the fixture for own final Undo;
legacy bucket/prefix and guests-off source were restored and checked on disk.

The two CDK failures from the earlier full verification checkpoint were independently
triaged by rerunning both complete test files: 15/15 passed, including advisory SSM
record persistence and broken-current-source saved-assembly apply/export recovery.
No production guard was changed. Assertions now include apply output or full saved
review evidence on failure, so a recurrence in the integrated run exposes its cause.
The original concurrent-run failure cause was not established by the passing rerun.
