---
id: deployment.secrets
summary: Canonical private input storage, reviewed secret synchronization, and public metadata limits.
read_when:
  - Adding secrets/inputs or changing value editing, synchronization, or review artifacts
source:
  - framework-config/resources.ts
  - packages/framework/src/config/resources.ts
  - cdk-app/deployment-inputs.ts
  - scripts/deployment-secrets.ts
  - scripts/deployment-workspace.ts
  - scripts/deploy.ts
  - framework-studio/server/deployment-inputs.ts
  - framework-studio/server/deployment-input-edits.ts
related:
  - runtime.environment
  - deployment.planning-safety
  - studio.editing
---
# Secrets and authored configuration

Every secret has one catalog entry: `resource.secret("NAME")` for a raw authored mode input, or a public ISecret member of `resource.stack<T>()`. Raw authored values live only in the selected private input file (conventionally `cdk-app/.env.<mode>`), never config, templates, generated artifacts or pasted ARN maps. Do not expose a public string computed from secret contents. [Resource projections](../framework/resources-and-cdk.md) distinguish metadata/ARNs from values.

Public catalog values have two distinct sources. `resource.value("text")` (or a
dev/prod value map) authors a nonsecret value in TypeScript; it has no dotenv key
to fill or override. `resource.fromEnv("NAME")` names an environment-linked input
with explicit mode presence, defaults, choices and requirements. `resolveInput`
owns their interpretation; downstream Studio, deployment and client export should
consume that result instead of implementing another precedence rule. Deployment
controls such as domains, frontend URL and the retention fallback are separately
declared in [cdk-app/deployment-inputs.ts](../../../cdk-app/deployment-inputs.ts).
They influence the graph rather than becoming workload variables automatically.

The CDK file inspectors, under the shared **Environment files** island, show assignments and their declaration
owners, including unknown or mode-inapplicable assignments. A name appearing in
that file does not make it a workload input or a public client field. Required
inputs can be missing before deployment; Studio exposes the missing requirement
and active consumers without including the value in its public snapshot. See
[environment delivery](../runtime/environment.md) for resolution and generated files.

| Value surface | Current contract |
| --- | --- |
| Public snapshot/review | Names, presence, required/default metadata and secret actions; excludes resolved secret values |
| Protected Studio detail | Selected input/resource detail APIs can return values under local session guards/no-store; the whole Studio is not value-free |
| Environment editing | [deployment-inputs.ts](../../../framework-studio/server/deployment-inputs.ts) fixes dev/prod paths and rejects symlinks; explicit missing-file bootstrap uses exclusive private creation, never dev-to-prod copying. [deployment-input-edits.ts](../../../framework-studio/server/deployment-input-edits.ts) withholds sensitive values from the file inspector (`hidden`) and reveals one value per explicit request |
| Input transaction | [deployment-input-edits.ts](../../../framework-studio/server/deployment-input-edits.ts) keeps values in private in-memory plans, redacts review, checks revision/file hash, round-trips dotenv and replaces privately while preserving unrelated assignments/comments |
| Catalog editing | `ResourceService` in [resources.ts](../../../framework-studio/server/resources.ts) and [resources-source.ts](../../../framework-studio/server/resources-source.ts) edit declaration kind/group/default, workload requirements (staged from each workload's **Required inputs**) and recognized consumer references; not a general code editor |

`planDeploymentSecrets` in [deployment-secrets.ts](../../../scripts/deployment-secrets.ts) completes ownership/account/region/value reads before writes, compares values in memory and exposes create/update/unchanged actions plus ARNs. Existing secrets must have matching management tags and usable state. `createMissing` creates only missing secrets; it never updates an existing secret during review preparation.

Saving an authored inputs file and refreshing Studio are separate outcomes. Once the
reviewed dotenv bytes are saved, the response reports that save even if snapshot refresh
fails, expires the plan and asks for a reload. Refresh diagnostics and input values are
never echoed through that response; a refresh failure must not suggest the file was left
unchanged or offer the accepted plan again.

For reviewed apply, `bind(planId)` captures each action, existing ARN/current version and a keyed HMAC of authored values. `secretBindings` in [deployment-workspace.ts](../../../scripts/deployment-workspace.ts) stores the binding privately beside lock state, **outside the plan directory**, with private file/directory modes. The random key plus HMAC is sensitive material: it permits guessing low-entropy values if disclosed. Do not copy it into plan.json, Studio, logs or source control.

[deploy.ts](../../../scripts/deploy.ts) reloads the secret plan before apply and requires its private binding. `mismatch` refuses changed actions/ARNs, changed AWS current version for an update, changed authored values for create/update, or drift in desired/current application tags. A reviewed value-and-tag update cannot become tags-only when the authored value is removed: its value binding still applies. Tags-only reviews need no authored value and never rewrite the secret contents. A plan moved to another checkout without its binding must be replanned. `--create-secrets` creates missing entries without synchronizing existing updates.

Limitations: Secrets Manager has no conditional put in this path; a concurrent version change **after** validation and before write can race. Sequential secret writes and subsequent CloudFormation changes are not one transaction, and infrastructure rollback does not roll values back. The direct deployment path synchronizes current inputs without a saved review binding; retain its existing CLI safeguards/authorization. [Planning/safety](planning-and-safety.md) owns the ordering and failure reporting.

Delivery differs by consumer: Lambda gets `.arn` plus read permission; containers get `.value`/`.field` through declared injection. [Environment resolution](../runtime/environment.md) owns the local/cloud mechanics. Input creation writes declarations/commented keys only, never actual values.

Tests: [secret review](../../../cdk-app/test/deployment-secret-review.test.ts), [resource deployment](../../../cdk-app/test/resource-deployment.test.ts), [input editing](../../../framework-studio/test/deployment-inputs.test.ts), [resources](../../../framework-studio/test/resources.test.ts). Validate redaction, zero-write refusal and exact reviewed writes with fake clients; never inspect real input values just to update documentation.
