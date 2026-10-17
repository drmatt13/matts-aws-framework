# Lambda invocation editing: investigation and design

Status: investigation and proposed implementation, October 2026. The shared API and
Lambda landscape layers are implemented. The type selector, event-source editor and
function creation described below are **not implemented**.

## Product decision

Keep one APIs layer for HTTP, WebSocket and agent routes, and one Lambda functions
layer for HTTP, WebSocket and event functions outside the VPC. VPC functions remain on
their subnet terraces. Grouping in the landscape must not dictate deployment ownership.

In the Inspector, a future **Invocation type** selector should offer HTTP, WebSocket and
Event. Choosing Event should expose **Stack → Resource → Invocation**, followed by fields
specific to that invocation. A Cognito user pool offers lifecycle hooks; an EventBridge
bus offers rules and event patterns. They cannot share one generic “attribute” picker.

Use the existing resource catalog as the source of truth. Extend the framework with
typed invocation adapters, then expose those capabilities in Studio. Keep native CDK
available for integrations that do not yet have an adapter. Do not make Studio the only
place that understands how a trigger works.

## What the repository already provides

| Area | Finding and implication |
| --- | --- |
| Lambda declarations | [Config types](../../packages/framework/src/config/index.ts) distinguish HTTP, WebSocket, event and tool roles. Common build settings already exist; the surrounding binding fields and deployment behavior differ. Events currently leave triggers to native CDK. |
| Source identity | HTTP/WebSocket declarations can pin `id` independently of their source directory and public route. Event keys are their stable IDs. Moving source or renaming a route must preserve the target ID. |
| Deployment identity | [HTTP](../../cdk-app/lib/framework/synchronous-lambda-functions-stack.ts), [WebSocket](../../cdk-app/lib/framework/websocket-lambda-functions-stack.ts) and [event](../../cdk-app/lib/framework/event-lambda-functions-stack.ts) functions have different owning stacks. Moving a declaration between them can replace the deployed function even with the same `cloud.constructId`. |
| Existing event registry | [framework-events.ts](../../cdk-app/lib/framework/framework-events.ts) builds and looks up mutable event functions. `createEventLambda`/`registerEventLambda` support native ownership. Preserve the historical `AsynchronousLambdaFunctionsStack` scope in [app composition](../../cdk-app/bin/cdk-app.ts). |
| Resource linking | [framework-resources.ts](../../cdk-app/lib/framework/framework-resources.ts) already has `linkedConstruct`, deferred attachments and finalization. These are the seams for resolving symbolic resources and attaching adapters after resources exist. |
| Cognito | [CognitoStack](../../cdk-app/lib/app/cognito-stack.ts) **already exposes `public readonly userPool: cognito.UserPool`**. Its constructor currently wires pre-sign-up, custom-message and post-confirmation functions through native `lambdaTriggers`. No new public field is needed. |
| Current resource discovery | [catalog.ts](../../framework-studio/server/source/catalog.ts) reads directly declared public properties/getters and their textual types. It does not fully resolve inherited fields, type aliases, package exports or import aliases. This is useful display metadata, not proof that a resource supports an operation. |
| Existing relationship inference | [cdk-links.ts](../../framework-studio/server/source/cdk-links.ts) conservatively infers source relationships. Missing edges do not prove that a trigger slot is free. Native trigger inventory needs explicit support. |
| Source editing | [Edit planning](../../framework-studio/server/edits/plan.ts), [route editing](../../framework-studio/server/edits/route.ts) and [transactions](../../framework-studio/server/edits/transaction.ts) provide source hashes, previews, validation and undo. Type conversion needs a coordinated multi-file transaction, beyond a scalar edit. |

### Resources that would appear today

These are candidates for future adapters, not capabilities currently offered by Studio.
Availability comes from [resources.ts](../../framework-config/resources.ts). A public
resource is discoverable without adding a separate Studio registration for each stack.

| Catalog path | Public type | Candidate invocation | Availability / constraint |
| --- | --- | --- | --- |
| `cognito.userPool` | `UserPool` | Cognito lifecycle hook | Both modes; three hooks already occupied by native wiring |
| `workflowFixtures.fixtureBus` | `EventBus` | EventBridge rule | Development deployment only |
| `workflowFixtures.fixtureQueue` | `Queue` | SQS event source mapping | Development deployment only |
| `workflowFixtures.fixtureTopic` | `Topic` | SNS subscription | Development deployment only |
| `workflowFixtures.fixtureTable` | `TableV2` | DynamoDB stream | Development deployment only; stream is not enabled in its current declaration |
| `referenceExamples.documentsBucket` | `Bucket` | S3 notification or EventBridge rule | Both modes; existing EventBridge notifications must be preserved |
| `referenceExamples.recordsTable` | `TableV2` | DynamoDB stream | Both modes; `NEW_AND_OLD_IMAGES` stream is already enabled |
| `referenceExamples.notificationsTopic` | `Topic` | SNS subscription | Both modes; existing subscribers must remain |
| `referenceExamples.processingQueue` | `Queue` | SQS event source mapping | Both modes; queue already receives example messages and has a DLQ |
| `referenceExamples.deadLetterQueue` | `Queue` | SQS event source mapping | Technically possible; identify its existing DLQ purpose before selecting it |

The user-pool client, URLs, booleans, secrets, RDS cluster and database credentials do
not become event sources because they are public. A future adapter can explicitly add
a capability for another service. [WorkflowFixturesStack](../../cdk-app/lib/app/workflow-fixtures-stack.ts)
and [ReferenceExampleStack](../../cdk-app/lib/app/reference-example-stack.ts) provide
concrete examples for adapter fixtures.

## Model: function identity and invocation bindings

A function is compute; HTTP, WebSocket and event sources are ways to invoke it. Keep
those concepts separate in the design, even if the first UI permits one primary role.
One function may eventually have several event sources. An authorizer or agent tool is
a different handler contract and must not be silently included in the three-way switch.

Implement this incrementally:

1. Keep existing section modules and arrays authoritative. Add typed trigger descriptors
   to event declarations first. Normalize them to bindings with stable attachment IDs.
2. Add capability discovery and the event-source editor for existing event functions.
3. Add type conversion only after deployment ownership can remain stable across roles.
   Persist an explicit ownership/compatibility mapping if necessary; do not infer an
   existing function's stack from its newly selected role. Define its schema and
   backward-compatible lowering before exposing the switch.
4. Consider a shared function-definition/binding model when multiple invocation types
   for one function are supported. Keep existing declarations valid through normalization;
   avoid rewriting the application's configuration merely to introduce Studio controls.

An illustrative source API, **not an available framework API**, could look like:

```ts
// Proposed event declaration extension; exact API requires a framework design review.
"cognito-pre-signup-trigger": {
  directory: "/lambda_functions/event_functions/cognito-pre-signup-trigger",
  triggers: [
    trigger.cognito(resources.cognito.userPool, {
      id: "pre-sign-up",
      operation: "preSignUp",
    }),
  ],
}
```

`trigger` would be a pure, typed descriptor builder from the framework, not a CDK import.
Its result contains a discriminant, catalog reference, stable attachment ID and validated
options. No construct instances, arbitrary method names, executable callbacks, copied
ARNs or secret values belong in config. Exact catalog-reference typing must be validated
against `resource.stack<T>()` before committing to this spelling.

The descriptor's operation (`preSignUp`) is distinct from the selected public member
(`userPool`). An EventBridge descriptor instead needs a bus reference and event pattern.
Adding a public string ARN does not make an object mutable or define its invocation API.

## Resource-specific adapters

| Adapter | Required resource capability | Inspector fields | Native work and constraints |
| --- | --- | --- | --- |
| Cognito | Owned, mutable `UserPool` | Hook, supported version/options; occupied-slot owner | Attach the hook and invocation permission. Reject duplicate slot ownership. Treat custom senders and token-generation versions as specialized capabilities. |
| EventBridge | `IEventBus` | Rule identity, event pattern, enabled state, target input, retry/DLQ options | Create a rule and Lambda target with invocation permissions. A bus is not itself a trigger; the rule selects events. |
| SQS | `IQueue` | Batch size/window, concurrency, filters, partial batch responses | Create event source mapping and grant consumer permissions. Validate queue visibility, encryption permissions and handler batch behavior. |
| SNS | `ITopic` | Subscription filter and delivery/DLQ options | Create Lambda subscription and invocation permission; preserve existing subscribers. |
| DynamoDB | `ITable` with stream ARN | Starting position, batch/window, filters, retry/failure behavior, partial batch responses | Create stream mapping and grant stream read. A table without a stream cannot be selected as immediately usable. Enabling its stream is a separate resource edit. |
| S3 | Notification-capable bucket, or bucket plus EventBridge bus | Notification versus EventBridge delivery, event types, prefix/suffix filters | Preserve current bucket notifications, prevent overlapping configuration and identify recursive-write risk. The existing example intentionally uses EventBridge without a notification custom-resource Lambda; do not silently change that architecture. |

Cognito's concrete [`UserPool.addTrigger`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.UserPool.html)
is absent from [`IUserPool`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.IUserPool.html).
An imported pool therefore cannot automatically offer the same mutation controls as an
owned `UserPool`. Display it with an explanation, or require a dedicated adapter that
explicitly manages its owner. Do not introduce an implicit update custom resource.

EventBridge uses [rules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)
and Lambda invocation [permissions](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html).
Supporting an imported bus still requires account, region and permission validation.

For SQS, distinguish hard validation from recommendations: AWS recommends queue visibility
of at least six times the function timeout, plus the batching window. Surface this as a
recommendation and explain a mismatch rather than presenting every recommendation as a
framework invariant. See [SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html).
For streams, expose only supported mapping options from the
[DynamoDB parameter contract](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-params.html).

### Adapter contract and ownership

Each adapter needs coordinated pieces:

- **Capability discovery:** resolve the public instance surface with a TypeScript
  `Program`/`TypeChecker`, including aliases, re-exports and inherited members. Match
  canonical CDK types and required methods, not regexes against `typeText`. Retain source
  locations. Apply the catalog's [StackResourceKeys](../../packages/framework/src/config/cdk-resources.ts)
  semantics: exclude base `Stack` members, private/protected fields and secret projections.
  Unknown or inaccessible members are unavailable, not guessed compatible. Static
  discovery must not instantiate application stacks or execute getters; final linking
  validates the actual object and optional presence in each mode.
- **Pure framework metadata and validation:** typed descriptor, option schema,
  environment availability, handler contract, delivery semantics and diagnostic codes.
  Browser metadata must remain serializable and free of CDK runtime imports.
- **CDK attachment:** resolve the actual linked construct, verify capability/ownership
  again, resolve the function and attach through the proper native construct. Integrate
  with resource finalization; enumerate attachments before applying them to detect slot
  conflicts. Use each attachment's stable ID for constructs and outputs.
- **Native binding inventory:** recognize existing managed/native bindings with explicit
  ownership. An unrecognized native expression is “manual wiring; review required,” not
  an empty slot. Never let inferred display links authorize overwriting native code.
- **Graph and diagnostics:** add declared invocation edges to both normalized models;
  report conflicts with resource, field and function source locations.

Resource linking does not remove dependency constraints. For example, a user pool can
depend on a function for a trigger, while a queue mapping created with a function can
depend on the queue. Do not force all attachments into one stack or add blanket reverse
dependencies. Compare synthesized dependencies and permission scopes for each adapter.

A new service needs a developer-authored adapter with these pieces and fixtures. A
public readonly member alone makes the resource discoverable; it cannot describe event
schemas, permissions, retries or configuration semantics. Do not offer arbitrary public
method execution in the GUI.

## Type conversion must be a migration preview

| Selected type | Required binding details | Details that require explicit resolution |
| --- | --- | --- |
| HTTP | Route path, HTTP methods, deployment setting, API authorizer | WebSocket route/authorizer and event triggers; HTTP handler response and session contract |
| WebSocket | Route key; optional authorizer only on `$connect`; deployment setting | HTTP methods/auth and event triggers; connection-management bindings and WebSocket payload contract |
| Event | One or more supported native invocation bindings, or explicit manual wiring | HTTP/WebSocket bindings and deployment differences; source-specific payload, result and retry behavior |

Preserve source directory, target ID, build options, environment, grants, database/subnet
settings and explicit construct IDs wherever valid. Present incompatible settings with
their required action. Do not silently drop them. Review existing callers and workflow
bindings as well as the primary route. Preserve module imports and array composition;
remove an old declaration only as part of the same validated transaction that creates
its replacement.

Changing a dropdown cannot convert an HTTP handler to a Cognito hook or batch processor.
Show the required input/output contract and locate the handler. Existing functions need
a reviewed handler change or an explicit compatibility declaration; unknown compatibility
must remain visible. New functions can start from adapter-owned templates.

HTTP API authorizer selection and `userPool: true` have separate meanings: the former
guards the route; the latter gives framework session support to the handler. Preserve
the [auth checklist](../playbooks/auth.md) and `framework:check` contract. Do not copy
HTTP authorizer settings into WebSocket message routes or event declarations.

The preview must show source edits, removed/added invocation edges, delivery changes,
both environment graphs and deployment identity changes. A type move that replaces an
existing function should be blocked by the normal identity-preserving conversion path;
an intentional replacement needs a separately explicit migration decision.

### Local execution and replay

Events are built in both deployment modes today; routed workload availability follows
its own deployment settings. Do not promise that selecting Event creates a local event
emulator or preserves a route's previous deployment behavior.

Most Cognito hooks run synchronously with a fixed five-second deadline and must return
the expected event. Capture-and-replay cannot substitute for their live decision or
mutation. See [Cognito trigger semantics](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-working-with-lambda-triggers.html).

The existing [replay wrapper](../../packages/framework/src/runtime/event-replay.ts)
captures development invocations and returns the original Cognito event in AWS. Its
classification is not proof that replay is safe for a particular hook. Adapters should
declare replay compatibility explicitly: side-effect processing can be a candidate;
authentication challenges, sign-up validation and token/message mutation require their
real synchronous response. Batch retries, ordering and partial failures also need
source-specific testing; replaying a payload does not reproduce those guarantees.

## Inspector flow

1. Select a function on the shared layer or its VPC terrace. Show the current invocation
   type, existing routes/triggers and source ownership.
2. In Event mode, select a stack from `framework-config/resources.ts`, then a compatible
   public resource. Keep private fields and unrelated public values out of the picker.
   Show unavailable candidates with a concrete reason where useful: production-only,
   imported pool, missing stream, unknown type or manual wiring.
3. Select the invocation offered by that resource and fill its conditional fields.
   For Cognito: User pool → Pre sign-up / Custom message / Post confirmation / other
   explicitly supported hooks. For EventBridge: Event bus → Rule → Event pattern.
4. Preview the complete change and apply through the existing transaction/undo flow.
   Stale source or a conflicting trigger requires a refreshed preview.

Keep resource detail in the Inspector; do not expand every public member back onto the
landscape. New-function creation eventually adds a name/stable ID, source directory,
runtime/packaging and handler template before this same invocation flow. Defaults come
from framework config, and the resulting literal declaration must work without Studio.

## Delivery sequence and verification

1. **Capability foundation:** add semantic public-member discovery and a binding inventory.
   Verify aliased imports, inherited members, third-party stack exports, unavailable
   modes, unsupported constructs and no secret values in capability responses.
2. **Typed event binding:** define normalized descriptors and adapter extension points.
   Implement Cognito and EventBridge first. Use fixture stacks for tests; do not attach
   new triggers to application functions simply to demonstrate the feature.
3. **Existing Cognito migration:** account for all three current hooks exactly once.
   Transfer ownership from constructor `lambdaTriggers` to descriptors only when explicit
   development and production synth comparisons preserve function/stack identities,
   trigger configuration, permissions and dependency structure. Stop on duplicate hooks
   or unresolved manual wiring. Never retain both native and generated attachments.
4. **Event Inspector:** build stack/resource/invocation selection and source-specific
   forms using adapter metadata. Test both graph previews, stale-source conflicts,
   multi-file atomicity and exact undo. Exercise existing occupied hooks in the browser.
5. **Type conversion:** establish stable deployment ownership and handler compatibility
   checks, then implement coordinated section edits. Compare actual CloudFormation
   logical IDs, not only target IDs or construct IDs, in both explicit synth modes.
6. **Function creation:** generate a declared source directory, handler template and
   literal config entry; reuse the editor, validation and undo path. Add SQS, SNS,
   DynamoDB and S3 adapters as complete capabilities rather than unvalidated options.

Tests must reject duplicate Cognito hooks, unsupported imported-pool mutation, an absent
stream, invalid source options, missing resources in either deployment graph and unknown
native ownership. Include dependency-cycle and IAM-scope assertions for attachments.
Test HTTP/WebSocket/event handler differences and replay restrictions independently of
whether TypeScript accepts the declaration.

Run `npm run verify`, framework checks, Studio browser checks, and explicit dev/prod CDK
synthesis as the relevant implementation phases land. Live delivery, retry behavior and
AWS permission checks require a separately authorized deployment and integration test.
The current layout-only implementation does not alter infrastructure or deploy anything.

## Decisions to settle before implementing the editors

- The backward-compatible schema for stable function ownership across role changes.
- Whether the first type selector permits only one primary invocation family while the
  event editor permits several triggers; the underlying model should allow future reuse.
- The first Cognito hook allowlist and version/KMS options; do not claim all specialized
  hooks work through the simplest adapter.
- How developer-authored adapters are registered and shared between pure config, Studio
  and CDK without adding application-specific routing tables to framework internals.
- How a handler's compatibility is declared and reviewed when static analysis cannot
  prove it, including Python and container functions.

These are implementation design choices, not reasons to add unrelated fields or visual
clutter to the current landscape.
