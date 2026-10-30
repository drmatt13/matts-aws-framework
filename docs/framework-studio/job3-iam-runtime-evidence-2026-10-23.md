# Job 3 IAM and runtime integration evidence — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

This specialist record separates source/synthesis evidence from live AWS results.
The campaign lead owns AWS mutations, cleanup and the consolidated two-pass report.
No cloud resource was created, changed or deleted by this specialist.

## Destination and source ownership

- Profile: `dev`; lead verified account `734849394764`, region `us-east-1`.
- Exact disposable namespace: `job3-20261023-p1-1608`.
- Isolated source fixture: `.cache/job3/cloud1`.
- Application graph: `prod`, used exclusively for the authorized disposable
  development destination. This does not authorize the existing production target.
- The framework deliberately omits routed HTTP workloads and VPC infrastructure
  from its `dev` graph. Calling a `dev` synth a live VPC test would be incorrect.
- Source lease: this specialist built the composition/native IAM/network fixture;
  the Studio specialist owns `.cache/job3-pass1`; the lead owns cloud mutation,
  fixture frontend configuration and publication.

The actual Studio GUI created and applied the authenticated `/job3-http`,
`job3-event`, private `Job3StorageStack.bucket`, its HTTP read connection and its
S3 notification trigger in `.cache/job3-pass1`. The isolated cloud fixture copies
those artifacts. Deliberate code-first additions supply two diagnostic routes,
network placement, native pool/identity composition and log instrumentation.
The cloud event connection changes the GUI's notification delivery to EventBridge
and explicitly enables it on the bucket. This is a documented code-first
continuation; the GUI itself did not author the final EventBridge choice.

## Offline evidence

| Identity | Classification | Observed result | Evidence |
| --- | --- | --- | --- |
| IAM-RUNTIME-01 | Existing tests; source/synth and injected AWS runner | 49/49 pass, 6.6 seconds | `.cache/job3/iam-runtime/focused-initial.log` |
| IAM-RUNTIME-02 | New native bucket integration regression | 5/5 identity-pool tests pass | `.cache/job3/iam-runtime/native-bucket-regression.log` |
| IAM-RUNTIME-03 | Real bundled CDK synthesis; no AWS writes | Exact isolated target synthesizes all eight stacks | `.cache/job3/iam-runtime/fixture-synth-initial.log` |
| IAM-RUNTIME-04 | Assertions on actual assembly templates | Required event rule, scoped invoke grant, native pool flow, no prohibited infrastructure | `.cache/job3/iam-runtime/fixture-inventory.json` |

IAM-RUNTIME-01 command:

```sh
node --conditions=development --import tsx --test \
  framework-studio/test/identity-policy.test.ts \
  framework-studio/test/identity-diagnostics.test.ts \
  framework-studio/test/cognito-reference-observation.test.ts \
  framework-studio/test/network-validation.test.ts \
  cdk-app/test/identity-pool-access.test.ts \
  cdk-app/test/native-resources.test.ts \
  cdk-app/test/network.test.ts \
  cdk-app/test/network-region.test.ts
```

The suite establishes separate environment delivery and native grants, saved-source
IAM simulation limitations, explicit/implicit deny reporting through an injected
runner, wrong-account refusal, stale source invalidation, native Cognito trust,
guest defaults and network template contracts. Its IAM result rows are not live
S3 requests, credential issuance or evidence of deployed group-role selection.

Bundled fixture synthesis command, from `.cache/job3/cloud1/cdk-app`:

```sh
node ../node_modules/aws-cdk/bin/cdk synth \
  -c prodDeployment=true -c deployment=job3-20261023-p1-1608 \
  --quiet --no-lookups --output ../output/job3-synth
```

The final complete command exited 0. An earlier packet omitted registration of
the imported GUI event; independent lead review and explicit function/rule counts
caught it before any deployment. The final assembly requires four event Lambdas,
one EventBridge rule and its scoped invocation permission. A merely successful
synth without those inventory assertions was insufficient acceptance evidence.

## Repaired integration defect

`identityPoolAccess({ readBucketArn: bucket.bucketArn })` rejected a freshly
created native S3 bucket because its ARN is a CDK token. That forced a caller to
duplicate the bucket identity as a literal ARN instead of preserving the native
resource reference.

The helper now accepts unresolved native CDK references while preserving visible
wildcard/control-character refusal and concrete-literal ARN checks. It leaves
pool-scoped trust, guest defaults and default-role permissions unchanged. The
Studio editor still accepts its bounded literal shapes; it does not evaluate
arbitrary expressions.

The regression synthesizes a real native bucket and asserts an exact
`Fn::GetAtt(Arn)` plus `/tenant/*` ReaderRole `s3:GetObject` grant, with no
write/delete/list permissions. A wildcard suffix remains rejected. Both the lead
and database/lifecycle specialist reviewed this patch independently and found no
blocker. Unresolved trusted native source cannot prove the final ARN's kind or
shape; acceptance is native CDK authoring support, not a new policy analysis claim.

Changed product files:

- `cdk-app/lib/app/identity-pool-access.ts`
- `cdk-app/test/identity-pool-access.test.ts`
- `docs/aws-studio-knowledge/studio/authentication.md`

Independent GUI testing also found that discarding rejected local policy edits
restored the saved form while leaving the old validation error visible.
`IdentityPolicyEditor.loadSource` now clears validation and simulation evidence
for both a real saved source and an unavailable source. The regression in
`framework-studio/test/cognito-workspace-ui.test.ts` failed at the exact stale
alert before the fix (`.cache/job3/iam-runtime/policy-discard-before.log`). It
checks that discard restores saved actions/resources, clears the error, leaves
no source proposal and preserves the saved source. Independent browser replay
and the integrated final gate are owned by the lead and Studio specialist.

## Runtime experiment packet

The final assembly contains eight owned stacks, eleven Lambda functions
(seven application handlers and four supporting functions), thirteen IAM roles,
two private S3 buckets, one public native pool/client, one Identity Pool, one
reader group, one HTTP API, one CloudFront distribution, one CloudFront KVS,
one VPC, six subnets, one S3 gateway endpoint and one shared workload security
group. There are no NAT gateways, Elastic IPs, paid interface endpoints, RDS
instances or ECS services. Two-zone/six-subnet layout is the current framework
minimum even when no database is declared.

The custom entrypoint refuses any account, region, namespace or graph outside
this exact target. Every stack receives the normal framework identity metadata,
tags and deployment output through `finalizeFrameworkResources`. The existing
Cognito and frontend stack classes preserve normal exporter output names.

| Runtime surface | Intended meaningful observation |
| --- | --- |
| `/job3-http` | Original GUI authenticated handler returns the verified user subject |
| `/job3-vpc?operation=read` | Isolated function initially has `wrong/*` read grant, so intended `allowed/read.json` fails authorization |
| Corrected VPC read connection and redeployment | `allowed/*` grants successful actual S3 read through gateway endpoint |
| `/job3-vpc?operation=network` | Regional STS HTTPS request times out because no route/STS endpoint exists; distinguishes S3 reachability from general egress |
| `/job3-diagnostic?operation=read` | Separate non-VPC principal has intended read grant |
| `operation=unrelated` | Prefix outside the read grant is implicitly denied |
| `operation=delete` | Deletion is implicitly denied; verify original object survives |
| `operation=put` | Identity allow for one exact probe key is overridden by bucket-policy explicit Deny |
| `operation=absent` | Distinguish absent allowed-prefix object from missing IAM permission |
| `operation=invalid` | Bounded malformed request returns HTTP 400 |
| `events/*` upload | Actual S3 EventBridge delivery reaches `job3-event`, logs campaign/event evidence |
| Native password login | Existing Cognito public client includes `ALLOW_USER_PASSWORD_AUTH`, without a client secret |
| Identity Pool exchange | Group role gets only `allowed/*` object reads; writes/deletes/unrelated prefix fail |
| Missing/equal-precedence conflicting role claims | Observe actual credential failure/default behavior separately from IAM request evaluation |

The isolated handler trusts the HTTP API's JWT authorizer. It does not perform a
public JWKS fetch from an isolated subnet. It accepts only fixed synthetic S3
keys and bounded operations, and uses `useDualstackEndpoint: false`. Function
ARNs in responses identify the workload; execution-role ARNs come from stack
outputs and must not be mislabeled as user identities.

Actual template inspection shows native CDK `bucket.grantRead("allowed/*")`
also grants bucket-level `s3:GetBucket*` and `s3:List*`, with `s3:GetObject*`
scoped to the object prefix. Its native `grantPut` carries tagging/retention/abort
actions on the exact probe key as well as `s3:PutObject`. The fixture's Lambda
grants must therefore not be described as object-read-only or no-list grants.
The Identity Pool ReaderRole is separately exact `s3:GetObject` on `allowed/*`,
with no list/write/delete policy. This difference is an actual native CDK grant
semantic, not evidence that the source graph computed effective IAM access.

Key outputs are `HttpApiUrl`, `Job3ApiUrl`, `UserPoolId`, `UserPoolClientId`,
`UserPoolDomainUrl`, `CampaignBucketName`, `IdentityPoolId`, `ReaderRoleArn`,
`DefaultRoleArn` and `Job3lambdajob3{http,vpc,diagnostic,event}Name`/`RoleArn`.
Reader group name is `job3-reader`.

## Friction and boundaries found during composition

1. `tsx` CLI attempted a sandbox-disallowed local IPC socket. The fixture's CDK
   app command uses `node --import tsx bin/job3-app.ts`; normal bundling succeeds.
2. Every workload needs its own directory. Sharing one implementation directory
   between two target IDs fails early with named declaration context. Wrapper
   entries now import the common diagnostic implementation.
3. The S3 trigger adapter deliberately refuses L2 `eventBridgeEnabled: true`
   because CDK owns that configuration through an unclassified custom resource.
   The documented native L1 `CfnBucket.notificationConfiguration` form succeeds
   without a notification custom resource. This is an existing supported-boundary
   friction, not a newly fixed product behavior or a claim that arbitrary native
   notification configuration can be merged safely.
4. A graph source edge does not establish IAM access or deployed infrastructure.
   The fixture's initial wrong-prefix connection is intentionally connected in
   source while the intended operation must fail until correction and deployment.
5. Independent mobile GUI testing rejected wildcard administration correctly, but
   its refusal alert remained after **Discard local policy edits** reset the
   unsaved form. The lead reopened this exact source lease, and the shared saved
   source reset now clears the obsolete alert as described above.

The native identity trust contract matches AWS's documented pool audience plus
authenticated `amr` conditions; ambiguous role mapping uses `Deny`.
[Role mapping](https://docs.aws.amazon.com/cognito/latest/developerguide/role-based-access-control.html).
An S3 gateway endpoint requires no NAT and carries no additional endpoint charge;
S3 operations, storage and other service usage remain billable.
[S3 gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html).

## Cost, cleanup and outstanding proof

There is no hourly NAT, paid interface endpoint, database or container compute
in the packet. Expected usage charges come from small S3 objects/requests,
Lambda invocations, API calls, Cognito usage, EventBridge, CloudFront/functions/KVS
and log storage. This record does not contain a measured bill or claim the
campaign is free. Resource-specific cost and bounded request/time ownership is
part of the lead's deployment ledger.

The GUI-created data bucket intentionally retains on stack deletion and requires
ownership-verified empty/delete cleanup after evidence capture. The website bucket
uses its existing stack's auto-delete mechanism. If Cognito retention is enabled,
its pool/client/domain/invoke grants survive, but separate trigger functions,
groups and Identity Pool mappings must be retained or reconciled explicitly.
No bootstrap environment may be pruned for this experiment.

The initial fixture synth established template behavior only. Both full-stack
passes subsequently completed live deployment, permitted/denied AWS requests,
Cognito login, Identity Pool exchange, network execution, recovery and cleanup;
their actual evidence follows below and in the consolidated campaign report.
The lead completed the final integrated `npm run verify` and explicit baseline
dev/prod synths; those checks were intentionally not duplicated by this specialist.

## Subsequent independent execution

The policy-discard fix passed the complete Cognito workspace component suite,
15/15, in `.cache/job3/iam-runtime/policy-discard-after.log`. The Studio specialist
independently verified the real UI at 1440×1000 and 420×900: wildcard refusal,
discard clears the alert and unsaved form, saved source SHA256 unchanged, local
GET requests only, and no console warnings/errors. Evidence:
`.cache/job3/studio/iam-discard-independent.json`.

After the user explicitly approved the previously rejected normal runner Docker
socket boundary, this specialist executed the real local HTTP → declared
`startWorkflow` → event Node handler → PostgreSQL insert → terminal completion.
Idempotence, denied caller/config overrides, SQL constraint failure, missing
runner dependency and restart recovery all produced actual expected outcomes.
Two exact campaign runtime containers were removed after ownership inspection;
the database remained under its owner's independent cleanup lease. The full
operation/approval/cleanup table is appended to
[database evidence](job3-database-evidence-2026-10-23.md). This proves the local
workflow/event lane, not a container task or AWS service execution.

An ignored retention helper and fresh reference shell were prepared without AWS
writes. The normal pre-finalization retention preview synthesizes the exact
original three hook Functions/roles/logs, IdentityPool/group/roles/policy/attachment,
and the native Cognito pool/client/domain/invoke permissions. All logical IDs
remain stable. Eighteen resources gain Retain; the data bucket and eight log
groups already retained independently. No new retention is applied to the
application event, HTTP, VPC or frontend. Review artifacts:
`.cache/job3/iam-runtime/retention-reviewed-resources.json` and
`.cache/job3/iam-runtime/retention-recovery-packet.md`.

The `.cache/job3/recovery1` reference shell intentionally contains no guessed
pool/client IDs. Its initial synth refuses the absent inspected source descriptor
before constructing a stack. The lead subsequently completed actual retained
discovery, reviewed reference source, same-user authentication, Identity Pool
access and final cloud cleanup; the consolidated campaign report owns that
execution evidence.

The lead subsequently requested an independent read of the already uploaded S3
trigger object's CloudWatch evidence. The collector originally missed the event
because Lambda JSON logging stored the application's JSON as a string in the
outer `message`. The repaired ignored collector parses both layers and verifies
the exact campaign/account/region, `aws.s3`/`Object Created` EventBridge shape,
bucket/key, `PutObject` reason and immutable original bucket StackId. It found
event `1f1ad760-2f2f-4c24-42d4-e903110cd7ae`, Lambda request
`21a942e8-76bf-4f31-8972-8291eafb998f`, from 20:40:49 UTC. No new object was
uploaded. Actual proof is saved in
`.cache/job3/job3-20261023-p1-1608/event-trigger-evidence.json`.

An independent read-only inventory confirmed eight exact owned cloud1 StackIds,
eleven actual Lambda functions, twelve actual log groups, five retained auth
roles, the original pool/client/group/IdentityPool, and three synthetic current
S3 versions (the two data records plus the existing trigger object). Actual
physical identities, tags, IAM RoleIds/policies, log creation times and object
ETags/versions are recorded in
`.cache/job3/iam-runtime/cloud-owned-inventory.json`. A syntax-checked guarded
cleanup packet is prepared in `cloud1-final-cleanup-packet.md`; it defaults to
an offline plan and has not deleted resources. The lead owns readiness after
retention, reference validation and both reviewed teardowns.

The manually assembled disposable cloud fixture initially retained unused copied
application modules and implementations, which made its normal source review
typecheck/generator fail despite synthesis passing. Those unused copies were
archived outside the fixture's compiler roots, the common native hook helper was
moved outside workload discovery, and module types were corrected without adding
resources/grants. Normal generation, generated-artifact checks, local contract
checks, CDK typecheck and Studio's exact `resourceTypeErrors` preflight all then
passed. This was a campaign fixture assembly error, not evidence of a failure
in the original working application or a new product behavior.


## Lead-observed live AWS proof

The lead subsequently applied saved plan `plan-mvlf1iqz-ed5427` through Studio
for `job3-20261023-p1-1608`, profile `dev`, account `734849394764`, `us-east-1`.
All eight stacks verified and the deployment result was `succeeded` at
2026-10-23T20:39:01.915Z. This is the production graph used exclusively for a
fresh disposable development destination, not an existing production release.

Actual signed/authenticated requests observed:

- Native Cognito password authentication issued an ID token. Missing and invalid
  bearer tokens returned HTTP401; the valid token reached the authenticated
  GUI-created HTTP handler and returned200/Ready with the synthetic user subject.
- Non-VPC Lambda read `allowed/read.json` (200). Actual `PutObject` on
  `allowed/write-probe.json` returned403 despite its source Allow, because the
  bucket's explicit Deny overrides it. Delete and unrelated-prefix reads returned403.
  A missing allowed-prefix object returned404/NoSuchKey; invalid operation400.
- The VPC function's initial `wrong/*` grant produced an actual S3
  AccessDenied403/request ID. That establishes communication with S3 through its
  gateway endpoint as well as a permission failure; it is not merely attachment.
  The same isolated VPC function's public STS fetch timed out/504; the non-VPC
  control reached STS/200. No NAT or interface endpoint was introduced.
- With no group claim, `GetCredentialsForIdentity` returned
  `NotAuthorizedException`: the configured ambiguous role mapping denied the
  request. This is a fail-closed credential boundary, not issued permissionless
  credentials or an IAM resource request from the default role.
- After synthetic group assignment and fresh authentication, credentials were
  issued for the actual ReaderRole ARN. The assumed role was independently read
  from signed STS. It read the intended object200, received actual S3
  AccessDenied403 for write/delete/unrelated prefix, then read the original object
  again200. The default and reader roles were not widened to obtain success.
- The exact event Lambda's direct invocation returned200/Ready. Uploading one
  unique `events/` object produced a matching CloudWatch invocation log through
  its deployed S3/EventBridge rule. The lead owns full payload/trigger evidence.

Raw evidence is under `.cache/job3/`: `cloud-auth-initial.log`,
`cloud-auth-group.log`, `cloud-runtime.log`, and
`job3-20261023-p1-1608/{auth-evidence,runtime-evidence,owned-stacks,outputs}.json`.
Passwords, ID/access tokens and temporary credentials are never persisted in these
records. The lead subsequently completed the original-password recovery test
in memory after retained teardown and reference deployment. Permission repair,
frontend publication, retention/reuse and final cleanup were completed as separate
stages, with evidence owned by the consolidated report.

The lead's reviewed retention and permission update finished successfully at
21:05:33.514 UTC (`plan-mvlgf01y-2f1e7d`). Independent read-only inspection at
21:08:38.748 UTC, before the reviewed teardown started, confirmed all 120 original
CloudFormation physical IDs remained unchanged, the exact eighteen planned
resources gained Retain, and the native Cognito pool had deletion protection
ACTIVE. The VPC handler policy contained `allowed/*` and no longer contained
`wrong/*`. The saved actual deployed templates and comparisons are in
`.cache/job3/iam-runtime/deployed-retention-receipt.json`.

Read-only `HeadObject` inspection of the union of the original and update P1
publication manifests found 26 current object versions totaling 473,229 bytes in
the shared CDK bootstrap bucket. Exact keys, current version IDs, sizes, ETags and
last-modified times are recorded in
`.cache/job3/iam-runtime/shared-bootstrap-residuals-p1.json`; all were preserved.
Manifest inclusion does not prove Job3 first created an object: several observed
objects predate this campaign. Historical versions and the total shared bucket
size were not inventoried, and the recorded bytes are not an incremental billing
claim or authorization to remove shared assets. Reference deployment and final
owned-resource cleanup were subsequently completed by the lead.

For the independent P2 app, a separate exact-target helper and offline preview
were prepared under `cloud2` without changing its active entrypoint, policy or
handlers. The helper selects only P2's three original native hooks and exact
ReceiptIdentityStack. Its normal bundled preview retained eighteen additional
resources with 104 logical IDs stable; a contemporaneous normal synth comparison
showed only removal policies, UserPool deletion protection and CDK analytics
changed. The exact pool-scoped invoke permissions were preserved. P2's seven
preexisting retained resources were recorded separately. This is offline evidence,
not proof that the DB agent applied or verified retention in AWS.

The separate `recovery2` shell is guarded to
`job3-20261023-p2-reuse-1720` in the same development account/region and constructs
only the native reference manifest after inspection. It contains no copied
original IDs, descriptor, retained ledger or credentials. Normal generation,
framework checks and CDK typecheck passed; synth intentionally refused the absent
inspected reference before stack construction. Both P2 helper/preview typecheck
and synthesis passed. The handoff is
`.cache/job3/iam-runtime/p2-retention-recovery-packet.md`; actual deployment,
retained release, same-user authentication and cleanup were subsequently
completed by the DB agent and lead, with terminal evidence below.

A final read-only local Docker residual check found zero images and zero
containers carrying the exact original Job3 runtime project/campaign labels.
The original and P2 database project container lists were also empty. The shared
API image used by the runtime fixture predates Job3 (2026-10-12, logical image
size 2,268,971,410 bytes), as does the shared PostgreSQL16 image (2026-10-06,
473,971,245 bytes). Both were preserved; neither is claimed as campaign-owned
unused disk. Exact IDs, labels, CreatedAt provenance and commands are in
`.cache/job3/iam-runtime/local-image-residuals.json`. No image deletion/pruning,
build or pull ran. Shared layers and BuildKit caches were not measured, so these
logical sizes are not incremental disk-usage or reclaimable-space claims.

Independent source review of the lead's one-line FrontendRelease transient
message reset found no blocker. The next action now clears the earlier
build-only “no assets uploaded” status before awaiting publication or another
action, while existing busy/result/error/history and approval behavior remain
intact. Source hash and exact reviewed patch are saved in
`.cache/job3/iam-runtime/frontend-release-status-review.json`; focused tests,
build, full verify and real P2 publication browser evidence are separately owned
by the lead and DB agent.

The independent P2 deployment then exposed a product defect while moving an
existing IPv6-enabled HTTP Lambda out of its VPC: CloudFormation rolled back
because the omitted VpcConfig left IPv6 enabled without subnets/security groups.
The central framework Lambda factory now explicitly synthesizes empty subnet
and security-group lists with IPv6 false whenever placement is absent, across
Node/Python zip and container paths. Placed functions and construct identities
remain unchanged. This is framework-owned behavior, with no application CDK
override or new IAM permission. Primary AWS documentation and the actual failure
path are recorded in `.cache/job3/iam-runtime/lambda-detach-review.md`.

Four new factory regressions and fifteen existing network tests passed, as did
CDK typecheck and knowledge validation. The full CDK suite reported 275 tests:
274 passed, zero failed and one opt-in live test skipped. An initial sandbox run's four
failures were all tsx local IPC EPERM errors; the escalated full run passed
unchanged. Evidence is `lambda-detach-final-focused.log`,
`lambda-detach-typecheck.log` and `lambda-detach-full-cdk-escalated.log` under
the IAM runtime cache. The lead independently reviewed the factory correction.

Independent read-only review of P2's repaired saved plan
`plan-mvlhswia-1e9d01` confirmed all 104 original logical IDs plus six health-only
additions, unchanged original role trust/scoped inline policies/client/Identity
Pool/group/mapping properties, and the correct explicit reset on existing HTTP,
native hooks and fresh health Function. The event remains in its isolated VPC.
There is no upload write-grant repair in this plan. This is saved-template proof;
the lead and DB agent subsequently verified the actual existing-function update,
fresh creation, physical identity and runtime behavior. See
`.cache/job3/iam-runtime/p2-detach-plan-review.json`.

The lead completed exact P1 retained cleanup at 21:55:39.186 UTC. The first
attempt completed four removals before a pool-update prerequisite stopped it;
the separately reviewed continuation completed 26 mutations. Its final receipt,
`.cache/job3/iam-runtime/cloud1-retained-cleanup-continuation-result.json`, verifies
the original pool, IdentityPool, data bucket, all eleven original Functions,
five retained roles and twelve inventoried log groups absent. This is the lead's
completed cleanup/post-verification evidence. The independent broader checker
for all thirteen original IAM roles, frontend/CloudFront/API/VPC, immutable stack
histories and preserved baseline stacks also completed successfully, as recorded
below.

Cleanup exposed two service details now carried into the P2 packet: retention
can remove reserved S3 CloudFormation tags, so exact original immutable stack
history and the exact Bucket logical/physical identity with DELETE_SKIPPED must
corroborate surviving framework tags. Also, disabling native pool deletion
protection must preserve the required AutoVerifiedAttributes and
UserAttributeUpdateSettings, plus existing trigger configuration. Cleanup
continuations require fresh inspection and separate review; an interrupted
packet is not replayed blindly. Shared bootstrap resources and objects remain
outside owned-resource deletion scope.

The independent P1 physical-absence checker subsequently completed at
21:56:27.652 UTC with exit0/`ok:true`: all 31 exact physical reads confirmed
absence, including all thirteen original IAM roles, CloudFront, frontend/data
buckets, HTTP API, VPC, Functions and pools. All nine immutable stack histories
(eight original plus reference shell) were DELETE_COMPLETE. The two unrelated
baseline stacks, LawstructPlaceholderStack and CDKToolkit, retained their exact
original StackIds, statuses, creation times and update times. Evidence is
`.cache/job3/iam-runtime/p1-physical-absence.json`. The lead also stopped the
verified campaign Studio4595 process and closed its campaign Chrome pages,
preserving the user's original4590 server.

After reference-shell publication and owned-resource cleanup, the final P1
shared bootstrap ledger contains 27 exact current objects totaling 476,880
bytes, including one additional reference-shell template. Each was independently
read with HeadObject/ExpectedBucketOwner and preserved. This supersedes the
earlier pre-reference count for final residual reporting without erasing that
historical receipt. Exact keys/versions/ETags/times are in
`.cache/job3/iam-runtime/shared-bootstrap-residuals-p1-final.json`. Historical
versions, first-creation ownership and incremental billing were not established;
these shared objects remain deliberately outside deletion scope.

P2's final read-only infrastructure/policy inventory completed at22:00:54 UTC:
all eight stacks stable, 110 resources including six Health additions, all104
original physical IDs unchanged, ten Functions, eleven actual logs and five
retained authentication roles. Actual Cognito/Identity templates each retained
their six native resources and pool protection was ACTIVE. After the DB agent
confirmed all browser/runtime writes settled, the exact S3 guard was refreshed
at22:02:37.412 UTC: eight current synthetic versions, no delete markers, stable
stack timestamps. Source is `.cache/job3/iam-runtime/p2-final-owned-inventory.json`.

The lead independently reviewed and froze the P2 cleanup helper and this final
inventory. Its exact guards include P1's reserved-tag/DELETE_SKIPPED proof and
required pool attributes. Original teardown, released-pool inspection,
original-user reference proof, reference teardown and lead-released cleanup
subsequently completed as distinct steps. The reviewed handoff is
`.cache/job3/iam-runtime/p2-final-cleanup-packet.md`; the read-only P2 absence
checker ran successfully using the actual immutable reference StackId.

P2's actual reference shell completed through normal GUI Apply at22:10:44 UTC.
Independent read-only inspection found exactly one SSM reference parameter and
CDK metadata, original pool/client/domain outputs, external-reference ownership,
and no new Cognito, Identity, IAM, Lambda, VPC or frontend resources. Its actual
immutable StackId is
`arn:aws:cloudformation:us-east-1:734849394764:stack/job3-20261023-p2-reuse-1720-CognitoStack/91ab6490-cf2e-11f1-8fff-0affee1c3383`.
This metadata inspection is `.cache/job3/iam-runtime/p2-reference-deployed-review.json`;
it does not itself prove authentication or transfer ownership of retained resources.

After reference publication, the final read-only P2 shared bootstrap ledger at
22:11:49.842 UTC found all29 exact manifest candidate keys currently present,
totaling540,434 current-version bytes. Six initial candidates were already
present in the before observation, eleven initial candidates were absent then,
and twelve later keys have no before observation. These objects, their versions
and the shared bootstrap resources were preserved. The exact ledger is
`.cache/job3/iam-runtime/shared-bootstrap-residuals-p2-final.json`. Candidate
manifests include partial/unapplied plans; current HeadObject presence is the
storage evidence. Historical versions, exclusive ownership and incremental
billing are unverified, and P1/P2 totals overlap rather than being additive.

P2 native teardown exposed an operational Lambda role-lifecycle limitation:
two Hyperplane interfaces remained after the creating HTTP role and the later
shared event role were removed. Independent read-only checks at22:16:12.910 UTC
proved both exact interfaces belonged to the uniquely owned VPC/subnets/security
group and original immutable CloudFormation network resources, had the original
HTTP creator description, and were available, unattached and not requester
managed. No regional Lambda function/version or event-source mapping referenced
the network, and the original HTTP/event Functions and execution roles were
absent. Raw RequesterId was recorded; direct equality with the deleted role's
uncaptured RoleId is not claimed. Evidence is
`.cache/job3/iam-runtime/p2-orphan-eni-proof.json`.

The lead independently reviewed the exact ordinary-delete packet, repeated its
ownership/no-use checks, and removed only `eni-0d2f38983c97fc1ff` and
`eni-0b0c18701b479441c`. Both absence checks passed at22:20:20.557 UTC. No detach,
force, role/policy changes or broader network cleanup was used. Actual actions
are in `.cache/job3/iam-runtime/p2-orphan-eni-delete-result.json` and its journal.
AWS documents that Lambda needs its execution role to delete unused interfaces
and supports manual deletion when that role was deleted first; see the
[Hyperplane ENI lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html).
The explicit no-VPC factory correction enables a valid function update; it is
not a universal automatic interface-cleanup fix. The canonical resources/CDK
guide records the separate teardown role-lifecycle caveat.

After all eight original immutable stack histories were DELETE_COMPLETE, the
DB agent executed the prepared memory-only recovery checker. At22:21:32.037 UTC,
native password sign-in succeeded against the original pool/client with the
same original subject; fresh Identity credentials assumed the original Reader
role; the retained object matched its original SHA256 before and after actual
403 responses for PutObject, DeleteObject and unrelated-prefix GetObject.
Sanitized evidence is `.cache/job3/database/p2-recovery-live.json`; no passwords,
tokens or temporary credentials were persisted by this checker. This proves
retained native identity and scoped IAM continuity, while a rebuilt hosted OAuth
frontend journey remains outside this reference-shell check. Reference teardown
and final retained-resource cleanup subsequently completed as recorded below.

The exact P2 reference shell was DELETE_COMPLETE at22:22:48 UTC, verified in
`.cache/job3/database/p2-recovery-shell-deleted.json`. The lead then executed
the independently reviewed, frozen retained-cleanup packet. It completed at
22:24:37.221 UTC with exit0 and29 recorded mutations, removing the retained
IdentityPool, group/domain/client/pool, three native hooks, five retained roles,
eight exact synthetic object versions and the data bucket, plus the surviving
owned logs. Its post-verification confirmed all eleven inventoried log groups
absent, including those already removed by normal stack teardown. Actual receipt:
`.cache/job3/iam-runtime/p2-retained-cleanup-result.json`.

The independent read-only P2 physical checker completed at22:25:06.398 UTC with
exit0, `ok:true`, no errors and29 exact physical-absence reads, including all
twelve original IAM roles and ten Functions. The original eight immutable stacks
and actual reference shell were DELETE_COMPLETE. CloudFront, frontend/data
buckets, HTTP API, VPC and both pools were absent. LawstructPlaceholderStack and
CDKToolkit preserved their original StackIds, statuses, creation times and update
times. Evidence is `.cache/job3/iam-runtime/p2-physical-absence.json`.

The lead's final active-stack inventory contained exactly the two original
baseline stacks. Its final local audit found zero campaign containers, volumes,
networks or listening ports, while preserving the user's original Studio4590
server. The campaign's executed-scope cleanup is complete. Shared bootstrap
objects and shared local images were deliberately preserved: the deduplicated
P1/P2 ledger records52 observed current keys and780,510 bytes, with four shared
keys whose observed versions did not change. This is a union of observations at
different times, not a simultaneous account-wide inventory or incremental cost
claim. Exact ledger:
`.cache/job3/iam-runtime/shared-bootstrap-residuals-job3-union.json`.

The lead's final integrated verify completed successfully with1727 passed,
three skipped and zero failed tests. The explicit dev/prod synths also passed.
Offline checks, real browser, local database/runtime and deployed AWS evidence
are reported separately above and in the consolidated report; shared historical
asset versions and a rebuilt hosted OAuth frontend remain bounded unverified
areas, rather than unfinished campaign cleanup.
