---
id: deployment.planning-safety
summary: Exact deployment plan/apply gates, ownership enforcement, confirmation and failure boundaries.
read_when:
  - Fixing approval, ownership, change-set, staleness, or recovery behavior
source:
  - scripts/deploy.ts
  - scripts/deployment-plan.ts
  - scripts/deployment-guard.ts
  - scripts/deployment-cognito-domains.ts
  - scripts/deployment-workspace.ts
  - scripts/deployment-integrity.ts
  - scripts/deployment-artifact.ts
  - scripts/atomic-replace.cjs
  - packages/framework/src/deploy/classify.ts
related:
  - deployment.lifecycle
  - deployment.environments
  - deployment.secrets
  - deployment.operations
---
# Planning, approval and cloud safety

This page owns infrastructure plan/apply. Database application, identity operations and
frontend publication have independent review/effect boundaries described in the
[operational lifecycle](lifecycle.md).

Use the [production procedure](../../playbooks/prod-deployment.md) for authorized operations. Source work or this wiki never authorizes deployment. A template plan can be read-oriented, but change-set preparation writes AWS review objects; `--create-secrets` also writes new secrets.

The enforcement core is [scripts/deploy.ts](../../../scripts/deploy.ts), not only the Studio buttons:

| Gate | Enforcement / result |
| --- | --- |
| Select/synthesize | `prepare`: resolve mode/target/input file; synth assembly or reopen reviewed assembly; compare selection and synthesized identity |
| Lock/account | Per-checkout `acquireDeploymentLock` in [deployment-workspace.ts](../../../scripts/deployment-workspace.ts), then STS account comparison; shared with saved teardown; unknown/dead locks require inspected manual recovery, and release checks a unique token. It is not distributed coordination across checkouts/machines |
| Ownership/status | `assertDeploymentAllowed` in [deployment-guard.ts](../../../scripts/deployment-guard.ts) consumes [deployment classification](../../../packages/framework/src/deploy/classify.ts); unknown ownership, other mode/account/region and in-progress/stuck states refuse before secret reads/writes |
| Stateful references | [stateful-references.ts](../../../scripts/stateful-references.ts) validates saved-template physical identities, released ownership, exact original DB network/KMS/secret or Cognito client/domain/trigger prerequisites before writes; managed/reference transitions refuse implicit identity loss. [Physical reference locks](../../../scripts/stateful-reference-locks.ts) exclude concurrent operations across different deployment names in this checkout, with sorted acquisition and failed-attempt cleanup; they are not distributed locks |
| Production flags | `unsafeProductionFlags` rejects hotswap/express/no-rollback/yes/unreviewed approval bypasses; direct production deploy forces CDK broadening review |
| Legacy development Cognito domains | Compare exact owned deployed/next domain templates before secret writes. Direct removal/replacement refuses; saved review must include the domain and authentication consequence and require typed deployment name. Apply repeats comparison and rejects older reviews without it; [domain guide](../../framework-studio/identity-and-domains.md) |
| Managed parameters | Handwritten overrides of framework-managed secret ARN parameters are rejected |
| Plan | Save staged assembly bytes, inspectable template/security diffs, stack fingerprints, retained deployed stacks, secret names/actions and uncertainty; failed analysis blocks apply; default prod change-set review, dev template review |
| Confirmation | `confirmationLevel` in [deployment-plan.ts](../../../scripts/deployment-plan.ts) always requires an explicit click in dev and derives click/name in prod from first deploy, stateful/destructive/replacement/security/export impact; consequential prod changes require typed deployment name |
| Apply | Refuse used/expired (24-hour) plans, missing secret binding, altered assembly digest/identity, changed stack fingerprints, unavailable change sets or secret-write mismatch |
| Finish | Verify observed stack completion/identity/template; write advisory deployment record, result status and dev export when applicable |

Template comparison cannot determine replacement certainty or drift. Change-set review uses CloudFormation's resource change details but still cannot predict custom-resource effects or every service-resolved value. Cross-stack imports from newly created/deferred dependencies postpone those consumers: apply can finish **partial**, requiring another plan after dependencies exist.

`plan` records `preparing.json` before preparing each change set, so interrupted preparation can be discarded. New stacks can remain `REVIEW_IN_PROGRESS`; expected plan-owned review stacks are handled specially. `discard` cleans prepared reviews, not an executed deployment. Missing secrets produce `needs-secrets` until explicit creation is allowed; creation must not update existing secrets. [Secret binding](secrets.md) defines the reviewed-value checks.

`apply` deploys the **saved assembly without resynthesis or loading current declarations**. Discard also remains available with broken current source, shares the deployment lock, and targets exact saved StackIds; an ambiguous interrupted placeholder stays preserved for investigation. The saved target/inputs, STS account, ownership and secret guards still apply. Checks and account/ownership validation rerun. CloudFormation rollback governs infrastructure, but secret writes occur before stack changes and can already affect readers. Cancellation of a local CLI/job does not guarantee AWS cancellation or rollback. The wrapper reports updates already performed. `UPDATE_ROLLBACK_FAILED`/`DELETE_FAILED` need explicit recovery; some failed creates/paused updates are classified as CDK-recoverable. Never automate recovery by deleting identity checks.

Safeguards are local-tool contracts, not protection against a user bypassing the wrapper or tampering with all local artifacts. `assemblyDigest` in `scripts/deployment-integrity.ts` hashes every saved manifest, template and staged asset byte plus entry types, internal symlink targets and executable/file permissions and rejects links outside the assembly. Phase/result records use atomic writes and file fsync; an attempt without a terminal record is surfaced as interrupted, never blindly retried. Removed whole stacks are explicitly listed as retained outside the selected assembly; a no-change result covers current assembly templates only, not drift or full convergence. Stack fingerprints bind immutable StackIds plus observed status/timestamps, not a distributed lock or complete drift proof. [Operations](operations.md) owns status/drift and identity-scoped teardown.

On Windows, journal replacement retries only sharing-related rename failures for
at most five seconds. The same atomic rename preserves the previous record until
success; exhausted/permanent errors still fail. No unlink/permission fallback or
cloud request replay is introduced. Tests cover byte preservation and bounded
failure in [deployment artifact tests](../../../cdk-app/test/deployment-artifact.test.ts).

Tests: [plan](../../../cdk-app/test/deployment-plan.test.ts), [plan/apply](../../../cdk-app/test/deployment-plan-apply.test.ts), [guard](../../../cdk-app/test/deployment-guard.test.ts), [interrupt](../../../cdk-app/test/deployment-interrupt.test.ts), [secret review](../../../cdk-app/test/deployment-secret-review.test.ts), Studio [plans](../../../framework-studio/test/deploy-plans.test.ts). Preserve refusal-before-write assertions, saved-assembly identity and typed approval across CLI/UI changes.

Stateful intent is the literal per-mode [source policy](../../../framework-config/stateful-resources.ts), with absent values preserving legacy shared inputs. Actual deployed policies govern teardown: [dependency analysis](../../../scripts/stateful-teardown.ts) refuses retained RDS dependency deletion and retained pool trigger removal. [Retained evidence](../../../scripts/retained-resources.ts) records physical identities/relationships locally before the first deletion and preserves failed/completed attempts beyond removed source/stacks. It proves observed history, never current availability or distributed ownership. See [canonical retention/reuse contract](../../FRAMEWORK.md#stateful-retention-and-explicit-reuse) and the [Studio lifecycle workflow](../../framework-studio/stateful-resources.md).
