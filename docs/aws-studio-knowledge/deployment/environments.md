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
  - framework-studio/src/deploy/context.ts
  - framework-studio/src/deploy/observations.tsx
  - framework-studio/src/connection-generations.ts
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
| Named target | `projectTargets`, `selectTarget` in [targets.ts](../../../packages/framework/src/deploy/targets.ts): `framework:app`, `framework:appId` and `framework:targets` stages in cdk.json, each `<app>-<stage>` unless it sets `deployAs`, with the implicit `dev` stage; declared prod targets require account pinning. Stacks carry the app id and stage (`framework:app-id`, `framework:stage` tags and metadata); `stageDeployments` in [discovery.ts](../../../packages/framework/src/deploy/discovery.ts) finds a stage under any name |
| Input selection | `resolveRepositoryTarget` in [node.ts](../../../packages/framework/src/deploy/node.ts): target inputs/override or conventional `cdk-app/.env.dev` / `.env.prod`; repository-root `.env` is generated output |
| Bootstrap | [main.ts](../../../cdk-app/bin/main.ts) / [app.ts](../../../cdk-app/bin/app.ts) establish mode/target before loading the composition |
| Identity | `DeploymentIdentity`: deployment, mode, account, region; output contract plus newer template metadata/tags establish ownership |
| Studio graph | [inputs.ts](../../../framework-studio/server/inputs.ts) / evaluators build fixed dev/prod projections, not one graph for every named target's custom input file |
| Studio operations | The active Source mode supplies its saved AWS profile; operational workspaces retain their explicit target and region. The navbar does not select an AWS destination; its app-name editor ([AppName.tsx](../../../framework-studio/src/views/AppName.tsx), [app-name.ts](../../../framework-studio/server/app-name.ts)) names deployments without selecting one. Status, plan, drift and teardown evidence is keyed to connection and destination; changes clear transient approvals. Database operations retain independent target and approval boundaries |

Dev AWS builds Cognito, AWS-invoked event Lambdas and replay support; normal routed workloads/tasks/workflows/agents execute locally. Prod builds the cloud-enabled application, network/database/frontend as configured. WebSocket API Gateway is framework managed in both modes. Handler deploy settings, including per-environment input conditions, determine which routes and Lambdas exist. `deploy` lanes remain distinct from these modes; see [configuration predicates](../framework/configuration.md).

Studio observes one selected named target per configured mode through one persistent
observer, independently of the current route. The pure resolver in
[context.ts](../../../framework-studio/src/deploy/context.ts) reuses a remembered target
only when it still belongs to that declaration mode, then falls back to the first matching
repository target. Neither profile names, legacy per-target profile preferences nor
discovered deployments select a declaration mode. Multiple named prod targets remain
distinct destinations using prod semantics.

Deploy's account line displays the active Source mode's observed account/region. Its
target's region pin takes precedence over the profile/default region policy; account and
ownership mismatches remain explicit. Development and Production can share a profile,
but their selected target queries remain independent. Credential/configuration changes
advance that profile's generation and refresh both associated modes. Route navigation
reuses cached/in-flight evidence without starting another poller. Other operational
workspaces keep their explicit deployment/region controls and active mode's connection;
for example Domains edits Production intent without substituting the Production profile
when the accepted Source mode is Development. See
[AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations).

Selection checks require command/target mode agreement and refuse accidental production inference. `prepare` in [deploy.ts](../../../scripts/deploy.ts) then compares the synthesized identity with selection and actual STS account. Ownership classification prevents a dev graph from updating stacks owned by prod or another deployment. Named targets do not provide a separate secret namespace if someone deliberately aliases identities/inputs; identity and selected inputs must be reviewed together.

Development export supplies generated root environment/resource manifest and browser settings. Production output/export uses its production destinations rather than seeding development. Protected Studio input editing addresses only the two fixed mode files; custom target input paths are not a general file browser. [Secrets](secrets.md) owns the private-value boundaries.

The retained **Add a deployment stage** editor/service adds a stage through a reviewed source change;
it never renames an existing stage, `deployAs` or resource, and edits no inputs file. Renaming
the app from the navbar never changes `framework:appId`; it moves development to the new name
and sets `deployAs` for each production stage that a read-only AWS discovery (with the
Production profile) shows deployed, by app id and stage under any name. When AWS cannot be
checked it sets nothing: the deploy guard ([deployment-guard.ts](../../../scripts/deployment-guard.ts))
refuses to create a production deployment while the same app's stage is deployed under another
name, and Deploy's "Deployed as …" finding keeps that name in one reviewed change
(`KeepDeployedName.tsx`, `/app-name/deploy-as/review`).
Interactive Studio startup creates missing conventional input
files from their own mode's template, preserving existing files and excluding custom
target paths. Studio shows them as one CDK environment that edits both side by side;
the physical storage and deployment input selection remain separate by mode.
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
