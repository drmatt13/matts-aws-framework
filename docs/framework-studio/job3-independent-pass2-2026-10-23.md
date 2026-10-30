# Job 3 independent second application evidence

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

The independently authored second application completed the executed bounded
Pass Two scope: fresh local database/service journeys, AWS creation and repair,
native authentication and scoped Identity credentials, HTTP upload/event/read,
frontend publication/browser use, original teardown, retained-reference recovery,
reference-shell deletion and final retained-resource cleanup. Independent physical
absence checks passed. The journey required two reviewed ordinary orphan-interface
deletions; shared bootstrap assets remain explicitly preserved below.

The database specialist was reassigned as an independent application developer;
they did not implement the first application's GUI or cloud fixture. Source started
from a fresh copy of current repository source in `.cache/job3/cloud2`, excluding
private environment files, Git state, caches and deployment manifests. Studio ran
on `http://127.0.0.1:4596`. The application concerns synthetic uploaded receipts,
with a distinct HTTP/event contract and object prefixes from Pass One.

## Completed outcome matrix

| Area | Actual evidence and outcome |
| --- | --- |
| Independent authoring | Fresh source fixture; real GUI creation, connection, placement, source review and Apply; explicit native code composition beyond GUI |
| PostgreSQL | Fresh owned target initialized through GUI; repeat seed 1 → 0; foreign-key refusal and corrected commit; original JOIN after compute replacement; exact local cleanup |
| Local API | Normal service entry point: public health 200, protected route 401, unsupported method and missing route 404; owned container/network removed |
| AWS creation | Eight guarded new stacks, 104 resources; later six explicit health additions; all original 104 physical IDs unchanged |
| Native Cognito | Observed unconfirmed-user refusal, source repair, fresh confirmed signup and password sign-in; no admin confirmation |
| Identity authorization | Guest/default exchange refused; exact ReaderRole through fresh credentials and STS; allowed read 200, write/delete/unrelated reads 403 |
| Network repair | Observed JWT-key reachability failure and real update rollback; common factory fix validated by existing HTTP detachment and fresh no-VPC health 200 |
| Isolated event | Actual uploaded object processed through EventBridge/S3; both selected subnet route tables had gateway routes and no default routes |
| Scoped upload repair | Actual PutObject 403, reviewed native uploads write grant, then HTTP 202 → event → authenticated read 200; Reader denials unchanged |
| Frontend | Two actual uploads, zero deletions; invalidation independently Completed; native sign-in/upload/read in browser; mobile keyboard/error state; previous build message cleared |
| Retention/recovery | Actual protection/26-resource retention packet; all eight original stacks deleted; fresh reference shell preserved original IDs; original password/sub/STS role/object bytes and 403 denials passed |
| Final cleanup | Original eight and reference shell DELETE_COMPLETE; retained cleanup exit zero; 29 independent physical absences, baseline stacks unchanged; no campaign local resources/listeners |
| Repository gate | Final npm run verify exit zero: 1,727 passed, three opt-in skips, zero failed; database/browser/synth/deployed evidence reported separately |

This scope does not claim RDS recovery, CloudFormation import, restored hosted
OAuth/frontend behavior, container runTask, or AWS Step Functions execution.

## Actual GUI authoring

The independent developer used Playwright MCP to configure, review and Apply:

| Source item | Observed saved behavior |
| --- | --- |
| `receipt-api`, `/receipts` | Authenticated POST route, starter handler, explicit `userPool: true`, generated framework/API artifacts |
| `receipt-ingested` | New event Lambda source and declaration |
| `receiptStore`, `ReceiptStoreStack` | Native private encrypted retained bucket, typed public field and `linkResources` |
| Event permission | `grantWrite("processed/*")` through Connect workload review/Apply |
| Event trigger | Bucket object-created notifications for `uploads/` and `.json`, with actual handler-contract and recursive-write acknowledgements |
| `receiptIdentity`, `ReceiptIdentityStack` | Authenticated-only Identity Pool, permissionless default role, ambiguity denied, explicit reader group |
| `receipts`, `Receipt network` | New `10.2.0.0/16` VPC declaration; NAT off and zero interface endpoints; default free IPv6 egress retained |

Both configuration modes accepted every source review. GUI-authored HTTP/event
declaration bytes are preserved in `.cache/job3/database/p2-authored/`; source review
screenshot is `.cache/job3/database/p2-http-source-review.png`.

## Explicit code-first work beyond the GUI

The application then used a minimal native framework composer and only selected
literal section modules. Unused example implementation directories were archived
inside the fixture because the real generator correctly refused undeclared source
directories. This is fixture source isolation, not removal from the user's checkout.
Dependency versions remained unchanged; copied manifests' original timestamps were
restored only after byte-for-byte comparison to avoid falsely presenting copied
source as a changed dependency install. Shared `node_modules` was not reinstalled.

Own application handlers replaced starters: authenticated receipts use the session
subject in object keys; the event writes receipt acknowledgements to disjoint
`processed/` paths. Initially the HTTP Lambda used the declared VPC/isolated
subnet and S3 gateway, with SDK `useDualstackEndpoint: false`. Its first deployment
deliberately granted only reads of processed objects; actual reachability and
missing PutObject permission failures and their repairs are recorded below.

Native identity source uses the actual bucket's CDK ARN reference for reader-group
GetObject on `processed/`; guest issuance remains disabled. To avoid the known
cross-stack notification dependency cycle, the owning bucket explicitly enables
EventBridge and the reviewed source adapter uses EventBridge delivery. The unused
DynamoDB gateway was removed before the actual deployment plan. IPv6 egress is an
intentional independent network variation; no hourly NAT or interface endpoint is
added. A separate small frontend uses a native Node build script and `web/out`,
consuming the normally generated public client environment.

## Destination and preflight

| Identity | Exact value |
| --- | --- |
| Profile | `dev` |
| Account | `734849394764`, independently checked through STS |
| Region | `us-east-1` |
| Disposable namespace | `job3-20261023-p2-1630` |
| CDK mode | Production composition, exclusively guarded to the new development-account namespace; no existing production destination |
| Cost cap | Estimated incremental usage below $5 for at most two hours; not a billed-cost claim |

The native composer refuses any other name/account/region/mode. It creates no RDS,
NAT, EIP, EC2 instance, ECS workload, paid interface endpoint, DNS record or ACM
certificate. Domain customizations are disabled in fixture inputs.

The real framework generator passed after explicitly archiving unused examples.
Native CDK synth completed successfully. Studio's actual **Compare AWS templates**
button then produced a ready, read-only template plan: **104 additions, zero
modifications, zero removals**, eight new exact-namespace stacks, no secret changes,
no Docker-image publication. AWS observation reported that this exact destination
had no deployed stacks. New scoped IAM roles require the existing typed name review.

Saved plan:
`.cache/job3/cloud2/.cache/framework-studio/plans/job3-20261023-p2-1630-mvlfohsn-ae71/plan.json`
(`plan-mvlfoifw-96f64f`). Screenshot:
`.cache/job3/database/p2-plan-ready.png`. Native preflight and operation ledger:
`.cache/job3/database/p2-operation-packet.json` and `p2-synth.log`.

Exact bootstrap object keys from the saved assembly are recorded separately and
their pre-upload metadata is inspected before Apply. Shared bootstrap objects and
infrastructure must be preserved; prefix resemblance alone never authorizes removal.

Cloud application, authentication, IAM denial/repair, publication and teardown
outcomes are recorded below as they are observed.

## Fresh local database through the GUI

While cloud Apply awaited its separate concrete-environment approval, the
independent developer created an entirely new local PostgreSQL project,
`matts-job3-p2-database-1630`, with its own labeled `campaign_data` volume and
loopback port **15464**. It reused no Pass One rows or volume. Through Studio's
actual Database status controls they inspected the empty target, reviewed native
Prisma initialization SQL for `users`/`projects`, indexes and the owner foreign key,
typed **Initialize Local PostgreSQL**, and applied it. Follow-up marker/physical
inspection reported current. Screenshot: `p2-db-initialized.png` in
`.cache/job3/database/`.

Actual GUI Saved SQL then produced these independently authored journeys:

| Command | Real outcome |
| --- | --- |
| `p2_demo_user` | First seed committed one user; `ON CONFLICT(email)` rerun committed zero rows |
| `p2_project_link` with absent owner | PostgreSQL **23503** foreign-key failure; acknowledged rollback, unchanged |
| Same command with corrected bound owner | Committed one project referencing the seeded original user |
| `p2_project_read` after complete compute replacement | Actual read-only JOIN returned the original project and synthetic email |

After independently verifying both campaign labels, the original PostgreSQL
container was stopped and removed without deleting its volume. Compose created a
different container ID mounted to the exact same owned volume. The saved inspection
was reviewed/executed through the GUI at **420 × 900** and returned:
`[{name:"Independent receipt project",email:"p2-local@example.invalid"}]`.
The document width measured **420**, with no horizontal page overflow. The changed
container IDs and retained mount are in `p2-local-reconnection.json`; redacted
operation-history counts/statuses are in `p2-sql-history-redacted.json`.

Browser screenshots, under `.cache/job3/database/`:

- `p2-sql-seed-committed.png`
- `p2-sql-foreign-key-denied.png`
- `p2-sql-after-reconnection-420.png`

This proves a fresh independent local PostgreSQL/Prisma/Saved SQL/reconnection
journey. It does not establish RDS recovery or connect this local storage to the
separate cloud application. After capturing evidence, independent label
checks and exclusive network-membership checks authorized ordinary Compose teardown
of this exact owned project and removal of its exact volume. All three final
container/volume/network absence filters were empty; receipt and original physical
IDs are `p2-local-cleanup.json`. Existing user volumes/images were preserved.

## Cloud Apply authorization status

The lead reviewed the actual saved 104-addition plan and released it under the
standing Job 3 disposable development scope. The independent developer typed the
exact deployment name into Studio. Automatic approval review then **rejected the
Apply click before execution**, citing that this creates eight production-mode
composition stacks with IAM/Cognito/VPC/S3/CloudFront resources in the concrete AWS
account. No P2 cloud deployment occurred in that rejected call. The saved ready
plan remained intact. The lead presented the exact environment/namespace/plan and
bounded tests/publication/cleanup packet for explicit user authorization. No CLI,
alternate transport or other workaround was used to bypass that rejection.

Pre-upload metadata inspection covered all **17** exact bootstrap asset object keys:
**6 preexisting, 11 absent, 0 uncertain**. Their bucket/key/ETag/version/size/time
evidence is `.cache/job3/database/p2-bootstrap-before.json`. Nothing was uploaded
by that read-only observation.

The user subsequently replied **"Approve this exact Pass Two scope"** to the
concrete packet above. The developer reopened the same saved Studio plan,
reconfirmed its SHA-256
`8a068725d08a0719781e6cf740013a344620742822f406a41487e4a130fe1cf4`,
104 additions, zero modifications/removals, and empty secret/review-problem lists,
typed the exact deployment name, and submitted the approved GUI Apply at
**2026-10-23 20:55:47 UTC**. The two-hour campaign deadline is 22:55:47 UTC.
This accepted retry follows explicit authorization; it did not bypass the earlier
rejection. Receipt: `.cache/job3/database/p2-preapply-confirmation.json`.
Deployment completion and application health are recorded separately below when
observed.

## Actual AWS creation and native authentication

The approved first Apply finished with all **eight stacks CREATE_COMPLETE** and
104 deployed logical resources. The independent runner checked every actual
`FrameworkDeployment` output against the exact namespace, account and region,
then captured immutable StackIds, physical resource IDs and public outputs in
`p2-initial-owned-stacks.json` / `p2-initial-outputs.json`. Screenshot:
`p2-deployed-desktop.png`. This is actual AWS creation, separate from application
health.

The first public Cognito `SignUp` returned HTTP 200 with `UserConfirmed:false`;
`InitiateAuth` correctly refused `UserNotConfirmedException`. Source inspection
found the independent fixture's abbreviated hook declaration omitted the normal
`SKIP_EMAIL_VERIFICATION: resources.cognito.skipEmailVerification` environment
reference. Native stack props alone did not supply that workload environment.
The postconfirmation handler was already an explicit code-first pure fixture
passthrough; it never required RDS. The presignup handler itself stayed native.
The GUI's input-delivery connection editor offered catalog inputs/secrets, so
this native stack-string reference was repaired in its source-owned declaration.

Actual Studio comparison `plan-mvlgzekv-390764` contained zero additions/removals
and two modifications: the presignup environment and CDK metadata. Secrets and
review problems were empty; no IAM broadening occurred. After its accepted GUI
Apply, a **fresh** native public signup returned `UserConfirmed:true`, and
`USER_PASSWORD_AUTH` issued a valid ID token. No admin confirmation was used.
The original unconfirmed user remained available as failure evidence. Logs:
`p2-live-unconfirmed.log`, `p2-live-initial.log`; their redacted JSON records
omit passwords, tokens and temporary AWS credentials.

Independent live Identity Pool checks then completed:

| Request / principal | Actual result |
| --- | --- |
| Guest identity request | `NotAuthorizedException` |
| Confirmed user without reader group | Credential exchange denied by ambiguity policy |
| Fresh native JWT after explicit reader-group assignment | Exact reader role and preferred-role claims |
| Issued identity credentials, verified with STS | Original campaign reader assumed role |
| Reader `GetObject` on `processed/identity-check.json` | 200 and exact synthetic bytes |
| Reader `PutObject` on processed prefix | 403 |
| Reader `DeleteObject` on processed prefix | 403 |
| Reader `GetObject` on unrelated prefix | 403 |
| Original synthetic user after those denials | `CONFIRMED` |

Evidence: `p2-live-auth.json` / `.log`. Default credentials were refused; this is
not represented as permissionless default-role credential issuance. Tokens and
temporary credentials stayed in process memory. The synthetic password was
initially held in a protected ignored campaign file; that file and the earlier
unconfirmed user's password file were then deleted when the bounded recovery
runner loaded the confirmed identity into memory. Subsequent browser and recovery
operations use memory only.

## Observed network failure and reviewed repair

Missing and malformed API tokens both returned 401. A real issued token reached
the isolated receipt HTTP Lambda and returned **503**, before S3 permission
evaluation. Its exact CloudWatch log reported `ERR_JWKS_TIMEOUT`: the handler's
independent JWT verification could not reach Cognito's public signing keys.
`p2-jwks-unreachable-logs.json` preserves that evidence. Actual Lambda inspection
recorded its owned VPC, two isolated subnets and security group; this is more
specific than observing a declared network.

The developer used Inspector Production placement, reviewed both source graphs,
and applied the HTTP declaration outside VPCs. Placing the S3-only event inside
the isolated VPC first refused with the framework's required `localReplay:true`
guidance. Enabling Studio's Local replay control produced one accepted source
transaction containing the VPC/subnet declaration, `withLocalReplay` handler
wrapper, and generated replay manifest. Screenshots:
`p2-http-placement-review.png`, `p2-event-placement-replay-review.png`.

Normal GUI validation also rejected unused copied example modules after the
fixture's catalog was reduced. Those unused fixture modules were archived, then
the same GUI review passed; the refusal was not bypassed or described as a
successful first attempt. Normal generator and CDK typecheck passed afterwards.

Before the next cloud update, the native composer was connected to the normal
stateful policy resolver and the independently reviewed exact authentication
dependency retention helper. Studio saved a reviewed prod-only Cognito retain
policy. Actual saved plan `plan-mvlhchqj-c41912` then showed **25 modifications,
zero additions/removals**, all original 104 logical IDs/types, empty secrets and
review problems. The only IAM managed-policy change transferred the standard
Lambda VPC execution policy from HTTP to the event role; reader trust, identity
mapping and S3 grants stayed unchanged. Eighteen resources gained retention,
and native pool deletion protection changed to ACTIVE. The lead independently
reviewed the actual saved templates before releasing the GUI Apply at
**21:29:13 UTC**. Receipt: `.cache/job3/p2-network-retention-independent-review.json`.
Completion, actual retained physical identities and repaired runtime behavior
require the subsequent observations below.

## Real rollback and framework repair

That Apply partially succeeded for the event and Cognito stacks, then the
existing HTTP stack entered **UPDATE_ROLLBACK_COMPLETE**. AWS rejected removal of
its previous IPv6-enabled VPC configuration with Lambda HTTP 400:
`Ipv6AllowedForDualStack cannot be true without subnet or security groups`.
Evidence: `p2-http-network-update-rollback.json`. Studio displayed the failed job,
resource reason and the fact that no secret updates ran. This was not retried
blindly or represented as a successful placement repair.

The independent runtime observation identified a framework transition defect:
`subnet:"none"` omitted `VpcConfig`, allowing the previous true IPv6 flag to
survive the CloudFormation update request. The IAM specialist repaired the
common framework Lambda factory to emit explicit false IPv6 and empty subnet /
security-group arrays when no placement is declared. The application still uses
only normal workload placement declarations; no application CDK override was
added. Primary API documentation permits zero-length VPC lists:
[AWS Lambda VpcConfig](https://docs.aws.amazon.com/lambda/latest/api/API_VpcConfig.html).
Four focused regression cases and the full CDK suite (274 passed, one opt-in
skip) passed before the lead approved copying that exact product source file
into the independent fixture.

The developer then used Studio creation/review/Apply to add a tiny public
`GET /receipt-health` workload, so the repaired AWS path can verify both an
existing detachment and a fresh non-VPC creation. The new canonical section was
composed beside the existing independently authored module, and generated routes
and target IDs were included in the accepted source transaction. Screenshot:
`p2-health-creation-review.png`.

## Independent normal local API execution

The same P2 declarations and actual GUI-created health handler ran through the
normal `local-api-dev-server/src/index.ts` entry point in the existing cached
development image. Fresh project `matts-job3-p2-runtime-1630` bound only
`127.0.0.1:18096`, with six narrow read-only source mounts and no Docker socket,
AWS credentials or volumes. Actual requests returned:

| Request | Result |
| --- | --- |
| `GET /api/receipt-health` | 200, `{"message":"Ready"}` |
| `GET /api/receipts` without token | 401 |
| `POST /api/receipt-health` | 404 |
| `GET /api/not-declared` | 404 |

Evidence is `p2-local-runtime/{compose.json,container-inspection.json,server.log,requests.json}`.
After exact label inspection, ordinary Compose teardown removed that container
and its exclusive project network. Both final filtered inspections were empty;
`p2-local-runtime/cleanup.json` records the owned ID and boundary. This is an
actual local service run, distinct from unit tests or CDK synthesis. The fresh
PostgreSQL/Saved SQL/reconnection journey and its independent cleanup are
documented above; this health route does not claim a database or local S3-event
round trip.

## Actual network transition, scoped repair and full application

The repaired saved plan `plan-mvlhswia-1e9d01` preserved all original 104 logical
IDs and added only six health-route resources, for 110 current resources. Root
and the IAM specialist independently reviewed its templates before the actual
GUI Apply at **21:46:55 UTC**. All eight stacks completed at **21:49:02 UTC**.
Actual Lambda configuration then proved the original HTTP physical function had
empty subnet/security-group lists, empty VPC ID and IPv6 false. The event kept its
exact owned VPC, isolated subnets and IPv6 true. A fresh public `/receipt-health`
request returned 200. The physical comparison found **104 of 104 original
physical IDs unchanged**; only the six explicitly added health resources were
new. Receipts: `p2-fresh-health-runtime.json`,
`p2-physical-identity-after-reset.json`, `p2-vpc-reset-independent-review.json`.

The first now-reachable authenticated HTTP upload returned the expected **403
PutObject AccessDenied**, exposing the deliberately missing upload grant.
Malformed JSON and invalid receipt IDs returned 400; missing or malformed tokens
returned 401, and an absent processed object returned 404. An explicitly
administrator-seeded upload canary independently proved actual EventBridge
delivery to the isolated event and S3-gateway write/read behavior. This canary is
not represented as a successful HTTP upload. Evidence:
`p2-live-missing-write.json`.

The developer then used Studio Connect workload to review/apply native
`grantWrite("uploads/*")` for the HTTP role. The actual saved cloud plan
`plan-mvlibism-4c1814` changed only that existing inline policy and metadata;
processed reads, Reader/default trust and mappings, and network placement stayed
unchanged. The lead reviewed/released it and normal GUI Apply completed.
The native CDK write action set includes delete/abort variants; the HTTP grant
is not described as a Put-only policy.

Fresh live requests then returned **HTTP upload 202 → actual isolated event →
authenticated processed read 200**. Fresh original Reader credentials still
read the original `processed/identity-check.json` bytes with 200 and received
403 for Put, Delete and unrelated-prefix Get. The original user remained
CONFIRMED. Sanitized evidence: `p2-live-repaired.json`; credentials and JWTs were
not written to the artifact.

An independent parse of the actual event Lambda configuration and captured EC2
route tables matched both selected subnet associations. Each had the active S3
gateway endpoint route and no IPv4 or IPv6 default route. Together with the real
processed event result, this substantiates the isolated gateway communication
claim. Receipt: `p2-isolated-route-independent-review.json`.

## Actual frontend publication and browser

An earlier frontend review was refused after deployment outputs changed, with
zero uploads. That is a real stale-review refusal, not a successful publication.
A fresh normal GUI build/review then published **two files, zero deletions** to
the exact owned frontend bucket at **22:00:43 UTC**. Invalidation
`ID9YQQUAW9SHWIJV0HXQ3EBN5C` on `ERA0LSZ03BRQE` was initially InProgress;
the lead independently observed **Completed** afterwards. HTTP 200, cache
completion and browser behavior are separate observations. The previous
"Build complete ... no assets ... uploaded" message was absent during and after
publication, independently exercising the root's stale-status repair.

Actual browser use of `https://d3fkk3db6lhnmb.cloudfront.net` proved signed-out
action controls disabled, wrong-password visible error, native successful sign-in
with password input cleared, upload accepted and the processed event record read
with HTTP 200. At 420 × 900 the receipt field → Tab → Tab → Enter sequence
activated Read, and an absent receipt produced a visible HTTP 404 error. Document
width equalled 420; no page overflow was observed. Screenshots:
`p2-cloud-client-desktop.png`, `p2-cloud-client-mobile-error.png`.
Console errors were the absent favicon 403 and deliberately exercised wrong
password 400 / missing-record 404, with no application JavaScript exception.
This small alternate client uses the generated public deployment settings; it
does not claim coverage of the repository's full reference frontend.

The durable publication review/result are under
`.cache/job3/cloud2/.cache/framework-studio/frontend-releases/b3da9e1f-81a7-4ac5-8ff2-eb70634108f5/`.
The independent invalidation receipt is `p2-invalidation-root-check.json`.

## Reviewed original teardown and retained reference

After browser/runtime writes stopped, an independent final inventory observed
eight exact object versions and zero delete markers at **22:02:37 UTC**.
The fresh native teardown review `delete-mvlinj2u-6fd58d139f6c` contained all
eight immutable original StackIds, **26 retained resources**, no blockers,
secrets or left-in-place stacks. The retained set includes the original pool,
client, domain, three native hooks/roles/permissions, Identity configuration,
data bucket and log groups. The lead reviewed the exact saved packet and released
normal typed-name GUI deletion. It began at **22:03:58 UTC**.

The saved packet is
`.cache/job3/cloud2/.cache/framework-studio/teardowns/delete-mvlinj2u-6fd58d139f6c.json`;
independent receipt: `.cache/job3/p2-teardown-independent-review.json`.
Native deletion is allowed to wait for Lambda-managed ENI cleanup. Retained
reference planning requires the actual original Cognito StackId to be deleted;
final original-password authentication and data proof additionally require all
eight immutable original stacks DELETE_COMPLETE. Both gates subsequently passed
as recorded below.

The original immutable Cognito StackId subsequently reached DELETE_COMPLETE.
Only then was its actual public retained-resource ledger copied into the fresh
guarded `recovery2` fixture. Studio's live **Inspect and review reference source**
checked the released original pool, existing client, ownership and dependencies,
and offered an explicit source diff. Saving that diff preserved the original pool,
client and domain; no descriptor was guessed. The old CloudFront URL was copied
from the actual public output solely to preserve client callback compatibility.

Fresh read-only comparison `plan-mvliulgu-bd62cc` contained **two additions, zero
modifications/removals**, exclusively an SSM reference parameter and CDK metadata
in the new `job3-20261023-p2-reuse-1720-CognitoStack`. No IAM, new pool/client,
trigger, frontend or network resource was proposed. After independent lead
review, normal typed-name GUI Apply completed at **22:10:44 UTC**. Actual outputs
say `external-reference` and preserve the original IDs and original-deployment
identity. The new immutable StackId ends
`91ab6490-cf2e-11f1-8fff-0affee1c3383`; full receipt:
`p2-recovery-owned-stack.json`. Plan review receipt:
`.cache/job3/p2-reference-independent-review.json`.

This reference-shell creation is distinct from final sign-in/data recovery.
The memory-only checker remained gated on all eight original immutable StackIds
being DELETE_COMPLETE; the gate and subsequent proof passed as recorded below.

The network wait is not attributed solely to normal automatic cleanup. At
22:12:52 UTC two exact owned interfaces remained available, with
`RequesterManaged:false` and descriptions naming the original HTTP Lambda.
Its execution role had already been removed by normal stack teardown. The
[AWS Lambda VPC guide](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
explains that deleting the creator execution role can prevent automatic ENI
deletion and permits manual cleanup. The lead and IAM specialist independently
checked exact ownership and absence of remaining function/version/mapping use.
After fresh checks before each mutation, the lead performed ordinary deletion
of only those two interfaces at **22:20:20 UTC** and verified both absent. There
was no detach or force action. This was an explicit manual intervention for the
documented role-lifecycle limitation, not seamless automatic teardown. Receipts:
`p2-network-delete-wait.json` and
`.cache/job3/iam-runtime/p2-orphan-eni-delete-result.json`.

CloudFormation then completed the original network and final data-bucket stack.
All **eight immutable original StackIds were DELETE_COMPLETE**, and Studio's
native operation reported Done/deleted. Receipt: `p2-teardown-status.json`;
screenshot: `p2-original-all-stacks-deleted.png`.

Only after that gate, the independent runner invoked the retained-reference
checker with the original identity held in process memory. It completed at
**22:21:32 UTC**, exit zero:

| Actual post-teardown request | Result |
| --- | --- |
| Native password sign-in, original pool/client | 200, original subject `640874e8-a071-70dd-bf8b-c907fff86199` |
| Fresh enhanced Identity credentials, signed STS request | Exact original ReaderRole principal |
| Original `processed/identity-check.json` | 200, SHA-256 `5a9c57689a496674fa31d2c1dc774fdc44e1f99735669572ff51b0ee9a714acd` |
| Reader Put / Delete / unrelated-prefix Get | 403 / 403 / 403 |
| Final original-object reread | 200, identical SHA-256 |

Evidence: `p2-recovery-live.json`. It contains public identities and sanitized
request outcomes; no password, token or temporary credential was persisted.
This proves native user and original scoped data access survived original stack
teardown and were usable through an inspected external reference. It does not
claim CloudFormation import, hosted OAuth or frontend restoration.

The lead conditionally reviewed/released the separate one-stack reference-shell
teardown `delete-mvlj3ktz-5d312a742dc0`. After the successful proof and before its
expiry, the developer typed the exact recovery deployment name into normal GUI
Delete at **22:21:54 UTC**. That operation removes only the SSM reference record
and metadata; the externally referenced original pool/client/domain stay outside
its management. The shell reached actual DELETE_COMPLETE at **22:22:04 UTC**;
both Studio's terminal result and a direct immutable-StackId read verified it.
Evidence: `p2-recovery-shell-deleted.json` and
`p2-recovery-shell-deleted.png`. Final retained-resource cleanup was then
coordinated separately by the lead, as recorded below.

After the lead confirmed no further authentication/data calls were needed, the
owned memory runner wiped the original identity and exited zero. The browser
credential store was cleared and its campaign browser closed. Both original
password files remained absent. Following terminal native teardown results,
exact listener command checks identified and stopped only the owned Studio
processes on 4596 and 4598; absence was verified. The original Studio on 4590
remained listening. Receipts: `p2-owned-studio-stop.json`,
`p2-local-session-cleanup.json`. All earlier owned PostgreSQL/API/runner cleanup
receipts remain separate above; shared Docker resources were preserved.

The independent IAM specialist also inspected the exact union of referenced
bootstrap object keys after final publication: **29 current objects, 540,434
bytes**, all preserved in the shared CDK bootstrap bucket. Of the initial 17
keys, six predated the campaign and 11 were absent before upload; 12 later keys
had no pre-upload baseline. These are current-version object bytes, not an
incremental storage/billing claim or proof of exclusive ownership. No shared
bootstrap object or stack was deleted. Receipt:
`.cache/job3/iam-runtime/shared-bootstrap-residuals-p2-final.json`.

## Final retained-resource cleanup and independent absence

After independently reviewing the frozen helper/inventory and its fresh
preflight, the lead executed only the exact owned retained cleanup. It exited
zero and completed at **22:24:37.221 UTC**, within the two-hour window from
20:55:47. The journal records **29 exact mutations**: original pools and selected
client/domain/group, three retained hooks, five retained authentication roles,
eight exact synthetic object versions and data bucket, and nine surviving owned
log groups. All eleven originally inventoried log groups were absent afterwards.
Pool protection removal preserved the required existing verification settings;
shared IAM managed policies were detached from owned roles and preserved.

The separate independent checker exited zero at **22:25:06.398 UTC**, with no
errors: **29 exact physical absence reads**, including all twelve inventoried
IAM roles and ten Lambda functions. Its 40 total checks also covered the nine
immutable original/reference StackIds being DELETE_COMPLETE and the two baseline
stack identities/statuses/timestamps remaining unchanged. The final active-stack
audit contained exactly `LawstructPlaceholderStack` and `CDKToolkit`.

At **22:25:37 UTC**, the lead's final local audit found zero campaign containers,
volumes, networks or listeners, with original Studio4590 preserved. Earlier
credential/browser/server cleanup is documented above. The remaining shared CDK
bootstrap objects are intentional preserved residuals, with their exact counts
and baseline limits recorded above; no broad prune or shared-stack deletion ran.
No pending execution or cleanup stage remains within this bounded scope.

Final receipts:

- `.cache/job3/iam-runtime/p2-retained-cleanup-result.json`
- `.cache/job3/iam-runtime/p2-physical-absence.json`
- `.cache/job3/aws-active-stacks-final.json`
- `.cache/job3/local-residual-audit-final.json`

## Repository verification

The lead's final full `npm run verify` process exited zero. An independent parse
of its actual `.cache/job3/verify-integrated-final.log` found **1,727 passed,
three opt-in skips and zero failures**: 1,658 Node test passes plus 65 client and
four WebSocket Vitest passes. Receipt:
`p2-independent-final-verify-review.json`. Those offline results are separate
from the actual Docker/PostgreSQL, browser, synth and deployed evidence above.
