# Job 3 Studio browser evidence — October 23, 2026

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

Agent A exercised the real Vite-served Studio with Playwright MCP. These are
source-authoring and live local PostgreSQL observations. AWS deployment,
authentication, effective cloud IAM and frontend publication require separate
evidence; none is implied by these browser results.

## Isolation and ownership

- Application source fixture: `.cache/job3-pass1`, Studio
  `http://127.0.0.1:4593/isometric`. It copied 1,404 current tracked files,
  excluded authored environment files, credentials and account directories, and
  shared installed dependencies through symlinks. Newly authored fixture input
  files contain only campaign deployment names. AWS configuration is an empty
  credential file and synthetic `job3-offline` profile.
- Database source fixture: `.cache/job3-db`, Studio port 4594. The database
  specialist owned its separate Compose project and PostgreSQL loopback port
  15463. Browser SQL targeted that explicitly displayed disposable database.
- Browser sizes: 1440×1000 and 420×900. Ignored raw evidence lives under
  `.cache/job3/studio/`; Playwright also produced timestamped snapshots in
  `.playwright-mcp/`.

## Pass One journeys

| Test | Actual actions and outcome | Evidence |
| --- | --- | --- |
| GUI HTTP creation | Add to application → Function → HTTP, `job3-http`, GET `/job3-http`, authentication enabled, 128 MiB/10 s. Both modes accepted the complete source review. No handler or route existed before Apply. Apply created the authenticated handler, literal route, description and generated target/route artifacts, then selected the new graph entity. | `http-source-review-desktop.png`; fixture `framework-config/workloads/http.ts` and `cdk-app/lambda_functions/http_functions/job3-http/index.ts` |
| Source Undo/Redo | Undo removed the actual handler and route. Redo restored them. The shared checkout declarations were untouched. | Recorded shell checks and browser source-history actions; fixture source journal |
| GUI event creation | Created and applied `job3-event`, 128 MiB/10 s. The starter ignores an optional input and returns a deterministic response. | Fixture `framework-config/workloads/events.ts` and `cdk-app/lambda_functions/event_functions/job3-event/index.ts` |
| GUI bucket creation | Stack wizard created `Job3StorageStack`, `resources.job3Storage.bucket`, descriptor/facade imports and CDK entrypoint registration. Template uses private encrypted S3 with SSL enforced and retention. This is source creation; no bucket was provisioned by this agent. | Fixture `cdk-app/lib/app/job3-storage-stack.ts` |
| GUI scoped connection | HTTP Inspector → Connect workload → Grant bucket access → job3Storage.bucket → Read → `allowed/*` → reviewed Apply produced `grantRead("allowed/*")`. This source relationship does not prove deployed access or exact IAM action scope. | Fixture HTTP declaration |
| GUI event connection | Event Inspector → Triggers → S3 → job3Storage.bucket → object created, `events/` prefix → acknowledge handler/recursion contract → reviewed Apply generated native `trigger.adapter("s3", …)` notification binding. | Fixture event declaration |
| Stale review | Reviewed memory 128→192, then externally appended a concurrent source comment. Watcher preserved the draft and disabled Apply. Back to Editing → Review against latest source → Apply saved memory192 and preserved the comment. A second stale review192→256 was discarded, preserving source192 and both external comments. | `stale-review-blocked-desktop.png`, `stale-review-420.png`, `stale-review-420.json` |
| Narrow review and keyboard | At420×900 the stale review measured x17/y24/width386/height852; document width420. Apply remained disabled; Back/Discard remained available. Escape returned to editing. Add chooser Tab→End focused Authentication provider; Home→Enter opened Function. | `stale-review-420.json`; browser actions |
| Duplicate identifier | Creating another `job3-event` reached server review and refused `id: This workload identifier is already declared.` Apply was disabled; Discard wrote no source. The422 console request was the expected refusal. | `duplicate-name-420.png`, `browser-errors.log` |
| Invalid intermediate TypeScript | Appended `export const invalidIntermediate = ;` only in disposable source. Both modes reported the exact file/line and Unexpected`;`; map retained the last valid graph and explicitly paused editing. Restoring the original bytes recovered valid source. | `invalid-typescript-420.yml` |
| GUI Identity Pool | Cognito → Identity Pools → Create identity pool source → Job3IdentityStack, both graphs → reviewed Apply. Declared identityPool, permissionless default/reader roles and reader group appeared as source, with deployment/sign-in/effective access unverified. Guest/classic flows default disabled. | Fixture `cdk-app/lib/app/job3-identity-stack.ts` |
| Broad permission refusal | Permissions & RBAC → scoped Allow with `s3:*`/`*` → Review refused concrete-action requirement without opening source review or writing a policy. Discard removed draft statements. | `iam-wildcard-refusal-420.yml` |
| Permission evidence language | Saved-policy simulation explicitly says supplied saved source statements differ from deployed role policies, and that it neither signs in, issues credentials, calls target resources nor proves application RBAC. No simulation/AWS request was executed by this agent. | Browser Permissions snapshot |
| Real SQL save/seed | Saved `job3_browser_seed.sql` through review to the fixture's `packages/database/sql/seed/`. Typed execution against Local PostgreSQL15463 committed `job3_browser_row`; exact rerun committed0 rows through authored ON CONFLICT idempotence. | `sql-repeatable-desktop.png` |
| Real SQL failure | A separate saved duplicate INSERT actually returned SQLSTATE23505,0 rows and “no transaction changes committed.” Operation history distinguished failed and committed outcomes. | `sql-constraint-420.png`, `.json`, `.yml` |
| Real PostgreSQL restart/reconnect | Database specialist restarted its verified owned container. Browser saved/read SQL then returned exactly one original row, `matches:"1"`. Operation history retained both seed executions, duplicate failure and read commit. | `sql-after-restart-420.png`, `.yml`; DB specialist restart log |

The HTTP, event, bucket and Identity Pool artifacts were handed to the cloud
specialist as actual GUI-created source. Later cloud fixture minimization,
runtime code and permission changes must be identified separately from those
GUI authoring actions. A generated `grantRead` deserves synthesized-policy
inspection; the GUI label alone does not establish object-only IAM.

## Implemented UX correction and validation

The stale source-review alert previously told developers to discard the draft
even though ordinary typed changes support re-review against current source.
`framework-studio/src/views/EditDialog.tsx` now names Back to Editing → Review
against latest source. Protected catalog/environment drafts retain their distinct
preserve-values/reload instruction. Actual browser failure injection confirmed the
new text and unchanged Apply refusal at420px.

Focused existing draft and draft UI suites passed **83/83**, exit0:
`.cache/job3/studio/draft-regression.log`. This is separate from the lead's final
integrated verify/build/synth gates.

## Remaining friction and boundaries

- After a rejected wildcard policy, Discard local policy edits originally cleared
  statements but retained the previous error alert. The IAM specialist corrected
  the shared source-reset path; independent browser verification is below.
- Bucket/Identity Pool creation requires an additional TypeScript source change
  to express dynamic cross-stack reader-policy references; the Identity wizard's
  optional S3 field accepts a concrete ARN. Source generation remains valid
  without that optional policy, and this browser did not fabricate an ARN.
- SQL category options were not assumed after an unsupported `query` value was
  refused by the browser selector; the saved read remains in `seed/` and executed
  the explicitly reviewed SELECT. No product defect is inferred from that test
  driver mistake.
- No full second-stack pass is claimed here. These browser observations need
  independently reassigned fresh-fixture execution plus actual cloud/runtime
  evidence before the campaign can count two complete full-stack passes.

The database specialist owns Compose cleanup. Agent A closed its Playwright page,
verified PID87985 was the campaign's `node --import tsx
../job3/studio/start.mts`, sent TERM, and confirmed no listener remained on4593.
Source fixtures and ignored evidence are retained for review, not running compute.

## Independent verification of the policy discard repair

After the IAM specialist froze `IdentityPolicyEditor.tsx`, Agent A reused only the
existing disposable source fixture on port4597. Chrome DevTools used the separate
`job3-agent-a-independent` context/page6; no Playwright or other agents' browser
pages were used. The UI was served from the repaired root Vite source.

At measured **1440×1000** and **420×900**, independently repeated actions added an
Allow statement, entered `s3:*` and `*`, and observed the concrete-action refusal.
Discard local policy edits then removed the error, statement and Discard button,
restored the permissionless saved baseline, and disabled source review. Document
width equaled the viewport in both sizes. A before/after SHA256 check confirmed
the generated identity stack source was unchanged. Network inspection showed only
local GET requests, and the console contained no warnings/errors. This tests UI
failure recovery, not deployed IAM or authentication.

Evidence: `.cache/job3/studio/iam-discard-independent.json`,
`iam-discard-independent-snapshot.json`, and
`iam-independent-source-before.sha256`. Chrome's window resize command did not
produce its requested viewport; explicit viewport emulation and DOM measurements
were used for the stated sizes. The tool's direct file-writing path was denied;
public snapshot/evaluation results were instead saved through the repository's
normal filesystem tool.

Read-only examination of the cloud specialist's alternate static client found
two application-fixture prerequisites and reported them before further cloud
browser execution: its protected diagnostic read needed the current ID token,
and synthetic signup needed the pool's required given/family-name attributes.
Those observations are source review, not evidence that either failure occurred
in AWS. The fixture's configured build script/output are framework independent,
and the release service resolves its public environment file under that selected
project. Actual environment generation/publication/authentication outcomes remain
the cloud lead's evidence.

Cleanup: viewport override reset; all Agent A-created Chrome pages closed;
campaign PID27444 was verified as `node --import tsx
../job3/studio/start-4597.mts`, terminated, and port4597 listener absence confirmed.

## Independent live deployed frontend and authentication

After the lead confirmed a completed four-asset publication to the owned
`job3-20261023-p1-1608` destination, Agent A opened
`https://d1qyryfzc52s4b.cloudfront.net/` in a fresh Chrome context. The deployment
uses profile `dev`, account `734849394764`, region `us-east-1`; its isolated target
uses the production framework graph, not the user's production environment.

Actual browser evidence, beyond source generation or mock responses:

- CloudFront served Release one, HTML, CSS, public configuration and JavaScript
  with200 responses. Read before sign-in displayed the sign-in prerequisite.
- Requests to `/api/job3-http` with no token and an intentionally invalid token
  each returned401 Unauthorized.
- Keyboard Tab focused the synthetic-signup action with a visible solid focus
  outline. Enter performed real native Cognito signup and sign-in. Loading text
  changed through Creating a synthetic identity and Signing in; the form cleared
  its password. Same-origin protected GET then returned200 with Ready and the
  synthetic user's original subject.
- Read allowed object invoked the deployed diagnostic Lambda and returned200,
  key `allowed/read.json`, value `job3-synthetic-record`, and its actual Lambda
  ARN. No simulated deployment outputs or S3 response were used.
- At measured1440×1000 and420×900 the document width matched the viewport. The
  narrow main panel measured x16/width388 and remained scrollable vertically.
- One subsequent narrow read actually returned502 TimeoutError under the
  fixture's2.5-second SDK deadline. A single bounded UI retry recovered200.
  Both outcomes are retained; this is not evidence of a consistently successful
  request path.
- An intentionally wrong password produced an actual Cognito400 and a visible
  native-sign-in refusal; the password cleared and submit became available.
  Restoring the same synthetic password only inside browser memory and submitting
  the UI recovered the same user's protected endpoint200.

The synthetic identity is
`job3-browser-b3dea226-6d5d-49c7-8717-ff0c542f2005@example.invalid`, subject
`4498c4a8-50d1-7001-8966-fea3a7eabd38`. The password and issued tokens were never
returned or written to evidence. At the lead's request, its original browser
page remains open with credentials only in memory for a later same-user
retained-pool recovery test. The user remains campaign-owned cleanup work.

Read-only Studio4595 authentication inspection also observed the deployed
Identity Pool `us-east-1:05e1fc57-1c8a-4352-973b-d72ce76196dc`, native pool/client,
guest access disabled and Token role mapping with AmbiguousRoleResolution Deny.
Ongoing source repairs correctly marked that inspection stale. The metadata UI
continues to label sign-in/effective access Unverified; the separate browser
authentication evidence above does not silently update those source claims.

Evidence: `.cache/job3/studio/deployed-client-evidence.json`,
`deployed-client-desktop.jpg`, and `deployed-client-420.jpg`.
Console/network investigation classified the intentionally induced401/400,
the actual transient502, and a missing `favicon.ico`403. No unhandled JavaScript
exception was observed. The fixture retained `role=alert` after successful
recovery; this was reported to the lead for its second asset release, separately
from framework product defects.

## Prepared recovery GUI handoff

At the lead's request Agent A prepared `.cache/job3/recovery1` on Studio4598
(PID15311), with the exact isolated reuse target/account/region guards. The
fixture intentionally has no Cognito reference yet. Unused copied application
modules/tests were archived outside that checkout rather than adding placeholder
resources to satisfy the narrowed catalog. The normal framework generator,
generator check, and post-generation CDK/Lambda typecheck all exited0; both Studio
snapshot modes are valid. This is preparation, not completed recovery.

A read-only call confirmed the original existing app client actually has the
old CloudFront and localhost5173 callback/logout origins, COGNITO provider,
authorization code scopes, and SRP/password flows expected by the recovery shell.
Only its public metadata was saved; no client secret was requested. The original
CloudFront origin is now a source setting preserving that metadata, without
claiming the removed website is recovered.

The lead owns serial discovery/reference source review/Apply and separate cloud
deployment after the original resource is released. The recovery shell contains
no HTTP workload, frontend or Identity Pool; eventual native sign-in with the
original password/sub would prove identity preservation and reference reuse,
separately from full application recovery. Preparation inventory, checks and
ownership are in `.cache/job3/studio/recovery-preparation.json`.

## Independent second asset release verification

After the lead confirmed the second GUI publication and completed invalidation,
Agent A opened a separate same-origin browser page while preserving the original
credentials page. CloudFront served **Release two**, HTTP200, ETag
`W/"2ed38aa12e32ba2f8eb81ccbef6c71be"`. Existing synthetic credentials moved only
between same-origin browser windows, never through tool output or files.

The same original user signed in and received protected GET200. A wrong password
then produced the expected Cognito400 and cleared the new page's local token;
Read displayed its sign-in prerequisite without an API request. Correct
re-authentication recovered200 for the original subject, and the scoped read
returned200 with the expected object. Both successful outputs now use
`role=status`, independently verifying the fixture's stale-alert correction.

At420×900 document width remained420. The actual response's CSP uses
`script-src 'self'` without inline-script permission. Console inspection found
only the deliberately induced authentication400, with no CSP issue or unhandled
JavaScript exception. Evidence: `.cache/job3/studio/deployed-release2-evidence.json`
and `deployed-release2-420.jpg`. The original page remains reserved for the
lead's retained-user recovery test.

After the lead confirmed deployment of the reviewed VPC permission repair,
Agent A independently called same-origin `/api/job3-vpc?operation=read` using
only the current browser-memory token. Actual HTTP200 returned
`allowed/read.json`, `job3-synthetic-record`, and the campaign's VPC Lambda ARN
ending `Job3Vpc506DF439-1Ra6TtXl3CWG`. This proves browser/API/Lambda/S3
application-level communication after the repair, alongside the lead's separate
VPC attachment/routing and allowed/denied role evidence. Raw public response:
`.cache/job3/studio/vpc-http-independent.json`.

During the reviewed original teardown, independent read-only monitoring found
the Synchronous Lambda stack waiting on its VPC function's DELETE_IN_PROGRESS;
its role/policy remained dependencies and three log groups had DELETE_SKIPPED.
One query constrained to the exact campaign VPC/security group found
`eni-0f2d4702004a29c4f`, interface type lambda, in-use, with the actual
`requesterManaged:false` flag. Private IPs were excluded. This observation is
consistent with Lambda interface cleanup; it does not infer a different AWS
management flag. AWS documents that Lambda network-interface cleanup can delay
CloudFormation deletion for up to45 minutes. [AWS cleanup guidance](https://repost.aws/knowledge-center/lambda-delete-cloudformation-stack).
No interface mutation or forced deletion was performed. Recovery source was held
until the original exact Cognito StackId reached DELETE_COMPLETE. Evidence:
`synchronous-teardown-events.json` and `vpc-cleanup-interfaces.json` under the
same ignored Studio evidence directory.

## Actual retained-pool GUI source recovery and reviewed cloud plan

The exact original Cognito StackId ending
`bb75d200-cf20-11f1-a6ea-12ffc042ff79` reached **DELETE_COMPLETE**; AWS reported
DeletionTime `2026-10-23T21:29:12.053Z`. Only then did Agent A copy the original
local retained-resource ledger into the fresh recovery checkout and use its GUI
with profile dev, the exact reuse destination, account734849394764/us-east-1.
The ledger was still its before-teardown observation; Studio correctly described
that historical state as uncertain until live validation. The new destination had
no deployed templates yet, so protection inspection reported that absence while
retained inventory remained available.

Entering the exact original pool/client/deployment and selecting Inspect and
review reference source performed real AWS inspection. Its review confirmed
account/region, explicit physical identity, original framework ownership and
release from CloudFormation. Source SHA256 remained unchanged during review.
Save lifecycle source reinspected AWS and wrote only the reviewed external
reference in `framework-config/stateful-resources.ts`. The original pool, public
app-client and hosted-domain identities were preserved. The Inspector changed to
externally referenced management and explicitly disabled retention changes to
that external resource. At420×900 the source dialog measured x17/width386 and
document width420.

The first GUI deployment comparison then refused the fixture's redundant
CDK_APP_NAME in production inputs, because selected-input override resolution
treated it as the personal deployment name and detected the production-target
collision. Removing that one public fixture input line left target identity in
cdk.json and all other input bytes intact. This correction was a direct fixture
edit; it is not claimed as a GUI input repair or framework product change.

A fresh **GUI template plan succeeded**:
`plan-mvlhn4s4-83b7b6`, saved at
`.cache/job3/recovery1/.cache/framework-studio/plans/job3-20261023-p1-reuse-1645-mvlhn4f8-92d0`.
It adds only one nonsecret SSM reference manifest and CDK telemetry metadata in
the new Cognito reference-shell stack, with0 modifications/removals/secrets and
no IAM broadening. The original pool/client/domain outputs and exact original
callback/logout/provider metadata match live public settings. Its assembly
digest is `6e5ca922b7a0d08e8f1c46d54e495938f294f6f6eb35a32aacbea15b8a15a2e6`.
Agent A left the typed-name field empty and Apply disabled for the lead's exact
packet review; no cloud application is implied by this source/plan success.

Evidence: `.cache/job3/studio/recovery-gui-evidence.json`,
`recovery-reference-review-420.jpg`, original deletion/client-public JSON and the
saved assembly/plan. Actual reference deployment and same-user authentication
remain separate evidence to be appended after the lead verifies them.

## Verified reference deployment and original-user authentication

After the lead independently reviewed that exact saved plan and digest, Agent A
typed the reuse target and selected Apply in Studio. Activity finished **Done**
at `2026-10-23T21:39:53.846Z`; the saved result reports succeeded, identity and
template verified, no deferred stacks and no secret updates. An independent
AWS read confirmed CREATE_COMPLETE for immutable StackId
`arn:aws:cloudformation:us-east-1:734849394764:stack/job3-20261023-p1-reuse-1645-CognitoStack/3e1cd8d0-cf2a-11f1-aea7-0ee21cd397ed`.
Its actual resource inventory contains only the reviewed SSM String reference
manifest and CDK metadata. Outputs identify the original retained pool
`us-east-1_4EDSwlGS5`, public client `3b63v8begmvtg5fhi1spbjmgcc`, original hosted
domain and `external-reference` management. The reference shell does not create
a replacement user pool, app client, API, frontend or Identity Pool.

At `2026-10-23T21:40:21.225Z`, Agent A used the original synthetic user's original
password, still held only in the original browser page's memory, for a fresh
native Cognito USER_PASSWORD_AUTH request. The live service returned HTTP200
and issued tokens retained only in browser memory. The ID-token subject was
exactly the original `4498c4a8-50d1-7001-8966-fea3a7eabd38`; issuer and audience
matched the retained original pool and client. Public evidence returns only
status, token-issued boolean and identity comparisons. No password, ID/access/
refresh token or AWS credential was logged or written to disk. This proves
the retained user's native sign-in and subject preservation after reference
deployment; it does not assert restored application routes, Identity Pool
credentials, group membership, hosted-UI redirects or effective AWS grants.

Evidence: `.cache/job3/studio/recovery-deployed-auth-evidence.json`, the saved
plan's `result.json`, live Studio Activity and the immutable AWS stack/resource
reads. The lead retains ownership of final reference-shell/resource cleanup.

A fresh real Cognito workspace inspection for the reuse target then displayed
the original pool's ACTIVE deletion protection, selected original client,
preserved callback/logout URLs, three confirmed users and the original group
role claim. Its provenance states that pool/client configuration remain
externally managed. The workspace correctly keeps its own sign-in/effective-
access badge Unverified, because metadata inspection does not run authentication.
At420×900 the document width remained420; there were no JavaScript errors and
one DevTools issue about form fields missing id/name attributes.
Evidence: `recovery-external-inspection.json` and
`recovery-external-inspection-420.jpg` in the same ignored evidence directory.

Agent A prepared the normal GUI teardown review for only the immutable reference
StackId above. Saved packet `delete-mvlhxckr-f9c54c5025ad.json` has no blockers,
imports or secrets, and warns explicitly that the external original pool,
users, selected client and domain remain outside its deletion scope. The
review's typed-name field stayed empty and Delete disabled pending the lead's
packet review. This prepares cleanup without asserting it has run.

The lead subsequently reviewed that exact packet/digest and authorized its GUI
typed confirmation. Agent A selected Delete for only the reference shell;
Studio's destroy job `mvli22wn-40682a` completed **succeeded, exit0** at
`2026-10-23T21:46:35.537Z`. An independent read of the immutable StackId confirmed
**DELETE_COMPLETE**, with DeletionTime `2026-10-23T21:46:27.575Z`. A separate
immediate live Cognito read confirmed the original pool still existed with
ACTIVE deletion protection and three users. Reference-shell teardown therefore
left the external pool for the lead's separately scoped retained-resource
cleanup; Agent A performed no direct retained-pool/user deletion.

Public evidence: `.cache/job3/studio/recovery-shell-cleanup-evidence.json`.
Original credential/token memory was cleared after the lead released its
preservation requirement. All campaign browser pages were closed. The owned
Studio4598 process was matched by PID, exact launcher command and listening
port before TERM; a subsequent listener check found port4598 closed. Earlier
owned Studio4593/4597 processes were also stopped after their browser work.

Agent A also independently reviewed the lead's later retained-cleanup guard
adjustment after a read-only preflight stopped on AWS-removed reserved bucket
tags. The frozen campaign script replaces that one reserved-tag requirement
with the original immutable storage StackId's exact logical/physical bucket
identity and DELETE_SKIPPED history, while keeping current framework ownership,
expected account and exact key/version/ETag/size guards. The additional API is
read-only list-stack-resources; no new mutation or prefix selection was added.
Syntax check passed, and the exact recorded deletion/tag evidence supports the
change. Review SHA256 and scope are recorded in
`.cache/job3/studio/retained-cleanup-guard-review.json`. Final retained-resource
cleanup execution remains the lead's separate responsibility.
