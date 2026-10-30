---
id: guides.workflows
summary: Twelve supported engineering paths with entry points, effects, validation and refusal cases.
read_when:
  - Tracing a feature across configuration, Studio, runtime and CDK
source:
  - framework.config.ts
  - framework-studio/src/draft.ts
  - framework-studio/server/edits/batch.ts
  - scripts/deploy.ts
related:
  - studio.creation-connections
  - guides.extensions
  - guides.maintenance
---
# Common development workflows

These are source-grounded paths, not authorizations to start Docker, apply databases or mutate AWS. Existing [feature procedure](../../playbooks/feature-build.md) owns cross-workload implementation order; [data procedure](../../playbooks/typed-contract-propagation.md) owns database → GraphQL → React changes.

| Request / entry | Call chain and affected source | Downstream checks / common failure |
| --- | --- | --- |
| 1. Declare a Lambda manually | Add handler `index.ts` under cdk-app/lambda_functions; append to the literal map in framework-config/workloads/http.ts, events.ts or websocket.ts. Deliberate smaller modules require explicit root array registration → `defineFrameworkConfig` → normalized target | [Configuration](../framework/configuration.md); generate/verify, handler/auth tests, both synths if infrastructure changes. Missing root registration, ID/path collision, wrapper/userPool mismatch or source spread are common errors |
| 2. Open a Lambda in Studio | `npm run studio` → `main`/root discovery → `startServer` → `SnapshotBuilder.refresh` → `projectModel`/source index → select canonical target on Map or its Resources navigator → Inspector | [Snapshots](../studio/snapshots.md), [graph model](../studio/graph-model.md); model/guard/selection tests. Board is an unrouted implementation/test fixture. Stale failed mode, nonliteral field or catalog-only stack may explain missing/edit-disabled content |
| 3. Edit a property and approve | Inspector `FieldFact` → `InspectorDraft` staged entry → review → `EditService`/`BatchEditor` → `planEdit`/splice → dual-mode preflight → diff → guarded apply → snapshot comparison and source recovery journal | [Editing](../studio/editing.md); plan/splice/transaction/draft suites. Revision/hash change, invalid domain, inherited-vs-authored mismatch or unsafe source shape refuses without intended writes. Saved history belongs to Git; source recovery is not Undo/Redo |
| 4. Change a trigger | Select event/capable resource → `validateTriggerBindings` → `planTriggers`; native removals use `planNativeRemovals`; replay may rewrite handler → batch review/preflight | [Creation/connections](../studio/creation-and-connections.md); Studio trigger/removal/replay and CDK trigger suites, both synths. Unsupported native statement, incompatible resource, changed capability source or missing replay wrapper refuses |
| 5. Add a resource reference | Application stack public field → catalog `resource.stack<T>()` → constructor `linkResources` → instantiate before orchestration → consumer attribute/native grant → finalization | [Resources/CDK](../framework/resources-and-cdk.md); stack/native-resource and environment tests, synth IDs/grants. Catalog type alone does not instantiate a stack; unresolved required links fail |
| 6. Introduce an input/secret | Catalog `value` for standalone public values, `fromEnv` for environment-linked public settings, or `secret` for private inputs → declared consumer reference. Only environment-linked declarations need template keys; author their actual values in the protected input workflow | [Secrets](../deployment/secrets.md), [environment](../runtime/environment.md); input/resource/secret review/export suites. Standalone values cannot be overridden by dotenv. Missing required input, invalid enum, leaked secret or wrong consumer projection violates contract; provisioning is separate |
| 7. Add a workflow | Literal workflows module using `workflow` builder → root registration → normalize/validate IR → ASL/CDK or local interpreter; caller declares `startsWorkflow` | [Workflows](../framework/workflows.md); workflow graph/authoring/ASL/interpreter/runner suites and inspect/verify/synth. JavaScript output coercion, out-of-scope reference, unsupported Express operation or invocation cycle fails |
| 8. Implement agent + tools | Neighboring contracts/handlers → typed agent/tools declarations → agent tool IDs → generated schema projection → `FrameworkAgentCore` or local session/Gateway | [Agents/tools](../framework/agents-and-tools.md); contract/runtime/schema/provisioning and local E2E tests. Unknown tool, malformed payload, invalid session ownership or undeclared capability fails; model/provider/live Gateway checks remain separate |
| 9. Run a local workload | Authorized dev bootstrap/export/Compose → HTTP/WS `LocalLambdaExecutor` or declared runTask/startWorkflow descriptor → runner → process/container/IR executor | [Local execution](../runtime/local-execution.md), [environment](../runtime/environment.md); worker/task/image/engine tests plus terminal run. Wrong manifest, undeclared target, unavailable Docker/dev bridge, provider access or restart can fail after submission |
| 10. Plan/apply deployment | Studio fixed registry or CLI → `prepare` selection/synth/account/ownership → saved plan/assembly → review/typed confirmation → apply staleness/secret binding gates → CloudFormation → verification/export | [Planning/safety](../deployment/planning-and-safety.md); plan/apply/guard/secret-review/isolation suites. Expired/stale plan, missing binding, pending stack/replacement/export dependency requires replan/recovery. AWS actions require explicit environment authorization |
| 11. Add Inspector field | Framework setting contract if new → `FIELDS`/default facts → source-index editability → Inspector control/draft → semantic preflight/source splice | [Extensions](extensions.md), [editing](../studio/editing.md); invalid/reset/inherited/refusal/diff/apply/rollback tests. A UI control alone does not make a source expression safely editable |
| 12. Support resource family | Public native catalog member first; add adapter/normalization/native CDK attachment only for needed semantics → type discovery/evidence → Inspector intents/transformations → graph presentation | [Extensions](extensions.md), [resources/CDK](../framework/resources-and-cdk.md); positive/refusal fixtures, native grant/trigger/synth tests. Discovery does not by itself implement source creation, triggers, IAM or deployment support |

The Studio [creation wizard](../studio/creation-and-connections.md) offers bounded versions of several source procedures above. It includes real-generator outputs in the same reviewed operation. Manual source edits still require their generation sequence. Docker, migration application, AWS provisioning and live integration validation remain separate actions. Use [verification guidance](verification-and-maintenance.md) to select checks and report what actually ran.
