---
id: deployment.environments
summary: Two deployment modes, named targets, identity, input selection, and staging limits.
read_when:
  - Changing environment isolation, staging, target selection, or mode handling
source:
  - packages/framework/src/deploy/targets.ts
  - packages/framework/src/deploy/node.ts
  - packages/framework/src/deploy/identity.ts
  - cdk-app/bin/main.ts
  - framework-studio/server/inputs.ts
  - cdk-app/deployment.ts
  - cdk-app/lib/framework/framework-network.ts
related:
  - framework.configuration
  - deployment.planning-safety
  - runtime.environment
---
# Modes, targets and isolation

There are exactly two `DeploymentMode`s: **dev** and **prod**. A named deployment target is an independent deployment identity using one of those modes, not a third set of framework semantics. A target named staging can use prod behavior with separate name/account/region/inputs; there is no built-in staging mode or automatic promotion pipeline.

| Concept | Owner / current behavior |
| --- | --- |
| Mode | [identity.ts](../../../packages/framework/src/deploy/identity.ts): `DeploymentMode`; explicit CDK context selects prod, with deprecated inverse local context supported |
| Named target | `parseTargets`, `selectTarget` in [targets.ts](../../../packages/framework/src/deploy/targets.ts): `framework:targets` in cdk.json, personal dev name or named selection; declared prod targets require account pinning |
| Input selection | `resolveRepositoryTarget` in [node.ts](../../../packages/framework/src/deploy/node.ts): target inputs/override or conventional `cdk-app/.env.dev` / `.env.prod`; repository-root `.env` is generated output |
| Bootstrap | [main.ts](../../../cdk-app/bin/main.ts) / [app.ts](../../../cdk-app/bin/app.ts) establish mode/target before loading the composition |
| Identity | `DeploymentIdentity`: deployment, mode, account, region; output contract plus newer template metadata/tags establish ownership |
| Studio graph | [inputs.ts](../../../framework-studio/server/inputs.ts) / evaluators build fixed dev/prod projections, not one graph for every named target's custom input file |
| Studio operations | `/deploy` owns its named target, profile, resolved account and region. Graph-mode/undo controls are hidden there. Status, plan, drift and teardown evidence is keyed to the selected destination; changing destination clears transient approvals. Database operations require their own explicit target and approval, independent of graph mode |

Dev AWS builds Cognito, AWS-invoked event Lambdas and replay support; normal routed workloads/tasks/workflows/agents execute locally. Prod builds the cloud-enabled application, network/database/frontend as configured. The WebSocket API flag is a separate switch. `deploy` lanes remain distinct from these modes; see [configuration predicates](../framework/configuration.md).

Deploy's account toolbar selects credentials by AWS profile name and labels the resolved
account and region. A profile's default region is supporting information; the selected
named deployment's region pin takes precedence. The deployment rail retains every
declared target, including multiple targets using prod mode, and identifies unread
deployment state as unverified.

Selection checks require command/target mode agreement and refuse accidental production inference. `prepare` in [deploy.ts](../../../scripts/deploy.ts) then compares the synthesized identity with selection and actual STS account. Ownership classification prevents a dev graph from updating stacks owned by prod or another deployment. Named targets do not provide a separate secret namespace if someone deliberately aliases identities/inputs; identity and selected inputs must be reviewed together.

Development export supplies generated root environment/resource manifest and browser settings. Production output/export uses its production destinations rather than seeding development. Protected Studio input editing addresses only the two fixed mode files; custom target input paths are not a general file browser. [Secrets](secrets.md) owns the private-value boundaries.

Deploy's **Development & production deployment names** editor adds independent target
keys through a reviewed source change; it never renames an existing key or resource.
Changing the personal dev default preserves its old identity as an explicit target.
The prod/staging target key remains authoritative; no competing `.env.prod`
CDK_APP_NAME is added. Missing conventional input files use their own mode's template.
The output exporter resolves a declared named target's custom `inputs` path from that
same target, checks account/region pins against deployed identity, and offers
`--client-only` for public client env refresh without Docker or Compose-control outputs.
See [frontend release](../../framework-studio/frontend-release.md) and the implementations
[deployment-identities.ts](../../../framework-studio/server/deployment-identities.ts),
[frontend-release.ts](../../../framework-studio/server/frontend-release.ts).

## Region belongs to the deployment

One application deployment uses one account and region. Keep `region` on a named
target in `framework:targets`, not on individual VPC declarations. The existing exact
target pin is the destination guardrail; no `allowedRegions` list or per-network
region selector is needed. Different named targets can deploy independent application
copies to different regions; they imply no replication or regional failover.

`resolveDeploymentInputs` in [deployment.ts](../../../cdk-app/deployment.ts) reads
`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` set by the CDK CLI, rejects target pin
mismatches, and returns the `stackEnv` shared by application/framework stacks in
[cdk-app.ts](../../../cdk-app/bin/cdk-app.ts). `prepare` in
[deploy.ts](../../../scripts/deploy.ts) passes an explicit `--region` through
`AWS_REGION` and verifies it against the synthesized deployment identity.

[framework-network.ts](../../../cdk-app/lib/framework/framework-network.ts) builds
VPCs in that environment and refuses callers in a different account or region before
reusing or constructing network infrastructure. `maxAzs` uses the deployment region's
CDK availability-zone context; endpoint service names use the VPC stack region.
Per-network region would break same-VPC database placement and the framework's native
cross-stack references. CloudFormation exports/imports are
[limited to the same account and region](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-importvalue.html).
The [region tests](../../../cdk-app/test/network-region.test.ts) cover endpoint/AZ
resolution, target pins and cross-environment VPC refusal; the
[Framework guide](../../FRAMEWORK.md#deployment-region) owns the user-facing contract.

Adding a truly independent third mode is a foundational change: update mode unions/parsers, predicates, input selection, synthesis/bootstrap, identity/tag parsing/classification, deployment/export/destroy, Studio model/evaluators/selectors and all binary mode branches. A new target name alone should not require these changes. Follow [change impact](../reference/change-impact.md) and [retrieval validation](../guides/retrieval-checks.md).

Tests: framework [targets](../../../packages/framework/test/deploy-targets.test.ts), [identity](../../../packages/framework/test/deploy-identity.test.ts), [node selection](../../../packages/framework/test/deploy-node.test.ts), CDK [isolation](../../../cdk-app/test/deployment-isolation.test.ts), [production export](../../../cdk-app/test/production-export.test.ts). Offline fixtures do not establish real account isolation; [planning/safety](planning-and-safety.md) owns mutation checks.
