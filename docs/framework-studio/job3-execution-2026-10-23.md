# Job 3 integration and adversarial execution — 2026-10-23

Two independent application journeys completed through GUI authoring, real local
execution and PostgreSQL, disposable AWS deployment, actual authentication/IAM/
VPC/event requests, client publication, retained native identity reuse and verified
cleanup. The final integrated gate passed **1,727 tests, 3 intentional skips,
0 failures**. Production was previewed only. Code-first work, manual ENI cleanup
and unexecuted production capabilities are distinguished below.

## A. Product status and evidence method

Studio was used to create and review application declarations, apply source,
connect permissions and events, execute saved SQL, deploy real CloudFormation
stacks, generate public client environment files, publish a frontend, discover a
retained native pool, deploy a reference shell and tear down owned stacks.
Actual AWS requests prove native authentication, temporary Identity Pool
credentials, scoped allowed/denied S3 access, event delivery and VPC application
communication. PostgreSQL, migrations and workflow execution were exercised in
real Docker containers. Cloud RDS was not provisioned.

Four simultaneous agent slots were available. The lead combined deployment and
release coordination; the Studio specialist combined developer experience and
adversarial browser QA; the IAM specialist combined authorization and AWS runtime;
the database specialist owned persistence and then independently developed Pass
Two. These were real delegated agents, with separate fixtures and source leases.
The second developer did not implement Pass One's Studio or cloud fixture.

Baseline inspection included repository instructions, framework/auth/data/feature
and knowledge guides, current source and the Job 1/2 handoffs. Historical failures
were not relabeled as successful current checks. Job 2's historical referenced
complete verification log was unavailable; fresh checks provide current evidence.
The original checkout's unrelated changes were preserved. In particular,
`framework-config/networks/test/index.ts` was changed by a concurrent original
Studio transaction, not by this campaign; it remains untouched by Job 3 cleanup.
No commit, push or merge was performed.

Evidence classifications are kept separate: **browser**, **local runtime**, **live
AWS**, **source/synth**, and **injected/unit**. GUI-created declarations are not
presented as GUI-written business handlers. Both applications required explicit
code-first handlers, minimal native composition, event instrumentation and
retention of dependent authentication resources. No generated artifact was
hand-edited to make the journey pass.

Specialist records:

- [Studio and independent browser evidence](job3-studio-evidence-2026-10-23.md).
- [IAM/runtime source contracts and resource inventories](job3-iam-runtime-evidence-2026-10-23.md).
- [Real Docker/PostgreSQL and workflow evidence](job3-database-evidence-2026-10-23.md).
- [Fresh independent second application](job3-independent-pass2-2026-10-23.md).

Detailed public receipts, source fixtures and complete logs are in ignored
`.cache/job3/`. Passwords, JWTs and temporary AWS credentials are excluded from
this report and its evidence excerpts. Pass Two briefly used protected temporary
password files; those files were removed before recovery, and the required
original login was held only in process memory for recovery, then cleared when
that owned process stopped. This is not a claim that every
synthetic password existed exclusively in memory throughout the campaign.

## B. Two-pass test and evidence register

| Test / owner | Pass One observation and repair | Independent Pass Two observation | Final boundary / principal evidence |
| --- | --- | --- | --- |
| GUI/source — Studio, reviewed by lead | Actual HTTP/event/bucket/Identity Pool creation; invalid/duplicate/stale drafts rejected; review/Apply/Undo/Redo; preserved draft guidance improved | Fresh receipt app created through GUI, distinct route/event/prefixes, both graphs accepted | Browser and actual saved TypeScript; `.cache/job3/studio/`, `database/p2-authored/` |
| Local API/workflow — lead/database | Actual HTTP → declared workflow → child event → PostgreSQL; auth 401, caller 403, badJSON 400, SQL rollback, missing runner 503 and restart recovery | Separate real API runner: health 200, auth 401, wrong method 404, undeclared route 404; separate fresh PostgreSQL | Live Docker, not Compose parsing; workflow journal intentionally in memory |
| SQL/persistence — database, independent browser | GUI saved seed inserts 1 then 0; unique 23505 rolls back; container restart and replacement preserve rows and seed ledger | Fresh schema initialization; seed 1 then 0, FK 23503 rollback, corrected commit, same-volume replacement preserves joined rows | Local PostgreSQL only; `.cache/job3/database/` |
| Initial deployment — lead / independent developer | Eight new stacks, 120 resources; actual completed CloudFormation and physical inventory | Exact approved eight-stack plan, 104 resources; all completed; health probe later increases total to 110 | Live AWS; distinct namespaces and immutable StackIds |
| Authentication — IAM/lead/browser | Native signup/sign-in, protected API 200, invalid/missing 401 | Unconfirmed signup exposed missing skip-email binding; reviewed repair; confirmed native auth; missing/invalid 401 | No external federation claim; native pool/client evidence |
| Narrow IAM — IAM/lead | Actual role/identity read 200; explicit write Deny 403, implicit delete/unrelated 403; GUI wrong-prefix repair → VPC read 200 | Reader credentials: processed Get 200; Put/Delete/unrelated 403; missing HTTP Put grant 403 after network repair; reviewed uploads-prefix repair → upload 202/event/read 200 | Actual AWS requests, not simulator-only; principal and prefixes below |
| Network — IAM/lead / independent developer | Isolated Lambda attachment; S3 endpoint communication; public STS times out while non-VPC control succeeds | Isolated authenticated HTTP initially 503 JWKS timeout; moved HTTP outside VPC, event inside. Native detach failed 400; factory fixed; real existing detach and new health creation succeeded | Distinguish attachment, network reachability and application success |
| Event — lead / independent developer | Actual S3 → EventBridge → Lambda, exact event key/account/request ID | Admin-seeded network canary triggered isolated event and processed-object Get 200; post-repair authenticated app upload 202 → isolated event → processed read 200 | P1 collector needed JSON-string parsing repair; no fake re-upload |
| Frontend — lead/browser / independent developer | Real outputs → env → alternate build → two actual publications; invalidations Completed; browser native auth/API/scoped read 200 | Real outputs and build; stale review refused with zero uploads after actual new outputs; fresh 2-file publication/Completed invalidation/native browser upload 202/read 200 | Existing TanStack reference built locally, not deployed as the actual client |
| Retention/reference — lead/Studio / independent developer | Original Cognito deleted → GUI retained inspection/reference; original user/Identity credentials read original S3 data after all 8 originals deleted | Fresh GUI reference shell; after all 8 originals deleted, original password/subject and fresh Identity credentials read original S3 data; three denials and unchanged reread verified | External reference is not CFN import, snapshot restore or whole-app recovery |
| Cleanup — lead / independent developer | All original and reference stacks deleted; exact retained resources and physical service absence verified | Local resources, original/reference stacks and exact retained resources removed; independent physical absence checks passed | Native terminal outcomes and service absence required |

Independent review was split deliberately: the lead reviewed Studio source and
all saved cloud operation packets; IAM reviewed native contracts/retention and the
lead’s runtime inventories; the Studio specialist independently replayed deployed
auth, VPC requests and retained native sign-in; the fresh second developer exercised
the repaired factory and release UI in AWS. Raw receipts preserve the responsible
reviewer and observation time. The B/C tables together are the shared evidence
register; source fixtures, ports and target ownership are listed once in C.

Both passes completed the required full application journey. Pass Two found an
additional real native-update defect and an operational ENI cleanup dependency;
the update was repaired/retested and the exact unused interfaces were removed
through a separately verified ordinary cleanup. This is not a claim that Studio
automatically resolves orphan interfaces or restores an entire retained application.

## C. Actual AWS resources, ownership and cost

Both live fixtures use profile `dev`, account **734849394764**, region
**us-east-1**. STS was checked; a profile name was not treated as ownership proof.
The framework's ordinary dev graph omits routed HTTP and VPCs, so both disposable
applications use the **prod composition in an isolated development account and
namespace**. Guards reject other names/accounts/regions. This is not a production
rollout. Pass Two's exact initial saved plan received specific user approval after
automatic review required it; the rejected action was not bypassed.

| Fixture / ports | Namespace and reviewed operations | Resource inventory / cleanup state |
| --- | --- | --- |
| Pass One `.cache/job3/cloud1`, Studio 4595 | `job3-20261023-p1-1608`; create `plan-mvlf1iqz-ed5427`; retention/repair `plan-mvlgf01y-2f1e7d` | 8 stacks/120 initial resources; 11 Lambda, 13 roles, 2 S3,1 VPC/6 subnets, 1 S3 gateway, HTTP API, CloudFront/KVS, native Cognito/Identity Pool. Original stacks all DELETE_COMPLETE21:34:30 UTC; 27 retained native resources reviewed separately |
| P1 reference `.cache/job3/recovery1`, Studio 4598 | `job3-20261023-p1-reuse-1645`; `plan-mvlhn4s4-83b7b6` | Only SSM reference parameter + CDK metadata; actual create 21:39:53 UTC, DELETE_COMPLETE21:46:35 UTC; browser/server stopped |
| Pass Two `.cache/job3/cloud2`, Studio 4596 | `job3-20261023-p2-1630`; user-approved create `plan-mvlfoifw-96f64f`; corrected detach `plan-mvlhswia-1e9d01` | 8 stacks/104 initial resources; 9 Lambda, 11 roles, 2 S3,1 VPC, S3 gateway, free IPv6 egress-only gateway, HTTP API, CloudFront/KVS, native Cognito/Identity Pool. Health probe adds 6 native resources, giving 110; original stacks, exact retained resources and reference shell all deleted |
| P2 reference `.cache/job3/recovery2`, Studio 4598 | `job3-20261023-p2-reuse-1720`; `plan-mvliulgu-bd62cc` | Actual inspected external reference; only SSM parameter + metadata. Created 22:10:44 UTC, deleted 22:22:04 UTC; no original pool mutation |

Initial P1 GUI authoring used `.cache/job3-pass1` on 4593 before its reviewed
declarations were handed to cloud1. Local SQL/browser work also used 4594/4597;
all were isolated campaign listeners. P1 API/runner ports were 18093/18094; fresh
P2 local Lambda API was 18096. The original user Studio 4590 remained separate.

Initial active CloudFormation stacks were `LawstructPlaceholderStack` and `CDKToolkit`;
immutable StackIds/status/timestamps were recorded in
`.cache/job3/aws-baseline-stacks.json`. They must remain unchanged in final audit.
No NAT gateway, EIP, paid interface endpoint, RDS, EC2 instance, ECS/Fargate,
Route53 change or ACM certificate was created. The framework's current minimum two-zone declaration
explains the extra subnets; these are not claimed as a single-subnet experiment.

P1 key identities: pool `us-east-1_4EDSwlGS5`, client
`3b63v8begmvtg5fhi1spbjmgcc`, Identity Pool
`us-east-1:05e1fc57-1c8a-4352-973b-d72ce76196dc`, HTTP API `zvb0n14pjk`,
CloudFront `E1IP8IUOXXJCMP`, VPC `vpc-03eaee0a80b4577d9`, data bucket
`job3-20261023-p1-1608-job3storagest-bucket83908e77-u3uipndsjynq`.
Complete physical resources and immutable RoleIds/StackIds are in
`iam-runtime/cloud-owned-inventory.json`.

P2 key identities: pool `us-east-1_WY7PmTg0R`, client
`5srn6nj5f287vao5grio4b3s9g`, Identity Pool
`us-east-1:a9d9b5e1-9114-45ef-9bb0-516e21a98864`, HTTP API `wblf6bxl0i`,
CloudFront `ERA0LSZ03BRQE`, VPC `vpc-0c40861d4c75116c7`, data bucket
`job3-20261023-p2-1630-receiptstores-bucket83908e77-eyqxyopancxc`.
See `database/p2-owned-stacks.json` and `database/p2-outputs.json`.

Each live application was estimated below $5 incremental usage within two hours;
P1 began around 20:24 UTC, P2 at 20:55:47 UTC. These are estimates, not billed charges or
claims of free execution. Final retained cleanup completed at 21:55:39 UTC for P1
and 22:24:37 UTC for P2: approximately 92 and 89 minutes of provisioning/test/cleanup
exposure respectively. Logging and bootstrap asset storage are separately accounted. Shared bootstrap storage is preserved, not pruned to make cleanup look
complete.

## D. Actual IAM and connectivity evidence

P1 diagnostic Lambda read `allowed/read.json` 200. A bucket policy explicitly denied
PutObject despite an allow; that request returned 403. DeleteObject and unrelated
prefix GetObject returned 403 through implicit deny. Missing key 404 and invalid
operation 400 were distinct. Native `grantRead` also permits bucket/list/GetObject*
actions; this Lambda is not described as an exact GetObject-only policy.

Missing reader-group claims failed Identity Pool credential issuance; guest access
was disabled. After actual group membership and a fresh native token, temporary
credentials assumed the exact retained `ReaderRole6150FC74` physical role. They
read `allowed/read.json` 200, while Put/Delete/unrelated Get returned 403, then read
again 200. The native reader role grants GetObject only on the designated prefix.
No credentials or token bodies were persisted in the evidence.

Native role trust binds the exact Identity Pool audience (`aud`) and authenticated
`amr`; Token mapping rejects ambiguity. Actual STS identities establish which
reader role was assumed. Policy/trust inspection is distinct from request proof.

The P1 VPC function initially had a wrong-prefix read grant and returned 403. Studio
Connect workload disconnected `wrong/*`, connected `allowed/*`, reviewed and applied
source, then the saved cloud plan updated that exact owned role. The same function
then read 200 and still denied Put/Delete/unrelated Get 403. An independent deployed
browser reached `/api/job3-vpc` 200. Actual S3 application communication through the
gateway was proved; an intentionally unreachable public STS request timed out,
while the non-VPC control succeeded. No NAT was added.

P2 reader-group temporary credentials similarly assumed its actual reader role:
processed-prefix Get 200; Put/Delete/unrelated Get 403. The isolated HTTP handler
first returned 503 `ERR_JWKS_TIMEOUT` because handler-side JWT validation fetches
public Cognito JWKS. An S3 gateway does not provide that path. Missing/invalid
JWT 401 remained distinct from valid-token dependency failure 503.

GUI source moved HTTP to `subnet: "none"` and the event to explicit isolated
`receipts` VPC placement. AWS rejected the original native update 400 because CDK
omitted VpcConfig while the old dual-stack flag remained true. The framework now
explicitly supplies empty subnet/security-group lists and IPv6 false for unplaced
functions. The corrected saved plan retained all original 104 logical identities,
added only 6 health-route resources and had no S3/Identity policy widening.
Actual HTTP physical ID stayed unchanged, VpcConfig became empty/false, fresh
health GET 200 succeeded, and the original authenticated request reached its
intended missing PutObject 403. A canary upload triggered the isolated event and
its processed-object Get 200, proving VPC application communication. The subsequent scoped repair `plan-mvlibism-4c1814` modified only the HTTP role
inline policy and metadata. Native grantWrite permits Abort/Delete/Put variants on
this bucket’s `uploads/*`; it is not a Put-only grant. Fresh native sign-in then
upload 202 → isolated event → processed read 200 passed. The distinct GetObject-only
Identity reader still read 200 and denied Put/Delete/unrelated Get 403 afterward.

Core receipts: `cloud-auth-group.log`,
`job3-20261023-p1-1608/{auth-evidence,runtime-evidence,vpc-repair-evidence,event-trigger-evidence}.json`,
`database/p2-live-{auth,missing-write,repaired}.json`, `database/p2-fresh-health-runtime.json`,
`database/p2-http-network-update-rollback.json`, and
`p2-vpc-reset-independent-review.json`.

## E. Database, authentication and retained state

The first isolated Compose project `matts-job3-database-20261023` used loopback 15463;
Pass Two used fresh `matts-job3-p2-database-1630` on 15464. Native Prisma validation,
initialization, migration review/apply, drift, stale SQL and transaction evidence
used actual PostgreSQL 16.15. Seeds inserted once, reran as 0, and survived compute
replacement with the same volume. Constraint SQLSTATE 23505/23503 rolled back;
read-only 25006 and wrong password 28P01 refused. Saved history/once ledger survived
service restart. No production database or startup-triggered migration was used.
The opt-in real lifecycle suite passed 9/9; three inherited target-override checks
refused before Docker. Both principal campaign databases and volumes were removed.

The local application API 18093 and runner 18094 used declared bindings; the actual
workflow wrote PostgreSQL through its normal child handler. Missing runner 503 and
restart recovery were observed; old execution history 404 is an in-memory journal
limitation. Only the runner mounted the explicitly approved Docker socket. Source
mounts were read-only, the API stayed socket-free, and neither had AWS credential
mounts. Those containers were removed. Fresh P2 local API 18096 independently
returned health 200/auth 401 and 404 for wrong/undeclared routes, with no socket.

P1 retained recovery was actual, not a pre-teardown simulation. Once the exact
original CognitoStack was DELETE_COMPLETE21:29:12 UTC, GUI inspection verified the
retained pool/account/region/client and applied the external-reference source.
The reference cloud Apply and authentication proof were gated on all 8 original
StackIds being DELETE_COMPLETE21:34:30 UTC. A new one-stack shell
created only an SSM descriptor and metadata. Original SDK user subject
`44089448-a041-7081-62de-0bff407382e5` authenticated with the same password, obtained
new credentials from the original Identity Pool/reader role, and read the original
S3 object 200. Independent original browser user subject
`4498c4a8-50d1-7001-8966-fea3a7eabd38` also signed in 200. All native users/groups,
client identity and callback metadata were observed, not reconstructed from guesses.

The reference shell does not own the external pool. Its normal GUI teardown
completed and left the original pool present and protected, independently verified.
Keeping the native hook functions/roles/permissions and Identity Pool/group/role
mapping was explicit code-first retention work; retaining only the pool would not
prove recoverable authentication. The former frontend was already gone, so this
proves native credential and S3 reuse, not hosted OAuth or whole-app recovery.
P2 independently inspected the released original pool after its exact CognitoStack
was deleted, applied GUI reference source, and deployed only the same two-resource
shell. Once all 8 original StackIds were DELETE_COMPLETE, the original in-memory
password authenticated the unchanged subject
`640874e8-a071-70dd-bf8b-c907fff86199` with HTTP 200. Fresh Identity credentials
assumed the original reader role and read the original object with SHA256
`5a9c57689a496674fa31d2c1dc774fdc44e1f99735669572ff51b0ee9a714acd`.
Put/Delete/unrelated Get all returned 403; the reread returned 200 with the same
hash. The reference shell's reviewed GUI teardown then completed. No reset,
replacement user, replacement data or guessed identity made this recovery pass.
Public receipt: `database/p2-recovery-live.json`.

## F. Frontend, deployment and production preview

P1's alternate static client consumed the actual generated 619-byte public env file,
built 4 files, and excluded `.env`/source maps from publication. GUI releases
`428f9360-3068-43f6-914f-99a60abf46d9` and
`86cdb69a-5b0e-476d-9a37-5a7cf6031426` each uploaded 4/deleted 0. Both requested
invalidations were independently observed **Completed**; the second
`I8QV4KLYEXIQTBMHISDWB2A4BV` served Release two 200, ETag
`2ed38aa12e32ba2f8eb81ccbef6c71be`.

Independent Chrome at desktop 1440px and approximately 420px exercised native signup,
sign-in, protected API 200, scoped S3 read 200, wrong password 400, invalid JWT 401 and
recovery 200. Keyboard focus and password/token clearing were checked; document
width 420 had no overflow. One scoped read timed out 502 under the fixture's2.5-second
SDK deadline and succeeded on one retry. A favicon 403 and one generic form id/name DevTools issue
remained. This is not an exhaustive accessibility/performance certification.

P2 generated its own env from real outputs and built a separate client. The
pre-update release review was actually refused after new health outputs/deployment
status changed, with zero uploads/deletes. The corrected release message reset
removed the prior build-complete text during that failed publication. Fresh GUI release `b3da9e1f-81a7-4ac5-8ff2-eb70634108f5` then uploaded 2 files,
deleted 0, and returned HTTP 200. Its saved result correctly recorded invalidation
submission InProgress; independent AWS receipt `database/p2-invalidation-root-check.json`
subsequently verified `ID9YQQUAW9SHWIJV0HXQ3EBN5C` **Completed**. Actual deployed
browser at `https://d3fkk3db6lhnmb.cloudfront.net` observed wrong-password 400,
correct sign-in/password clearing, upload 202 → event → processed read 200. Desktop
and 420px keyboard checks had no horizontal overflow; missing-record 404 and
favicon 403 were recorded. Data writes then stopped for the final ownership snapshot.

The existing TanStack reference client production build passed locally. The two
alternate clients test framework independence; neither is misrepresented as a
live deployment of the complete reference application. Original production was
previewed read-only:229 resource changes required exact typed-name confirmation;
the field stayed empty and Apply disabled, then the preview was explicitly discarded. Durable jobs are
`.cache/framework-studio/jobs/mvlej2k8-871fd0.json` and `mvlfczl6-fc6b1f.json`.
No original production Apply/publication/invalidation/DNS/ACM/Cognito/database
mutation occurred. A template preview does not verify production certificate,
hostname, account permissions or real release behavior.

## G. Product improvements and developer friction

1. Native bucket CDK tokens now pass Identity Pool ARN validation while unsafe
   literal wildcard/control-character checks remain. A native Fn::GetAtt scoped
   GetObject regression proves integration without copying literal identities.
2. Unplaced Lambda synthesis now explicitly clears VPC subnet/security-group/IPv6
   settings. Four regressions cover stable VPC→none identity and fresh Node,
   Python and container functions; placed functions keep normal networking. Actual
   AWS detachment and fresh Node 24 health-function creation independently passed;
   Python/container variants have regression synthesis evidence only.
3. Discarding an invalid Identity Pool draft clears its old validation/simulation
   error when saved source is restored. The regression was red before/green after;
   independent browser replay passed.
4. Stale source-review guidance now explains how to preserve and re-review a draft,
   including the protected environment/resource inspector reload path.
5. Unreachable database guidance identifies the selected Compose project/port and
   does not imply inspection starts containers or applies migrations. A guarded
   opt-in real Docker lifecycle suite exercises initialization through persistence.
6. Starting a frontend action clears the preceding action's status text. Actual
   first-pass publication exposed misleading old build text; independent Pass Two
   observed the corrected reset during refused stale publication.
7. The existing unsaved-schema navigation test now awaits async blocker cancellation
   and dialog disappearance before requesting a second navigation. Its previous
   pathname assertion was already true while cancellation was pending. This is a
   test synchronization repair; a runtime navigation defect was not reproduced.

Fixture friction was recorded rather than bypassed: unused copied modules failed
normal complete generator/TypeScript checks and were archived only inside the
minimal fixtures; localReplay required the supported handler wrapper; synthetic
pre-signup required the ordinary explicit environment binding; duplicate prod/dev
CDK_APP_NAME input initially failed safely before writes. Custom handlers/native
composers/retention helpers remain explicit code-first work. No new IAM analysis
engine or dependency upgrade was introduced.

## H. Verification results

The required **last** `npm run verify` completed with terminal exit 0 in
`.cache/job3/verify-integrated-final.log`, after product source froze and the test
synchronization repair: **1727 passed, 3 intentional skips, 0 failed**. Node suites
passed 1658; client Vitest 65 and WebSocket Vitest 4 bring the total to 1727. Studio
passed 811/813 with 2 intentional skips; CDK passed 274/275 with 1 intentional skip.
The terminal receipt is `verification-integrated-final-receipt.json`.
The immediately preceding complete run
`.cache/job3/verify-final-release-status.log` exited 1: Studio 810 passed, 1 failed,
2 skipped; unsaved-schema navigation could not find Discard and continue. Focused
unchanged replay 14/14 and bounded 24 repeats did not reproduce a runtime defect;
the synchronized complete file then passed 14/14. The failed gate remains recorded.

Earlier complete `.cache/job3/verify-complete-final.log` exited 0 with 1723 passed,
3 intentional skips, 0 failed, before the last release/factory changes. Latest
separate CDK suite after the factory change:275 tests, 274 passed, 1 intentional
opt-in skip, 0 failed; focused network/factory 19/19 and CDK TypeScript passed.
Additional focused policy 15/15, source/draft 83/83, release 6/6, IAM/network 49/49,
native bucket 5/5 and real database 9/9 passed. Focused successes do not relabel the
failed whole-repository command.

Final explicit normal bundled dev and prod synths exited 0:
`.cache/job3/factory-synth-{dev,prod}.log`, assemblies `factory-final/{dev,prod}`.
Identity comparison `identity-comparison-final.json` verifies dev 3 stacks/36
resources and prod 11 stacks/264 resources including metadata: stack names,
environments/tags, logical IDs/types, native construct paths, outputs/export names
and ownership unchanged. **Templates are not identical**:22 previously unplaced
functions now explicitly synthesize empty VpcConfig/IPv6 false; details are in
`factory-vpc-property-deltas.json`. No original production template was deployed.

Studio production build and reference client production build exited 0; logs
`studio-build-release-status-final.log` and `client-build-final.log`. No frontend
source changed after that Studio build. Knowledge validation passed 30 pages,
583 local links, 167 source references; final diff/link checks passed after documentation updates. Real browser, Docker, database, deployed requests
and synthesis are reported separately above; offline verify substitutes for none.

## I. Cleanup ledger and residual costs

P1 original teardown `delete-mvlgnqs3-b97c3b023e2b` verified the exact 8 immutable
StackIds and 27 retained resources. All stacks reached DELETE_COMPLETE21:34:30 UTC.
Native VPC Lambda ENI deletion took approximately 20 minutes; no forced detach or
premature role deletion was used. AWS documents that this can take 45 minutes:
[official AWS troubleshooting](https://repost.aws/knowledge-center/lambda-delete-cloudformation-stack).
Reference-only teardown `delete-mvlhxckr-f9c54c5025ad` then completed 21:46:35 UTC.

Exact retained cleanup uses fresh account/ownership, immutable original stack
history, RoleIds/trust/policies, exact S3 key/version/ETag/size and log creation-time
checks. AWS removed the retained S3 bucket's reserved CloudFormation tags; the
preflight stopped safely and was independently corrected to require exact
DELETE_SKIPPED history from the immutable original StackId, while retaining all
current framework-tag/object checks. No deletion by prefix was allowed.

The first cleanup removed the owned Identity Pool/group/domain/client, then
Cognito refused protection update because required email auto-verification fields
were omitted. Actual state was inspected before a separate, reviewed continuation;
there was no blind replay. The continuation completed 21:55:39 UTC:26 further mutations removed the exact
remaining pool, 3 hooks, 5 retained roles, 3 object versions, bucket and 10 surviving
logs. All 12 inventoried logs were then absent. Independent read-only checks
confirmed 31 exact physical resources absent, including all 13 original IAM roles,
all 11 functions, 2 buckets, CloudFront, HTTP API, VPC, pool andIdentityPool; all 9 immutable
original/reference stack histories were DELETE_COMPLETE. Original unrelated and
CDKToolkit StackIds/status/creation/update timestamps remained unchanged. See
`iam-runtime/cloud1-retained-cleanup-{journal.jsonl,result.json}` and
`iam-runtime/cleanup-retained-cloud1-continuation.cjs`.

P2 required a separate exact interface cleanup. After VPC detachment and deletion
of the creator HTTP execution role, two released ENIs remained in the owned
network. Independent current checks proved account/VPC/subnet/security-group
ownership, available/unattached/non-requester-managed state, creator and shared
event functions/roles absent, zero regional Lambda version references and zero
event-source mappings. Fresh guarded ordinary DeleteNetworkInterface calls removed
only `eni-0d2f38983c97fc1ff` and `eni-0b0c18701b479441c`, with absence verified at
22:20:20 UTC. No detach, force or unrelated interface action occurred.
`iam-runtime/p2-orphan-eni-{proof,delete-result}.json` preserves the evidence.
This follows the [documented AWS role/ENI lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
and is a manual operational repair, not a new automatic Studio cleanup feature.
Native deletion resumed afterward; all 8 original immutable stacks reached
DELETE_COMPLETE at approximately 22:21 UTC. The separately reviewed reference
shell deletion completed at 22:22:04 UTC. Exact native result files remain under
the two fixtures’ `.cache/framework-studio/teardowns/` directories.

Local owned PostgreSQL containers/networks/volumes and P1 API/runner were verified
absent. Shared cached PostgreSQL/API images predate Job 3 and were preserved;
`iam-runtime/local-image-residuals.json` reports no runner-owned images/containers.
Shared Docker Desktop and the user's original Studio 4590 are preserved. All
campaign browser pages, the credential-memory process and owned Studio servers
are stopped. The final local audit found zero campaign containers, volumes,
networks or listeners across recorded ports, with original Studio 4590 still
running. Receipt: `local-residual-audit-final.json`.

Shared CDKToolkit infrastructure and bucket
`cdk-hnb659fds-assets-734849394764-us-east-1` are preserved. P1 traces 27 current
objects/476880 bytes; P2 traces 29 current objects/540434 bytes, including the new
reference template. Their deduplicated union is **52 current objects/780510 bytes**;
this is not the entire shared bucket or an incremental billed-storage figure.
P2’s initial 17-key baseline observed 6 preexisting and 11 absent before upload;
12 later keys have no before observation. The union combines time-stamped HeadObject observations; it is not a simultaneous
bucket-wide inventory. Historical versions were not exhaustively listed. All shared objects remain untouched and can incur small continuing storage
charges. Exact union: `iam-runtime/shared-bootstrap-final-union.json`; per-pass
HeadObject receipts: `shared-bootstrap-residuals-{p1,p2}-final.json` in that directory.
No broad cleanup, image prune or shared bootstrap mutation/deletion occurred.
P2 retained cleanup completed at 22:24:37 UTC with 29 exact mutations, after fresh
account/identity/policy/object/log guards. It removed the retained pool/client/
domain/group/Identity Pool, 3 hooks, 5 roles, 8 exact S3 versions, the data bucket
and 9 surviving logs; all 11 inventoried logs were then absent. The independent
checker passed 29 physical absence reads, including all 12 original roles and
10 functions, plus all 9 immutable original/reference stack histories. P1's
corresponding checker passed 31 physical absence reads and 9 stack histories.
Together these cover **60 exact physical resources and 18 deleted stack histories**.

Final active-stack discovery returned exactly the two original stacks,
`LawstructPlaceholderStack` and `CDKToolkit`; immutable IDs, status, creation and
last-update timestamps match baseline. No live campaign compute, networking,
application buckets, pools or inventoried logs remain. Preserved shared bootstrap
assets above are the explicit cloud residual. Proofs:
`iam-runtime/{p1,p2}-physical-absence.json`, `aws-active-stacks-final.json`,
`iam-runtime/p2-retained-cleanup-result.json` and `local-residual-audit-final.json`.

## J. Remaining limits

- External Google/OIDC/SAML credentials, custom DNS/ACM rollout, cloud RDS,
  ECS/Fargate, CloudFormation import, snapshot restoration and native Windows host
  execution were not performed. Relevant source/unit/refusal evidence is separate.
- Detach-then-teardown can leave released Lambda ENIs after their creator role is removed. Studio does not automatically reconcile those interfaces; P2 required separately verified exact ordinary ENI cleanup, which completed. This operational limitation is documented, not claimed fixed by the VpcConfig repair.
- Native pool reuse does not recreate surrounding frontend, providers, role
  mappings or network infrastructure. Retained dependencies were kept explicitly.
- The deployed clients are small alternate clients. The full TanStack reference
  application has local build evidence, not a claimed full live deployment.
- Incorrect trust/stale descriptors, missing environment/provider and output-safety refusals have source/injected regression evidence; they were not all deliberately introduced into live AWS. Core IAM denials/repair and native role selection above use real requests.
- Graph/source permissions and simulation describe intent; only the recorded
  principal's actual AWS requests prove the stated allowed/denied behavior.
- Warm-handler reuse and performance were not separately profiled; actual request, restart and recovery evidence above does not imply performance certification.
- No production release is authorized or implied. Billed cost is unavailable;
  estimates, elapsed provisioning and residual storage must remain distinguished.
