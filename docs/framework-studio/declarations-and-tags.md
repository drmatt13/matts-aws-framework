# Declaration ownership and tags

`framework.config.ts` remains the explicit composition root. Workload sections are
literal maps composed as arrays; static discovery and runtime merging both reject duplicate
keys. `satisfies` retains literal route/method/target types. No filesystem registration,
Studio inventory, or deployment step is introduced by organizing files.

The default layout has one file per workload kind: `workloads/http.ts`, `events.ts`,
`tasks.ts`, `agents.ts`, and the other sections. This gives developers a predictable place
to add each declaration, keeps related helpers/comments together, and avoids creating a
file or root import for every small feature. `area` tags describe concerns such as `auth`,
`graphql`, `examples`, `tasks` and `workflows` across those files.

`resources/`, `shared/`, and independently imported networks/databases have separate
ownership. If a kind module eventually becomes too large, it can explicitly compose
smaller modules or feature maps through its root section array. Studio follows supported
relative imports; directory placement does not define semantics or automatic registration.

## Code-only authoring

```ts
// framework-config/workloads/http.ts (append to the existing map)
import type { HttpSection } from "../contracts";

export const http = {
  "/reports": {
    directory: "/lambda_functions/http_functions/reports",
    methods: ["GET"],
    tags: { area: "reporting", team: "analytics" },
  },
} satisfies HttpSection;

// framework.config.ts (already registered)
http: [http],
```

The public resource catalog names are independent of descriptor filenames:

```ts
// framework-config/resources/stacks.ts
import type { CognitoStack } from "../../cdk-app/lib/app/cognito-stack";
import { resource } from "@repo/framework/config";

export const cognito = resource.stack<CognitoStack>({
  tags: { area: "auth" },
  members: { userPool: { tags: { team: "identity" } } },
});

// framework-config/resources.ts
import { defineResources } from "@repo/framework/config";
import { cognito } from "./resources/stacks";
export const resources = defineResources({ cognito });
```

Catalog namespaces keep the existing one-level grouping contract, such as
`langgraph.modelProvider`. That bound concerns catalog paths; the owning TypeScript module
can live at any supported depth under `framework-config/` and be imported explicitly.

`resource.fromEnv("NAME", { tags: { area: "reporting" } })` and
`resource.secret("NAME", { tags: { area: "reporting" } })` use the same vocabulary.
An input's tag values are ordinary metadata, never references to its value. Do not put
secrets in tags. Config evaluation, graph construction and source review resolve no secret
contents and require no AWS access.

A stack the CDK app builds without a catalog entry is tagged the same way, from `stacks`
in `framework.config.ts`, keyed by its class. These are the framework's own
`HttpApiGatewayStack`, `WebSocketApiStack`, `FrontendWebsiteS3Stack` and
`DevLambdaReplayStack`:

```ts
// framework.config.ts
stacks: {
  HttpApiGatewayStack: { tags: { area: "api" } },
},
```

`stacks` may also be imported from a module. An entry holds only `tags`. A cataloged stack
keeps its tags on its `resource.stack()` entry; naming it in `stacks` as well fails synthesis.

## Tag semantics and ownership

`DeclarationTags` is a readonly string-to-string map. There are no global tag defaults.
Workloads (including tools, agents, workflows and the WebSocket authorizer), networks,
database declarations, catalog stack descriptors, framework-built stacks, public members,
inputs and secrets all support metadata. Routes display their target's metadata; several routes sharing one target
must agree on tags, and editing the shared target updates its literal route declarations.

Putting tags in compute defaults is rejected with a migration diagnostic; attach tags to
the owning declaration or stack descriptor. Logical trigger/configuration settings without
their own native resource use their owning declaration's metadata, rather than claiming a
separate AWS tagging capability.

Stack members inherit the stack descriptor's tags. An explicit member key overrides the
same stack key. Removing that override restores the inherited value; removing a key at
the stack removes its inheritance. There are no null tombstones. Studio shows authored
and effective tags and the entity that supplied each effective key. The database declaration
owns its primary resource subtree's final tag overrides; sibling replicas and Proxy resources
retain their stack's tags. A database consumer's tags never retag RDS,
and references/import order never retag another declaration's producer.

Keys have 1–128 characters; values have 0–256. The portable vocabulary accepts Unicode
letters/numbers, spaces and `_.:/=+@-`. Effective maps permit 46 application keys, reserving
four of AWS's 50 slots for ownership. `aws:` and `framework:` prefixes and `ManagedBy` are
reserved, case-insensitively. `__proto__` is also refused because JavaScript treats it
specially in object literals; choose an ordinary application key. Existing framework
ownership/deployment/mode/contract tags retain their exact values and precedence.
Invalid metadata reports its declaration and offending key. RDS additionally rejects empty
values, `rds:` keys, and values beginning with `aws:` or `rds:`. Native CDK/service validation
remains applicable. These constraints follow [CDK tagging](https://docs.aws.amazon.com/cdk/v2/guide/tagging.html)
and the [RDS tag API](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_Tag.html).

| Entity | AWS behavior |
| --- | --- |
| Owned workload compute | Tags its primary compute and owned supporting taggable constructs |
| Owned VPC | Tags its network and owned taggable descendants; consumers retain their own tags |
| Owned stack | Tags its stack and owned taggable resources; member overrides have explicit precedence |
| Framework-built stack (`stacks`) | The same as an owned stack; a workload inside keeps its own tags on its compute |
| Owned public construct | Tags the owned construct subtree where CDK supports tags |
| Managed database declaration | Overrides catalog metadata on the owned primary database |
| Imported/external construct | Metadata only; no tagging API calls and no retagging of an external producer |
| Public string, environment input, reference, route | Metadata only; no independently owned taggable AWS resource |
| Catalog namespace | A logical container, with no independent tag defaults; tag its entries or their owning stack |
| Authored secret | Metadata accompanies the declaration; deployment owns its Secrets Manager resource |

CDK's tagging support determines which CloudFormation resource types receive tags.
No resource is created solely to hold tags. Shared resources require unambiguous ownership;
conflicting aliases fail validation rather than choosing a traversal winner.
For example, individual EventBridge Scheduler schedules have no CDK tag manager: their
declaration retains metadata, and the framework does not create a schedule group just to
attach tags. API routes and public string outputs likewise retain metadata without an
independently taggable resource.

ECS services propagate service tags to newly launched tasks; existing service tasks keep
their prior tags until a normal rollout replaces them. No forced rollout is added.
Declared task launches and workflow
integrations propagate task-definition tags. Task creation gains scoped `ecs:TagResource`
permission restricted to the declared cluster and `RunTask` creation action. These settings
are intentional template/IAM differences, as described by [ECS tagging](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-using-tags.html).
Authored secret tags are reconciled only in the separately authorized deployment flow,
with tag state bound into deployment review; removing a declaration tag removes that
application tag without changing protected ownership tags.

## Studio authoring

Use **Add to application**, fill in the declaration, and add key/value rows under **Tags**.
Studio writes a named, formatted TypeScript module in the same default layout shown above.
Input/secret descriptors share `resources/inputs.ts`, stack descriptors share
`resources/stacks.ts`, and a selected existing catalog group retains its owning module.
Workloads append to the canonical kind module, preserving its comments/shared fragments
and its existing root registration. New declarations receive meaningful literal keys.
For an existing declaration, select its map node and edit **Tags** in the Inspector.
Edit the labeled **Key** and **Value** inputs directly, use **Add tag** to focus a new
key, or **Delete** to remove a row. If an older open page lacks editing controls,
**Refresh editor** loads the current snapshot without changing declarations.
Inherited member values identify their owner; removing an authored override reveals the
inherited value. Computed or ambiguous source remains read-only with a source link and
an explanation. Studio does not replace expressions or remove comments to make them editable.

Tag changes join the existing draft. **Review Changes** validates both modes and displays
per-file source diffs. **Apply All** writes the reviewed source, checks the refreshed model,
and records interrupted-write recovery metadata. Use Git for saved-source history.
Source revisions and file hashes reject stale reviews; guarded
rollback preserves concurrent changes. Multi-file writes use compensating restoration,
not a durable crash-atomic transaction. Saving source does not deploy or call live tagging APIs.

**Isometric always keeps its topology layout.** Select a tag key and value in the compact
tag filter. Keys, values and totals count only entities available in the selected development
or production mode: active workloads and their routes, present catalog entries, enabled local
services, and VPCs built in production. Inactive placeholders remain on the map but do not
inflate the totals. Nonmatching resources use the same transparent treatment as resources outside
the active deployment mode. **Untagged** in the first selector finds entities with no effective tags. In the value
selector, **Untagged** finds resources missing the selected key. An empty value is still a
tag, and inherited tags count. Plain input parameters, environment files, namespace
containers and local database fixtures are exempt from both Untagged choices. Authored
secrets, workloads, custom resources and every stack, framework-built or cataloged, remain
candidates. Parameters with tags still participate in explicit value filters. Filtering never
moves, removes or duplicates resources, changes their deployment status, or hides real
VPC/subnet and execution information. Selection, connections and source links retain their
canonical identities. Clearing the filter restores the full view. Filter preferences never
write declarations. Board shares the same metadata and tag Inspector.

## Migration

This checkout consolidates workload sections into `workloads/<kind>.ts`, shared model
fragments into `shared/`, and catalog descriptors into `resources/`. Import paths change; public
catalog paths, handler directories, route keys, target IDs, bindings, authentication,
database/VPC placement, `cloud.constructId`, stack scopes, names and outputs stay stable.
The historical `AsynchronousLambdaFunctionsStack` identity remains intact.

Existing directly imported literal modules remain supported at other depths; no permanent
second declaration format or compatibility shim is needed. Keep comments and shared
fragments, update relative imports after a move, then run `npm run framework:generate`,
`npm run verify`, Studio checks, and both explicit synth modes. Compare every stack's
logical IDs, resource types, names, exports and non-tag properties before deployment.
This source migration requires no database migration or deployment. Any later deployment
needs separate environment authorization and change-set review.

## Synthesis comparison for this migration

The pre-edit baseline is repository revision `8b02568b91f9c3653e0f65fd9dd45f2f2919e018`.
Both baseline and after assemblies use the real CDK entry point, disposable mode-specific
inputs, account/region pins from `cdk.json`, and WebSocket deployment enabled. Structural
comparison skips asset bundling equally on both sides; the documented CLI synths also run
with asset bundling enabled and `--no-lookups` as a separate integration check.

| Mode | Stacks | Resources | Unchanged outputs |
| --- | ---: | ---: | ---: |
| Development | 5 | 66 | 38 |
| Production | 11 | 253 | 78 |

Stack names, every logical ID/resource type, physical names, output/export definitions,
network/database identities and historical `AsynchronousLambdaFunctionsStack` are unchanged.
Tag properties change on 28 development and 109 production resources. Every other
template difference is explicitly accounted for:

- `EcsTasksStack/InvocationTestTaskF562C16D` and `DbMigrate5AD6F72D`: container image digests
  change because their existing Docker context includes the migrated framework source.
  The context, Dockerfiles, image platform, task identity and other container settings remain unchanged.
  A later deployment registers new ECS task-definition revisions for these image updates;
  this source work does not deploy them or replace running infrastructure.
- `WorkflowsStack/InvocationTestWorkflow3FE42799`: the ECS step adds
  `PropagateTags: "TASK_DEFINITION"` to its ASL parameters.
- `WorkflowsStack/InvocationTestWorkflowRoleDefaultPolicyB84594D9` and
  `SynchronousLambdaFunctionsStack/TestRunTaskServiceRoleDefaultPolicy9C10BDE2`: each adds
  one `ecs:TagResource` allow statement restricted to the declared cluster's task ARN and
  `ecs:CreateAction = RunTask`. Existing statements remain unchanged.

There are no remaining non-tag differences after those five specific property changes;
no broad normalization removes names, properties, policies or exports from comparison.
Assembly stack tags add `area: auth` to Cognito in both modes, and `area: database` to
RDS and `area: platform` to NetworkStack in production. All preexisting stack/resource
tags, including deployment ownership, retain their values; account and region stay fixed.
The current example service is local-only, so ECS service propagation is verified by the
separate synthesis regression rather than appearing in this application's templates.
Templates and complete before/after difference records are retained locally under
`.cache/tag-refactor/`. No deployment or live database change is part of this audit.
