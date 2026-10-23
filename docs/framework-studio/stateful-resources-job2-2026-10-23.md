# Job 2: stateful retention and reference reuse — 2026-10-23

**Handoff status at 12:27 EDT:** implementation and independent review are
finished. The final complete `npm run verify` is still running in the background
at the user's requested report handoff. CDK, framework, database, schema and
typechecks have passed in that run; Studio's complete suite is still in progress
with no failures reported so far. **The final gate is not yet a passing gate.**
Its log is `.cache/job2-verify-6.log`; terminal acceptance remains pending.

This campaign extends the actual dirty checkout, including Job 1's unified Cognito
workspace and domain guard. Existing uncommitted changes were preserved. Four roles
worked concurrently: PostgreSQL/RDS, Cognito, CloudFormation safety, and lead Studio
integration. Specialists independently challenged one another's implementations.
No production action, live AWS deployment/teardown, identity mutation or real-user
operation was authorized or performed. This report distinguishes offline contracts
from operational evidence; Job 3 has not begun.

## Baseline and final architecture

The baseline had shared mode-specific `RETAIN_STATEFUL_RESOURCES`, source-only
Database/Cognito controls, deployed-template teardown review, and advisory retained
inventory. Local volume persistence had prior evidence. RDS was a standalone
PostgreSQL writer with optional replicas/proxy, created only for production; it was
not an Aurora cluster. Primary DB/pool reuse was absent. A retained pool's client,
domain/providers and dependent Lambda infrastructure could disappear. RDS retention
did not guarantee retention of its network and underlying master secret.

`framework-config/stateful-resources.ts` now declares independent resource policies
for development and production. Its empty checked-in defaults preserve legacy
resolution, including context precedence and the historical misspelled context
alias. A resource-specific TypeScript policy deliberately overrides only its own
legacy fallback. CDK consumes the same declaration that Studio reviews.

Supported recovery is **reference of the exact existing physical resource**,
without CloudFormation import. Synthesized saved-assembly metadata records the
descriptor. The normal deployment wrapper revalidates it before secrets or
CloudFormation writes and refuses managed/reference ownership transitions that
would silently discard existing state or create an empty replacement. Source
Save, discovery, deployment, SQL, identity operations and teardown stay separate.

Changed source contracts/components:

| Owner | Source |
| --- | --- |
| Typed application policy | `framework-config/stateful-resources.ts`, `cdk-app/stateful-resources.ts`, deployment resolver and existing CDK entrypoint |
| Database/native networking | `cdk-app/lib/app/database-lifecycle.ts`, `rds-stack.ts`, `lib/framework/framework-network.ts` |
| Cognito/native access | `cognito-lifecycle.ts`, existing `cognito-stack.ts` and `identity-pool-access.ts` |
| CLI ownership and retention | `scripts/stateful-references.ts`, `stateful-reference-locks.ts`, `stateful-teardown.ts`, `retained-resources.ts`, existing deploy/destroy wrappers |
| Studio source/service | `server/stateful-source.ts`, `server/stateful-resources.ts`, shared lifecycle types, fixed server router and existing IdentityService |
| Studio views | Shared `DataRetention` panel, Database, unified AuthenticationWorkspace and Deploy integration |
| Regression fixtures | New lifecycle/reference/adversarial/browser-DOM tests; existing mutation fixtures include the newly required lifecycle module |

No dependency manifests or lockfile were changed by Job 2. Generated artifacts
were checked/regenerated through the repository commands; none were hand-edited.

## Database implementation

Managed retention preserves the writer and its original network, subnet group,
security dependencies and underlying Secrets Manager secret. Logical IDs and
construct scopes remain stable. Retained network services can continue billing.

The reference adapter reuses an available, private, encrypted, IAM-enabled direct
PostgreSQL writer in the same account/region/mode, with the original VPC and all
framework subnet tiers. It uses the immutable DB resource ID for narrow
`rds-db:connect` grants, the retained endpoint/port and existing `app_user`.
It creates no DB, replacement VPC, bootstrap SQL or migration and reads no master
secret contents. Live inspection validates physical ownership/release, network
identity, IPv6/DNS/routes/egress/endpoints, security groups, KMS and secret identity.
Saved-assembly preflight also checks declared network policy compatibility.
Its inspected `masterSecretArn` is public dependency identity evidence, not a
workload secret-delivery binding; no grant or secret value follows from it. The
normal single resource catalog remains authoritative for any actual secret delivery.

Proxy/replica/cluster recovery, subnet migration and credential/schema repair are
outside this first reference strategy. The application must match database name
and PostgreSQL major version. Runtime IAM login existence, connectivity, TLS and
original records require a separate authorized query after supporting deployment.

## Cognito implementation

Managed pool retention now includes its authored app client, domain/providers and
pool invocation permissions, including permissions attached after construction.
An unsafe teardown that would delete a retained pool's declared trigger Lambda is
blocked with a preservation/reconfiguration instruction.
Dependency traversal also guards retained trigger aliases/versions, roles and
policies, invocation permissions, layers, encryption/network dependencies and
known referenced resources. Unresolvable trigger identities fail closed.

Reference mode selects the original pool and an existing public browser client,
preserving pool/client/domain outputs and identities. A small nonsecret SSM
parameter lets the destination own a valid reference-shell stack. No original
Cognito resources are created, imported or reconfigured. Inspector preflight
checks ownership/release, flows/scopes/provider/domain and supported trigger
availability/permissions; deployment compares intended callbacks/logout/providers.

The unified workspace can inspect referenced pool metadata with original ownership
provenance. User/group mutation and generated Identity Pool reconciliation are
refused for external pools. Providers, group/role relationships, custom domain
certificates and triggers remain external responsibilities. Reference metadata
does not prove sign-in, token issuance or effective IAM authorization. Deleted
accounts and passwords cannot be exported/reconstructed through this workflow.

## Inventory, source review and UX

The existing teardown workflow writes exact physical IDs, StackIds, template
digests and dependency evidence before deletion to
`.framework/retained-resources/<account>/<region>/<deployment>.json`, with terminal
success/failure and completed-stack evidence. It survives stack/source removal;
copy it when moving checkouts. It is local evidence, not a distributed claims
registry. Live tags/CloudFormation/reference metadata corroborate ownership;
ambiguous, managed or conflicting resources are refused.
Sorted per-physical-resource locks also serialize different destination names in
this checkout through deploy preparation/application. They do not claim to
coordinate separate machines or checkouts. Conflicting deployed references identify
the actual destination/StackId/status in their error.

Database, Cognito and Deploy expose configured intent separately from actual
deployed-template consequences. Discovery is explicit and read-only. Reference
review requires the exact original deployment/physical resource and, for Cognito,
existing client ID. Save uses a literal AST edit, fixed source authority, shared
source lock and durable source journal. It preserves unrelated comments/bytes;
unsupported source patterns require editing source directly. Approval binds
inputs, declaration hashes, target declarations and inspector code; it expires and
repeats AWS compatibility inspection before source application. No arbitrary
browser-supplied descriptor is accepted.

The same inspector is available with `npx tsx scripts/stateful-references.ts list`
and `inspect`; normal framework deploy plan/apply remains the only deployment path.
See [the lifecycle guide](stateful-resources.md), [database contracts](../DATABASE.md)
and [Cognito recovery](cognito-lifecycle.md) for source examples and exact boundaries.

## Verification evidence

| Evidence | Result |
| --- | --- |
| Disposable real PostgreSQL persistence/reconnect | Passed: actual framework `databaseConnection()` query, row preserved through stop/start and container deletion/recreation with the same named volume; incompatible-column SQLSTATE checked; only fixture volume removed and absence verified |
| Docker test invocation | `$env:FRAMEWORK_DATABASE_PERSISTENCE = 'job2-disposable'; node --import tsx --test cdk-app/test/database-local-persistence.test.ts`; Docker 29.2.1, cached `postgres:16`, random labeled `matts-job2-postgres-<hex>` resources |
| Source review/identity failure injection | Passed targeted local fixtures: per-resource/mode legacy fallback, zero writes on review/cancel, expired approval, changed inputs/declarations/inspection code, wrong pinned account, reinspection mismatch, malformed/comment-sensitive source |
| Studio UI regression | Passed targeted 28/28 across lifecycle, Cognito navigation/context and deployment review; run from the Studio workspace so tsx uses React JSX configuration |
| Studio production build/typechecks | Passed; existing bundle size warning remains |
| Database/CDK lifecycle and independent AWS-shaped mocks | Passed targeted dependency-retention, immutable ID/IAM, reference-without-create, broken IPv6/subnets/SG/KMS/ownership and interrupted-evidence cases |
| Cognito/CDK and identity service | Passed targeted retention, external provenance, duplicate/mutation refusal, late trigger permission and existing operation regressions |
| Development/production synth and identity comparison | Passed normal bundled explicit CLI synths; 3 dev stacks/33 application resources/23 outputs and 9 prod stacks/220 application resources/65 outputs; no changed historical stack names, logical IDs/types, existing outputs or export names |
| Real browser desktop/narrow workflows | Passed independent disposable fixture at 1920×945 and 420×900; source cancel/save, four independent policies, missing/invalid client and credential refusals; exact evidence appended below |
| Final `npm run verify` | **Running at 12:27 EDT**, `.cache/job2-verify-6.log`: typechecks passed; schema 22/22, local API 16/16, invocation 27/27, CDK 269 passed/0 failed/1 opt-in skip, database 28/28, framework 480/480. Studio incomplete, no failures reported so far. Acceptance pending terminal exit; targeted results do not substitute for this gate. |
| Live RDS/Cognito recovery | Not executed; no resource-specific AWS mutation packet was authorized |

An initial root-directory UI test invocation used the wrong tsx JSX configuration
and failed before rendering. The identical affected suites passed from the proper
Studio workspace. Sandbox worker-spawn failures were rerun with approved local
execution; they are not counted as passing test execution.

The first integrated `npm run verify` failed during consumer typechecking because
the new Cognito descriptor guard used `Object.hasOwn`, unavailable in one consumer's
ES2020 library target. It was corrected to `Object.prototype.hasOwnProperty.call`;
the complete gate is rerun after integration rather than treating narrower replays
as a passing final gate. The initial failed log is `.cache/job2-verify.log`.

The next integrated run exposed two actual source-projection failures: Cognito
outputs moved outside their owning class were invisible to Studio. Moving the
publisher into a private stack method restored the exact original output source
contract; affected client-environment/export tests passed 7/7 and current reference
composition/lifecycle tests passed 8/8. Existing creation/edit fixtures also needed
to copy the new `cdk-app/stateful-resources.ts` dependency; their missing module
correctly made typechecked reviews fail. The focused complete function creation,
apply, conflict, undo and redo replay passed after the fixture correction.
The superseded failing process was explicitly stopped to avoid running duplicate
full suites. Its log remains `.cache/job2-verify-final.log`; it is not a passing
gate.

The next complete run, `.cache/job2-verify-complete.log`, finished with 17 Studio
failures: 14 Database UI setup failures from a stylesheet imported directly by a
Node-rendered component, and three trigger-authoring cases from the newly honest
`IUserPool` public interface being treated as immutable even for a native managed
pool. The stylesheet now loads through Studio's existing entrypoint (affected
Database/lifecycle UI suites: 16/16). Capability discovery now recognizes a
canonical native constructor initializer while blocking the application pool when
either lifecycle mode selects an external reference or ownership is unresolved.
The lifecycle source hash participates in cache invalidation. These corrections
preserve the original UI assertions and external-pool mutation guards. That run's
CDK result was 269 passed/0 failed/1 skipped, framework 480 passed, and Studio
773 passed/17 failed/2 skipped. It is not counted as a passing gate.
The complete affected trigger UI replay passed 62/62. Final review also corrected
duplicate symbolic RDS endpoint outputs by using one owning-class publisher and
kept the code-only Cognito trigger helper compatible with `IUserPool` while retaining
its native ownership guard. Independent review then caught a custom-stack proof
edge: a nested imported assignment followed by a native branch could overstate
mutable ownership in metadata. Runtime attachment still refused the imported
handle. The initial fresh run `.cache/job2-verify-4.log` was stopped early before
applying the conservative source-proof correction; it is not a passing gate.
The correction refuses ambiguous direct, conditional, computed and helper writes;
the known application branch additionally requires its parsed managed policy and
exact early-return import guard. Focused UI/proof replay passed 4/4, Studio
typechecks passed, and an independent semantic/runtime adapter replay passed 6/6.
Both other specialists approved the stable implementation. Native runtime ownership
checks remain mandatory; static capability discovery does not authorize mutation.
Run `.cache/job2-verify-5.log` then hit five CDK deployment-plan test failures:
the deliberately conservative deployment lock from the stopped fourth run still
belonged to its dead fake runner. No live AWS action occurred. That run's CDK
footer was 264 passed/5 failed/1 skipped; framework 480 passed. It was stopped
before the remaining Studio tests completed. Only proven campaign-owned dead
test locks were recovered before replaying the affected deployment tests.
Recovery evidence and original lock bytes are archived under
`.cache/job2-lock-recovery/`: both dead PIDs were corroborated by OS lookup and
Node `ESRCH`, operation timestamps and the exact fake-account plan/job records.
The product's fail-closed lock behavior was preserved; no general stale-lock
cleanup or source change was introduced.
The complete affected deployment-plan/apply replay then passed **11/11**, exit 0
(`.cache/job2-plan-apply-replay-recovered-locks.log`); the shared lock directory
was verified empty before the final gate began.
It is not a passing gate. The final frozen-source run is
`.cache/job2-verify-6.log`.

Final normal-bundled explicit synth logs and identity comparison are in
`.cache/job2-lifecycle-final/{dev,prod}.log` and
`identity-comparison.json`, compared against `.cache/job2-lifecycle-baseline`.
The CLI's added `AWS::CDK::Metadata` telemetry was explicitly excluded from the
direct-entrypoint baseline comparison. Actual construct paths were compared from
`tree.json` keyed by CloudFormation logical ID, avoiding a template metadata
presence difference between entry methods. Stack names/environments, logical
IDs/types, actual construct paths, full existing outputs and export names are
unchanged in both modes. Separate actual-entrypoint reference tests
prove no replacement Cognito/RDS/network resources, original IDs/endpoints in real
Lambda environments, narrow immutable-ID database IAM grants and selected-SG ingress.

## Independent findings and corrections

Cross-review found and corrected: the master secret's underlying resource retaining
Delete; reverse network dependency traversal missing routes/NAT/EIP/gateway chains;
pool invocation permissions added after constructor retention; output-only Cognito
reference templates; missing destination account pins; insufficient callback/provider
compatibility checks; unprotected reference ownership transitions; malformed source
and comment loss; source review dependencies missing `cdk.json`/validator bytes;
nested inspector evidence not rendering; historical inventory observations winning
over the latest evidence; and reference-only policies implying management authority.
Regression fixtures cover the corrected contracts. Real browser findings and final
gate results are appended when verified.

## Job 3 handoff

First confirm the terminal result of `.cache/job2-verify-6.log`. This report was
delivered before that full run finished at the user's request. A failing or
interrupted run does not satisfy the final gate; fix any actual failures and rerun
the complete gate before treating Job 2 as fully verified. No Job 3 execution has
been started.

Start with the lifecycle guide and the executable fixtures:

- `cdk-app/test/database-local-persistence.test.ts` for campaign-owned local data;
- `database-lifecycle.test.ts`, `database-reference-inspection.test.ts`,
  `stateful-retention.test.ts`, `stateful-references.test.ts` and
  `stateful-adversarial.test.ts` under `cdk-app/test/` for lifecycle/failure contracts;
- `cdk-app/test/cognito-lifecycle.test.ts` and Studio
  `cognito-reference-observation.test.ts` for original pool/client provenance;
- Studio `stateful-resources.test.ts` and `stateful-resources-ui.test.ts` for source
  reviews, invalidated approvals and explicit reference prerequisites.

Before live proof, authorize a packet with exact account/profile/region, resource
IDs/ownership, permitted writes, cost/lifetime, dependencies and cleanup. Test a
disposable retained writer plus its original network and a disposable pool/client
with campaign-owned users. After a reviewed teardown and new reference deployment,
query the original test records and verify the original User Pool ID/user subject,
real OAuth callback/logout/provider sign-in and intended scoped Identity Pool
access. Exercise failed dependency restoration without automatic repair/retry.
No deletion or production action is implied by this report.

## Independent browser and local PostgreSQL acceptance

Agent A used the real connected Chrome browser against an isolated source fixture
at `.cache/job2-browser/app`, served at `http://127.0.0.1:4592`. The original Studio
on port 4590 and the shared checkout's inputs/data were untouched. The fixture copied
tracked/current source, excluded authored environment files, credentials, `.aws`,
`.git`, `.agents` and `.codex`, and shared only the installed dependency folders.
Its AWS configuration used a synthetic named profile and an empty credentials file;
the server removed inherited AWS credential variables. Its two input files contained
only fixture deployment naming and public retention booleans.

The desktop viewport measured **1920 × 945**. Actual browser actions verified:

- Database → Data retention loads inherited dev retain and prod remove separately,
  names the TypeScript/input sources, and explains that AWS policy does not control
  the local PostgreSQL volume.
- Selecting dev Database remove opens an exact source diff. Cancel left the fixture
  source unchanged; re-review and Save updated only the lifecycle TypeScript source.
- Four separate reviewed saves produced dev Database remove/Cognito retain and prod
  Database retain/Cognito remove. The final fixture source contains all four policies;
  both fixture `.env` files retained their original bytes.
- Cognito → User Pools → Retention and retained pool reuse is reachable within the
  unified authentication workspace. Its environment/profile/deployment follow the
  Cognito workspace selection, and deployed protection remains explicitly unverified.
- A missing existing app-client ID disables reference inspection. An invalid client
  ID displays `Choose an exact retained resource ID and original deployment; Cognito
  also requires its existing app client ID.` No reference proposal/source write occurs.
- With syntactically valid fixture IDs and empty credentials, inspection fails with
  the existing AWS session/credential recovery message. It opens no review and writes
  no reference. This is a credential refusal boundary, not evidence of AWS recovery.

The browser viewport capability then measured **420 × 900**. Database and Cognito
retention/reuse both kept document width at **420**; the lifecycle content measured
**347** pixels wide. The narrow Database review dialog fit at x=17…403, width=386,
y=87.3125…812.6875, with its source diff and cancel/save actions available. The narrow
review was cancelled and the original four-policy source remained intact. One CUA
pointer activation of a horizontally scrolling tab selected the neighboring tab;
keyboard activation selected Data retention correctly. Pointer behavior at that
specific browser-emulation boundary is therefore not claimed as verified. The
temporary viewport override was reset after testing.

Named JPEG evidence is preserved locally under `.cache/job2-browser/evidence/`:

- `database-policy-desktop.jpg`
- `database-review-420.jpg`
- `cognito-prerequisites-desktop.jpg`
- `cognito-reference-420.jpg`

`evidence.json` records the fixture, measured bounds, source-policy matrix, failure
boundaries and screenshot names. These ignored artifacts are local campaign evidence,
not published screenshots or proof of any deployed AWS state.

After the final source freeze, the lead rechecked the original port 4590 server:
its repository matched this checkout, no command/job/evaluation was running, no
source recovery was pending, and its source-edit history was empty. Only that
verified idle process tree was restarted to load the new server routes. The live
local `/api/stateful-resources/source?mode=dev` endpoint returned the canonical
source with no problems, and both snapshot models reported `ok`. Refresh an
already-open Studio browser to acquire the restarted server's session.

Agent A then independently checked the final Vite-served source on port 4590
without saving policy or invoking AWS inspection. Database and Cognito cards both
resolved the intended solid 1px `--rule` border and 8px radius. At desktop
1920×945 and narrow 420×900 the lifecycle UI loaded correctly; both narrow pages
kept document width at 420px, and the browser console error list was empty.
The temporary viewport and QA tab were cleaned up. Final-source evidence lives in
the same directory as `final-{database,cognito}-{desktop,420}.jpg` and
`final-css-evidence.json`. These are final Vite source captures, not `dist` hosting.

The real PostgreSQL test was additionally strengthened and rerun after review:

```powershell
$env:FRAMEWORK_DATABASE_PERSISTENCE = 'job2-disposable'
node --import tsx --test cdk-app/test/database-local-persistence.test.ts
```

Result: **1 passed, 0 failed**, approximately 10.5 seconds, Docker Engine 29.2.1 and
cached `postgres:16`. Besides stop/start and full container recreation with its same
random labelled volume, the test now proves wrong-password rejection with SQLSTATE
`28P01`, verifies the original row afterward, rejects incompatible-column SQLSTATE
`42703`, and checks missing-volume and failed-connection behavior. Only this test's
owned container and volume were removed. The test file was frozen after this passing
run for the root consolidated verification gate.

Agent C's final cross-review also found the unused RDS/VPC reference shell could
emit an output-only template when no workload requested a connection. Reference
mode now creates one non-secret SSM identity parameter in each of those stacks;
it still creates no database, VPC, subnet, password or SQL bootstrap. The focused
`database-lifecycle.test.ts` rerun passed **4/4**, including a fresh no-consumer
composition that verifies both templates contain owned resources. Managed creation
branches and their historical construct scopes are unchanged. Database product/test
files were frozen after this correction for the final consolidated gate.
