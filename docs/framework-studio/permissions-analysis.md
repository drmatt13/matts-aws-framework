# Permissions and connection semantics

Repository investigation, 26 October 2026, followed by source-graph implementation.
The inventory and gaps below describe the baseline inspected before that implementation.
This work describes IAM intent; it does not establish effective access in an AWS account.

## Implemented source experience

- [Typed permission facts](../../framework-studio/shared/permissions.ts) derive from
  normalized bindings and recognized adapter evidence. They distinguish principals,
  policy kinds, known actions, native helper expansion, symbolic scopes/conditions,
  local execution, cloud intent not built in the viewed graph and user-token paths.
- Database login, secret delivery, ECS launch/PassRole, workflow calls/waits/callbacks,
  integration helpers/HTTP bindings, Agent Runtime/Gateway/tools, supported triggers,
  declared failure queues/destinations, schedules, replay, API integrations/authorizers,
  WebSocket management and explicit workload policies have shared explanations.
- Connection hover, inspector, aggregate members and workload Permissions reuse those
  facts as supporting information. Purpose titles and authored member labels remain primary;
  single-connection hovers append a compact IAM note without an AWS-only suffix. Inspectors
  disclose full Permissions and source Configuration on demand; resource previews omit
  IAM counts. Four map filters cover Routes, Environment and secrets, Resource access,
  and Calls and events. Structural links appear in selected/previewed context without a
  background filter. Empty categories are hidden; bundles match any
  member's category across both environments. Selected resources retain full context.
- [Connection presentation](../../framework-studio/src/connection-presentation.ts) explains
  database bindings as connection settings, networking and IAM login, with separate local
  wording. Database provider links, replay and native triggers have concise purpose titles
  or constructor origins. Group titles name their carried relationships; hover previews show
  at most four members plus a remaining count and preserve missing-input alerts.
- [Grant choices](../../framework-studio/shared/grants.ts) are driven by source-discovered
  S3, SQS, DynamoDB, SNS and EventBridge types. UI and writer enforce the same bounded
  helpers and bucket-only scope argument. Reviewed source changes regenerate facts.
- Generic native source references/custom grant callbacks remain explicit unknowns.
  Native helper action expansion, trust/key policies, synthesized policy correlation,
  live deployment comparison and effective-permission evaluation remain separate evidence
  layers; the later proposal sections describe those possible follow-ups.

Focused verification covers projection/local enrichment, principals, bindings, triggers,
safe source authoring, grouping/filtering and relevant UI behavior. Browser inspection
uses port 4591; no live AWS operations are part of this change.

## Design conclusion

A database connection owns endpoint delivery, network placement and IAM login in AWS;
its development counterpart uses local PostgreSQL. Its title should explain that binding,
with authorization as supporting information. The same rule applies to routes, triggers,
secret delivery and workload calls. Shared permission facts retain the correct principal,
target, scope, generation status and evidence without replacing connection purpose.

## What was inspected

- Framework normalization and typed catalog bindings in
  [resources.ts](../../packages/framework/src/config/resources.ts),
  [cdk-resources.ts](../../packages/framework/src/config/cdk-resources.ts) and
  [config/index.ts](../../packages/framework/src/config/index.ts).
- Native resource attachment, database login, ECS launch, workflows, integrations,
  AgentCore, triggers, replay and WebSocket policies under
  [cdk-app/lib/framework](../../cdk-app/lib/framework).
- Application database, Cognito identity roles, CloudFront and deployment-support
  resources under [cdk-app/lib/app](../../cdk-app/lib/app).
- Studio projection, source evidence, native source discovery, connection creation,
  aggregation, rendering and inspectors.
- Existing synthesis assertions covering native grants, startup secrets, AgentCore,
  triggers, database bootstrap and WebSockets. Reading these tests is not a claim
  that they were executed for this investigation.
- A fresh read-only evaluation of the actual Development and Production source graphs.
  No full test suite or live AWS operation was run for this investigation.

### Baseline repository inventory

Both source projections evaluated successfully, each with 26 normalized workload
targets. These are declarations, not counts of deployed AWS workloads.

| Relationship | Development graph | Production graph |
| --- | ---: | ---: |
| Database | 5 | 4 |
| Native grant | 1 | 1 |
| ECS launch binding | 1 | 1 |
| Workflow start binding | 1 | 1 |
| Workflow invocation steps | 2 | 2 |
| Agent tools | 2 | 2 |
| Triggers | 3 | 3 |
| Environment references | 40 | 40 |

The Development database count includes three derived local PostgreSQL connections
and retained declarations to the absent AWS database. The presence of a graph edge
is therefore insufficient evidence of a generated IAM grant in that mode.

The baseline Production projection illustrated the inconsistency directly:

- `lambda:graphql-api`, `lambda:oauth-callback`,
  `lambda:cognito-post-confirmation-trigger` and `task:db-migrate` have database edges.
- `lambda:mfa` has a native Cognito `grant("cognito-idp:AdminGetUser")` edge.
- `lambda:test-run-task` has the previously improved ECS permission explanation.
- `lambda:test-start-workflow` still has `startsWorkflow` as its label.
- `agent:example-agent` receives a secret ARN through an ordinary `env` edge,
  although delivering that typed secret ARN also derives read permission.
- The workflow's Lambda/task steps and the agent's two tools have generic step/tool
  labels, despite their AWS authorization requirements.
- Explicit IAM exists on `lambda:cognito-pre-signup-trigger` and
  `agent:example-agent`; it appears on targets rather than as permission connections.

## Permission generation map

"Workload role" below means the Lambda execution role, ECS **task** role, AgentCore
Runtime role or Step Functions state-machine role as applicable. ECS **execution**
roles and service principals are separate actors.

The final column describes authorization facts for Permissions, not map connection titles.

| Declaration or wiring | What AWS receives | Principal and scope | Authorization interpretation in Permissions |
| --- | --- | --- | --- |
| `database: true` | Native `grantConnect`; `rds-db:connect`, plus placement and password-free endpoint configuration | Workload role; selected application writer or Proxy and `app_user` login | **IAM grant: Connect PostgreSQL**; separate network and endpoint details |
| `database: { connection: "direct" }` | Direct-writer connection grant | Workload role; direct writer/login | **IAM grant: Connect directly**; preserve the explicit direct-path choice |
| `database: { readers: true }` | Writer grant plus grants for configured readers | Workload role; writer and reader endpoints | **IAM grants: Writer and readers**; this does not make the workload read-only |
| Native `resources.x.grant…(...)` binding | Calls the real CDK grant method with the workload as grantee | Workload role and, where CDK requires it, resource/key policies | **IAM grant** with the native method and authored scope |
| `environment: { X: resources.secret.arn }` | Secret read grant; customer-managed-key decrypt when required | Workload role; the secret and applicable key | Both **ARN delivery** and **IAM grant: Read secret** |
| ECS `secrets: { X: resources.secret.value/field(...) }` | ECS startup secret reference, execution-role secret read and applicable decrypt | ECS execution role, not application task role | **Startup secret** plus **IAM grant to execution role** |
| Ordinary resource identifier in `environment` | Identifier delivery only | No grant derived from an ordinary bucket name, queue URL, user-pool ID, etc. | **Configuration reference**; never imply AWS access |
| `runsTask(id)` | `ecs:RunTask`, launch-time `ecs:TagResource`, `iam:PassRole`; launch descriptor | Caller role; declared family/cluster and the task/execution roles, with service conditions | **IAM grants: Launch ECS task**; capability, not observed execution |
| `startsWorkflow(id)` | `states:StartExecution`; workflow descriptor | Caller role; named state machine | **IAM grant: Start workflow** |
| `invokesAgent(id)` for a service agent | Runtime invocation grant | Caller role; named AgentCore Runtime | **IAM grant: Invoke agent** |
| `invokesAgent(id)` for `auth: true` agent | User-token forwarding; intentionally no caller-role invocation grant | Authenticated user session | **User-authorized call**; do not invent an IAM grant |
| Agent `tools` | IAM-protected Gateway, Runtime-to-Gateway grant, native Lambda target authorization | Runtime, Gateway role/resource permissions and tool function, across separate hops | **Tool access via Gateway**; expand the actual authorization chain |
| Workflow Lambda step | `lambda:InvokeFunction` | Workflow role; exact function | **IAM grant: Invoke Lambda**, retaining step/completion semantics |
| Workflow task step | Same ECS launch grants as `runsTask`; wait support policies | Workflow role; task, roles and service integration support | **IAM grants: Run task**; show wait support separately |
| Workflow child-workflow step | Start grant plus execution monitoring and EventBridge support | Workflow role; state machine, execution ARNs and managed rule | **IAM grants: Run child workflow**; distinguish ARN types and wildcard scope |
| Workflow agent step | Runtime invocation grant; authenticated-user agents are refused | Workflow role; service-agent Runtime | **IAM grant: Invoke agent** |
| Workflow table/queue/topic/bus integration | Native read/write/send/publish/put-events grants based on declared operations | Workflow role; linked construct and applicable keys | **IAM grant** alongside the service operation |
| Workflow HTTP integration | Endpoint invoke, connection-credential retrieval and connection-secret read policies | Workflow role; endpoint condition, connection and connection-secret ARN pattern | **IAM grants for HTTP integration**, with exact scope limitations |
| Custom workflow AWS operation | Explicit application-owned grant callback | Whatever that callback actually grants | **Application-defined IAM**; actions stay unknown until supported evidence exists |
| `completesCallback(...)` | `states:SendTaskSuccess`, `SendTaskFailure`, `SendTaskHeartbeat` | Worker role; `Resource: "*"` because these token operations do not support resource-level scoping | **IAM grant: Complete workflow callback**; queue is delivery context, not the IAM target |
| Callback ECS task in a workflow | Callback actions attached to the task role | Task role, not workflow role | Show the **reverse worker permission** as well as the workflow-to-task invocation |
| SQS trigger | Consume-messages grant plus event-source mapping | Function role reads/deletes from the queue; applicable KMS permissions | **Event delivery** plus **IAM grant to consumer**; the queue does not acquire a function-invocation role |
| DynamoDB stream trigger | Stream-read grant plus event-source mapping; optional failure handling | Function role; stream and relevant failure target | **Stream delivery** plus **IAM grant: Read stream** |
| SNS, S3, Cognito or EventBridge push trigger | Scoped Lambda resource permission and native delivery configuration | Respective AWS service principal; source restrictions differ by adapter | **Service invocation permission** plus trigger semantics |
| Scheduler trigger | Schedule and target execution role | Scheduler target role; function invocation | **Service-role IAM grant**; a schedule currently has no catalog node |
| Asynchronous `onFailure` destination | Destination send/publish authorization and invoke configuration | Function role; queue/topic and applicable encryption | **IAM grant: Deliver failed invocations** plus failure-handling configuration |
| Trigger DLQ/failure queue | Queue/resource/key permissions appropriate to the delivery mechanism | Service principal or function role, depending on adapter | Distinguish delivery principal and resource policy; do not assume one universal DLQ grant |
| Development replay/callback bridge | Replay-bucket write and supporting transport permissions | AWS event-function role and framework support resources | **Development-only IAM grants**, not production replay permission |
| `cloud.manageConnections` | `execute-api:ManageConnections` | Selected WebSocket handler role; API/stage ARN | **IAM grant: Send to WebSocket clients** |
| `cloud.access` | Explicit Allow action/resource statements | Workload role; authored resource patterns/placeholders | **Explicit IAM policy**, including actions and scope even without a catalog endpoint |
| Cognito identity-pool access | Role trust, group/role mapping, optional reviewed Allow/Deny policy | Authenticated/Reader/optional guest roles; explicit resources | Separate **role trust**, **role selection**, **Allow** and **Deny**; pool IDs alone grant nothing |
| CloudFront origin access | Bucket resource policy granting object reads | CloudFront service principal restricted to distribution | **Resource-policy permission**, not permission on an application workload role |
| Framework support resources | Logging, image retrieval, VPC execution, database bootstrap, deployment custom-resource policies | Supporting roles/service principals | Collapsed **Supporting permissions** inventory; expand without flooding the application map |

### Source owners for that map

- [framework-cloud.ts](../../cdk-app/lib/framework/framework-cloud.ts):
  `applyCloudPermissions`, `attachContainerResources`, `applyCallbackGrants`,
  `applyInvocationGrants` and customer-managed secret decryption.
- [framework-database.ts](../../cdk-app/lib/framework/framework-database.ts):
  `connectDatabase`, endpoint selection and login bootstrap.
- [ecs-tasks-stack.ts](../../cdk-app/lib/framework/ecs-tasks-stack.ts):
  `grantRunTask` and its resource/condition restrictions.
- [framework-workflows.ts](../../cdk-app/lib/framework/framework-workflows.ts):
  per-step roles/grants, callback task permissions and wait support.
- [framework-integrations.ts](../../cdk-app/lib/framework/framework-integrations.ts):
  native integration grants, HTTP policies and explicit custom grant callbacks.
- [framework-agentcore.ts](../../cdk-app/lib/framework/framework-agentcore.ts):
  authenticated/service-agent split and Runtime/Gateway/tool relationships.
- [framework-trigger-services.ts](../../cdk-app/lib/framework/framework-trigger-services.ts),
  [framework-triggers.ts](../../cdk-app/lib/framework/framework-triggers.ts),
  [framework-events.ts](../../cdk-app/lib/framework/framework-events.ts) and
  [websocket-api-stack.ts](../../cdk-app/lib/framework/websocket-api-stack.ts):
  polling, push, schedules, destinations, replay and connection management.
- [identity-pool-access.ts](../../cdk-app/lib/app/identity-pool-access.ts),
  [frontend-website-s3-stack.ts](../../cdk-app/lib/app/frontend-website-s3-stack.ts),
  [frontend-routing.ts](../../cdk-app/lib/app/frontend-routing.ts) and
  [agentcore-metadata.ts](../../cdk-app/lib/framework/agentcore-metadata.ts):
  identity roles, resource policies and support roles.

## Gaps verified before implementation

These findings record the investigation baseline. The implemented experience above and
the [graph-model contract](../aws-studio-knowledge/studio/graph-model.md) describe current behavior.

1. **IAM and purpose are conflated.**
   [project.ts](../../framework-studio/server/model/project.ts) emits a `database`
   relation labelled `database`; [lookup.ts](../../framework-studio/src/lookup.ts)
   supplies `Uses the database`. Other permission-generating bindings have separate
   generic verbs, and only `runsTask` currently has the fuller explanation.

2. **Permission details have no shared contract.**
   [ModelEdge](../../framework-studio/shared/model.ts) has relation, label, detail
   and source evidence, but no structured principal/action/scope/policy-side facts.
   Much of the current explanation is prose buried under Configuration.

3. **The visual category is not a permission inventory.**
   Secret delivery is under inputs; workflow starts, steps and tools are under
   invocations; integrations have their own category. Some of these generate IAM.
   Conversely, routing and JWT authorization are not workload-role IAM grants.
   Replacing all these relation values with `grant` would break source semantics,
   stable IDs, descriptions, removal/edit handling and existing evidence lookup.

4. **Aggregation can conceal permission-bearing members.**
   [aggregateConnections](../../framework-studio/src/connections.ts) retains all
   members but selects one representative for styling. Its special permission
   priority currently recognizes `grant` and `secret`, not the complete set above.
   [buildScene](../../framework-studio/src/scene/build.ts) assigns a single category
   from that representative. A future IAM view must inspect every group member.

5. **IAM scope and graph endpoints are not interchangeable.**
   A callback edge points toward a delivery queue in the graph, while its IAM target
   is Step Functions with `Resource: "*"`. A trigger arrow can run in the opposite
   direction from its identity policy. An agent-to-tool edge hides an intermediate
   Gateway. Rendering `from -> to` as `principal -> IAM resource` would be wrong.

6. **There are real projection omissions.**
   `cloud.manageConnections` is consumed by the WebSocket stack but has no matching
   edge in `edgesOf`. Callback completion is emitted only when Studio finds a
   matching workflow integration path, although the role grant is applied from
   the worker binding itself. Workflow callback task grants are attached in CDK,
   independently of the workflow-to-task edge. Schedule triggers are explicitly
   skipped as graph edges because they have no catalog resource endpoint.

7. **Source discovery is deliberately not an IAM scanner.**
   [scanCdkLinks](../../framework-studio/server/source/cdk-links.ts) recognizes
   selected constructors, references and trigger wiring. It does not extract
   arbitrary `grant*`, role policy, resource policy or trust policy effects.
   Unrecognized native code must retain unknown coverage rather than appear
   permission-free.

8. **Infrastructure inventory is reusable but currently discards policy bodies.**
   [inspectInfrastructureAssembly](../../scripts/infrastructure-inventory.ts)
   already maps synthesized resources to canonical owners and dependencies. Its
   values-free output includes resource types/owners, not IAM statements.
   Extending that reader is preferable to building a separate CDK execution engine.
   Raw templates must remain private; policy presentation requires deliberate
   sanitization and unresolved-token handling.

9. **The framework is more capable than the connection editor.**
   Typed native grant methods work across exposed CDK constructs. Studio's
   [connection editor](../../framework-studio/src/views/WorkloadActions.tsx) and
   [source writer](../../framework-studio/server/edits/connections.ts) currently
   support generic grant authoring only for a bounded S3/SQS subset. DynamoDB,
   SNS, EventBridge and custom grants can exist in source without equivalent UI
   creation controls. Display coverage and safe editing coverage must be stated
   separately.

10. **Review typechecking uses a partial connection signature.**
    [connectionSignature](../../framework-studio/server/edits/batch.ts) covers five
    binding relations when deciding whether to run resource typechecking. It is
    not a complete permission-change signature. The proposed permission model
    should inform this decision and review summaries; its current narrowness alone
    does not establish a missing authorization guard or deployed vulnerability.

## Data access distinctions the UI must preserve

- **IAM database login is not table/tenant authorization.** All current framework
  database consumers use `app_user`. The
  [bootstrap](../../packages/framework/src/runtime/database-login-handler.ts)
  grants `rds_iam`, database `CONNECT, CREATE` and schema `USAGE, CREATE`.
  Table ownership, SQL privileges, row policies and application authorization remain
  separate. A database connection should never claim “read these tables only.”
- **Reader endpoints are not a read-only workload role.** The reader option retains
  writer access. Separate migration and application SQL identities would be a
  distinct least-privilege design change, not part of relabelling the graph.
- **Local execution is a separate authority.** Compose PostgreSQL does not use
  the production RDS grant. Local AWS SDK calls use development credentials;
  declared cloud-role policies are not automatically enforced against that profile.
  [Local environment delivery](../../packages/framework/src/local/environment.ts)
  resolves inputs/secrets and local descriptors but does not assume each deployed role.
- **Native grants may expand.** CDK read/write helpers can include several service
  operations and encryption permissions. A DynamoDB `get` integration calls native
  `grantReadData`; do not label its resulting policy as `GetItem`-only. Exact statements
  should come from synthesis evidence, not a guessed method-name translation.
- **An Allow statement is not proof of effective access.** Boundaries, organization
  policies, resource/key policies, trust, conditions and explicit Deny can matter.
  Never put an unconditional “Access allowed” indicator on a source-derived edge.

## Recommended UX

### At a glance

Keep the relationship verb and authored label at a glance, such as `Routes to: /api/caller`
or `Reads: API_KEY_ARN`. Permission metadata must not replace those labels. The following
operation explanations belong within Permissions, rather than connection headings:

| Connection | Permission purpose | Disclosed authorization details |
| --- | --- | --- |
| Lambda to production PostgreSQL | Connect PostgreSQL | IAM grant · workload role · `rds-db:connect` · `app_user` |
| Lambda to local PostgreSQL | Connect PostgreSQL | Local connection · no RDS IAM grant |
| Caller to workflow | Start workflow | IAM grant · `states:StartExecution` |
| Workload to secret | Read secret | IAM grant · workload role; ARN delivery is a separate detail |
| ECS startup secret | Inject startup secret | IAM grant · execution role |
| Caller to authenticated agent | Invoke agent | User token · no invocation grant on caller role |
| Queue to event Lambda | Consume queue messages | Event source · IAM grant to function role on queue |
| SNS to event Lambda | Deliver topic messages | Lambda resource permission · SNS service principal |

Connection hovers show purpose, environments, endpoints and concise operational details,
followed by a compact IAM action/helper note when applicable. Source paths, repeated
inference caveats and raw binding prose remain under Configuration. Resource previews stay
focused on descriptions and source health. Connection headers and rows omit authorization
badges; a collapsed Permissions disclosure retains principal, scope and evidence. See the
current [graph presentation contract](../aws-studio-knowledge/studio/graph-model.md).
Further inspector information should progressively disclose:

1. Purpose and source declaration.
2. **Permissions generated:** principal, actions, resource/condition scope,
   identity/resource/key/trust policy placement, and supporting permissions.
3. **Configuration delivered:** environment/secret descriptor names, no values.
4. **Network access:** VPC, endpoint and security-group facts where applicable.
5. **Evidence:** declared intent, synthesized policy or explicitly unknown.

For complex edges, expand authorization hops rather than draw every support role
on the map. Native Allow and Deny policies must be distinguished; trust policies
must not be presented as data-access grants.

Map filters describe connection purpose. Any future cross-resource IAM analysis should
use a dedicated permission view with principal and resource navigation, rather than an
overlapping map toggle. Selection still reveals the selected resource's full connection context.

### Evidence language

- **Declared:** configuration asks for this capability.
- **Generated:** a current synthesized assembly contains the policy.
- **Unknown:** custom/native behavior has insufficient supported evidence.
- **Not built in this AWS mode / Local:** no corresponding deployed-role grant is
  generated for that workload by that source projection.

“Deployed” requires AWS evidence bound to the exact deployment/assembly. “Effective
access” requires its own scoped investigation; neither follows from a green badge.

## Recommended implementation boundary

Add authorization facts to the canonical graph contract rather than rewriting
relation enums or inventing another permission system in each component.

A fact needs:

- Stable ID and the declaration/adapter that caused it.
- Actual actor: workload role, ECS execution role, Gateway role, service principal,
  identity-pool role or support role. It need not equal the visual edge's `from`.
- IAM target/scope independent of the visual destination; unresolved references
  and unsupported custom grants must remain explicit.
- Policy kind and effect, actions when known, conditions, native method/arguments,
  and whether further resource/key policy evidence is required.
- Per-mode local/cloud/not-built status and evidence level.
- Relationship back to its operation, including multiple facts per edge.

Reuse normalized declarations for fast source intent. Record concrete grant provenance
at framework CDK attachment sites and correlate synthesized policy statements through
the existing ownership inventory. This avoids maintaining a second hard-coded AWS
action registry in React. Custom native code remains unknown unless recognized or
correlated with synthesis; `grant` in a JavaScript method name alone is not proof.

Exact policy attribution is not always one-to-one: CDK can merge statements,
custom grants can mutate several roles/resources, and imports may resolve only at
deployment. Keep partial attribution and its uncertainty rather than manufacture
an exact match. Preserve existing stack scopes, logical IDs, IAM resources and
native grant behavior during this presentation work.

## Ordered implementation and focused verification

1. **Canonical authorization contract and projection.** Cover every row above,
   preserve relation/edge identities, distinguish local/cloud and actor direction.
   Add omissions such as WebSocket management and callback-worker facts.
   Focused fixtures: database writer/direct/readers/local, ARN versus ordinary
   reference, startup versus runtime secret, workflow and AgentCore auth branches.
2. **Consistent presentation.** One formatter/shared authorization summary for Board,
   Isometric hover, Resources preview, connection inspector, aggregated connection
   members, workload/resource inspectors and draft impact summaries. Display all
   members' IAM facts. Focused UI tests for principal, grouping and local-mode wording.
3. **Synthesized permission evidence.** Extend the assembly reader with sanitized
   identity/resource/key/trust-policy inventories and owner correlation. Offline
   fixtures for merged statements, imported/unresolved resources, conditions, Deny,
   required wildcards and unknown custom grants. Check existing synthesis assertions
   for relevant families; do not run a full suite merely for label changes.
4. **Permission view and safe authoring.** Add cross-category IAM inspection and
   supported grant editors driven by typed capabilities with bounded argument forms.
   Show unsupported authoring explicitly. Removing a secret/database connection must
   review its coupled delivery/network/IAM effects; removing one permission must not
   silently remove a trigger or workload. Preserve existing source review and undo.
5. **Lifecycle integration.** Compare planned IAM changes against current synthesized
   policies in deployment review. Clearly identify broadening, Deny changes and
   unresolved scope. Live IAM inspection or deployment validation stays a separate
   authorized operation. No cloud writes are needed to build this source UX.

Acceptance: every supported permission-generating declaration explains **who gets
what access, why, where it is enforced, and what evidence supports it**, without
claiming runtime invocation or live effective access.

## AWS references checked

- [RDS IAM policy and database-user scope](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html).
- [ECS execution role versus task role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html).
- [AgentCore IAM and JWT inbound authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html).
- [Step Functions callback and service integration patterns](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html),
  [callback API](https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskSuccess.html),
  [action/resource support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html).
- [Lambda's SQS polling model](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html).
- [IAM policy evaluation, boundaries and explicit Deny](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html).
