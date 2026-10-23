# Isolated development lifecycle — October 23, 2026

The user explicitly approved the reviewed stack apply, invocation and cleanup at
action time. Profile `dev`, account `734849394764`, region `us-east-1`. No production
operation was performed. The source came from the event function created through
Studio's GUI in the disposable app, copied into a minimal diagnostic framework app.
This avoided deploying the checkout's Cognito, replay, database or other workloads.

## Review, apply and invocation

- Target: `studio-20261023-dev`.
- Stack: `studio-20261023-dev-AsynchronousLambdaFunctionsStack`.
- Stack ID: `arn:aws:cloudformation:us-east-1:734849394764:stack/studio-20261023-dev-AsynchronousLambdaFunctionsStack/00349240-ceaf-11f1-8299-0affd1f22c8f`.
- Saved Studio plan: `plan-mvkksh0w-582ceb`, under
  `.cache/studio-campaign-20261023/cloud/.cache/framework-studio/plans/studio-20261023-dev-mvkksgnw-8f93`.
- Review contained one 128 MB arm64 Node.js 24 Lambda, an execution role with the
  standard AWSLambdaBasicExecutionRole managed log policy, a retained 30-day log
  group and CDK metadata. Independent release-agent review preceded application.
- Studio Apply started at `2026-10-23T06:57:07Z`. CloudFormation reached
  `CREATE_COMPLETE` at `06:58:03Z`. The deployment verifier confirmed both ownership
  metadata and the saved template. Framework owner/contract/mode/deployment tags
  were independently read from AWS afterwards.
- Overall result was **export-failed**, with infrastructure verification true.
  The immediate exporter error was missing `LOCAL_API_DEV_SERVER_HOST_PORT` in
  this deliberately minimal app. It also has no Cognito/replay resources to supply
  the normal local-development outputs. Studio showed the infrastructure result
  separately, preserved prior files, and offered export retry; no false client-env
  or application-health success was recorded. Export was not retried after teardown.
- Exact Lambda physical ID was discovered through this stack's resource inventory:
  `studio-20261023-dev-Asynchro-CampaignEvent692AB3C8-1DfhjtyJsuCr`.
- A single real invocation with fake campaign JSON returned status `200`, no
  FunctionError, response `{"message":"Ready"}`. Request ID
  `8b668bd2-5391-4257-a499-9bfb9691f0f5`; platform execution status success.
  Reported billed duration 176 ms, memory 128 MB, maximum used 72 MB.

This proves the non-VPC event Lambda source → reviewed assembly → actual AWS
function → invocation → teardown path. It does not prove API Gateway reachability,
VPC egress, S3/database authorization, local Compose parity, provider login, or
frontend publication. No NAT, VPC endpoint, ECS, RDS, Cognito, DNS or secret was
created in this experiment.

## Ownership and cleanup ledger

| Resource | Ownership evidence | Final observation |
| --- | --- | --- |
| Stack ID above | Absent before run; saved reviewed target; contract-2 deployment tags and metadata; exact stack ARN | Studio typed-name teardown succeeded at `2026-10-23T07:03:14Z`; read-only exact-ID query returned `DELETE_COMPLETE`. |
| Lambda physical ID above | Exact stack logical ID `CampaignEvent692AB3C8` and creation events | `get-function` returned `ResourceNotFoundException`. |
| Role `studio-20261023-dev-Async-CampaignEventServiceRoleA-X7ieApjG8vHE` | Exact stack logical ID `CampaignEventServiceRoleADD6BE66` | `get-role` returned `NoSuchEntity`. |
| `/aws/lambda/studio-20261023-dev-Asynchro-CampaignEvent692AB3C8-1DfhjtyJsuCr` | Stack logical ID `CampaignEventLogGroup128E2780`; retained resource inventory; fresh tags matched owner, target and exact stack ARN | CloudFormation retained it as reviewed. Lead rechecked tags, explicitly deleted this exact group under the approved cleanup, and confirmed exact-prefix inventory `[]`. |
| SSM `/framework/deployments/studio-20261023-dev` | Framework's target-bound record | Read-only metadata request returned `ParameterNotFound` after teardown. |
| Shared bootstrap bucket `cdk-hnb659fds-assets-734849394764-us-east-1` | Preexisting CDKToolkit-owned/shared resource | Bucket unchanged. Two exact artifact objects below remain; no bucket sweep/version purge was attempted. |
| Existing `LawstructPlaceholderStack`, `CDKToolkit` | Preexisting account inventory, outside run ownership | Preserved. |

Bootstrap residuals, read from the saved asset manifest and exact expected-owner
HeadObject requests after teardown:

| Object key | Bytes | Observed version | Last modified |
| --- | ---: | --- | --- |
| `30421270f421d9c437a12087e4c0c2340c579166f61f207bbaa6b0c837104596.zip` | 889 | `4MlLH_2uYpr6bEOMpzkLVywNUAEtylVh` | `2026-10-23T06:57:24Z` |
| `af6b13d3cd36482488988ca46050a36b9bd2cc98167bd7498bff7228e1d56747.json` | 4,199 | `CvepkgkoxVR6g_iYLdgMA0pQpdISQ.BC` | `2026-10-23T06:57:24Z` |

These 5,088 bytes are intentionally retained in the shared content-addressed
bootstrap store. Publication receipts and timing correspond to this deployment,
but pre-upload object/version exclusivity was not captured; deleting by a matching
hash/name alone would exceed the cleanup ownership proof. Their storage and any
previous versions can continue accruing ordinary S3 charges. No recurring campaign
compute, IAM role or log group remains. There were Lambda/request/log/asset/API
usage effects; no claim of zero charges or free-tier eligibility is made. Current
[Lambda pricing](https://aws.amazon.com/lambda/pricing/) and
[S3 pricing](https://aws.amazon.com/s3/pricing/) govern usage; final billing was not
retrieved.

## Evidence files

All paths are under ignored `.cache/studio-campaign-20261023/`:

- `dev-review.png`, `dev-deployed.png`, `dev-stack.json`, `dev-resources.json`.
- `invoke-event.json`, `invoke-response.json`, `invoke-metadata.json` (includes
  the base64 platform execution log).
- `retained-log-tags.json`, `lambda-cleanup-check.log`, `role-cleanup-check.log`,
  `record-cleanup-check.log`.
- Cloud fixture `jobs/mvkmahtu-c78427.log` for actual deploy/verification/export
  failure and `jobs/mvkmhlel-1bfa62.log` for teardown.
- Cloud fixture `teardowns/delete-mvkmfqvq-9ecccdf5dd94.json.result.json` for the
  exact successful deletion receipt.

The Studio screenshots/logs show infrastructure and subsequent export outcomes
separately. The Lambda result is CLI/AWS execution evidence; no browser endpoint
or application sign-in is inferred from it.
