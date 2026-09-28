# Battle test: one feature, end to end, on this framework

## Context

In September 2026, an AI coding agent (Claude) built a complete feature on this framework,
from a few prompts, in one session. The feature was a purchase-approval workflow. What it
did doesn't matter here, and its code is not in this repository. What matters is that
building it quickly touched almost every layer the framework offers:

- a new CDK stack, with a DynamoDB table and an SQS queue;
- Postgres tables, carried through the data-feature path: Prisma contract, migration,
  repositories, GraphQL and React Query;
- HTTP routes and event Lambdas, including one that AWS invokes and the dev lane replays
  locally;
- a container task running a LangGraph agent on Bedrock;
- a Step Functions workflow with parallel steps, retries, branching, and a pause for a
  callback;
- a React page.

The rapid build was the battle test. This report is what it showed about developing on
the framework: where it gave an edge, where it cost time, and what to change. It was
written by the agent that did the build, so "I" below is that agent. Figures were measured
during the build or for this report.

## Verdict

**Yes, the framework gave a large edge, and it came from three places:**

- wiring I did not have to write;
- mistakes caught before anything ran;
- a local loop against real AWS.

**Two costs recur on every feature:**

- finding the knowledge, which is present but spread out;
- per-target ceremony: a new workspace, an install and an image rebuild.

**Two more things stood out:**

- **A capability gap:** verification stops at authentication.
- **A bug:** there is one real framework bug, at a seam nothing had exercised. It was fixed
  during the build, but the fix is not in this repository (recommendation 1).

## The numbers

| Measure | Value |
| --- | --- |
| First code edit to first live end-to-end run | 25 minutes, including a 166 s deploy and a Compose rebuild. The run went all the way through a human decision |
| Live runs that failed at runtime | None of two (one per branch of the workflow's routing). Every defect surfaced at typecheck or test time |
| Discovery before any code | Three parallel read-throughs making 206 reads and searches, plus the 700-line FRAMEWORK.md |
| Framework ceremony in what I wrote | About 15% (roughly 500 of 3,300 lines). More than half of that is per-workspace manifests |
| AWS wiring written by hand | One 72-line CDK stack, 137 lines of workload declarations, and five lines in bin/cdk-app.ts |
| Generated state machine | 21 states and 628 lines of ASL, from a 277-line graph (types and comments included) |
| Full offline verification | `npm run verify` took 53 s with the feature in place: about 417 tests plus a typecheck of every workspace |
| Framework fix the build needed | 2 files, +37 −1, plus a test. Not in this repository; see recommendation 1 |

## Where the edge came from

1. **Wiring you don't write.** None of the following was written by hand:
   - API routes and the local proxy in front of them;
   - Cognito verification, which is one wrapper (`authenticated`);
   - IAM for data access, derived from bindings;
   - the Step Functions definition;
   - container overrides and callback plumbing for the task;
   - environment variables carrying resource identifiers;
   - the route constants and Zod contracts the browser imports;
   - local replay of the Lambda that AWS invokes.

   I never copied a table name, a queue URL or an ARN into anything. The one hand-written
   IAM statement (Bedrock access for the task) was copied from the LangGraph service
   declaration.
2. **Mistakes surface before anything runs.**
   - Types flow from the Prisma contract through repositories and GraphQL to React, and
     through the workflow graph by way of typed step outputs.
   - Conventions are enforced by tests. For example, a GraphQL feature file without its
     index import or a neighbouring test fails `verify`.
   - `framework:check` enforces the framework's invariants.
   - Everything I got wrong failed a typecheck or a test before it could fail at runtime:
     an over-strict item type, an untyped fallback, a branded timestamp write, and a flawed
     assertion.
3. **One command answers "am I done?"**
   - `npm run verify` needs no AWS access and ran in under a minute.
   - For an agent, this is the most valuable property the repository has: a definition of
     done it can trust.
   - `workflows:inspect` and the runner's execution history use the same state names, so
     reading a live run needed no translation.
4. **The dev lane.**
   - Orchestration and compute run locally against real DynamoDB, SQS and Bedrock.
   - The whole feature needed one deploy, and `npm run deploy` handled secrets, deployment
     and the local export in a single step.
   - Handler, graph and UI changes reloaded locally.
5. **Working examples and stated reasons.**
   - AGENTS.md sent me to the right guide.
   - The "Working example" column in FRAMEWORK.md's workload table was the most useful
     single piece of documentation. I copied the shapes it points to.
   - Code comments explain why things are the way they are, for instance why
     `eventFunction` adds no stack dependency. That settled design questions without
     guesswork.

## Where it cost time

Ranked by the time each cost.

1. **Discovery.** The guides cover a lot: construction order, `eventFunction`,
   `localReplay`, the runner's read endpoints. The cost is that the facts for one task are
   spread across a long reference guide and the code, with no path through them.

   Four facts I needed are stated in no guide at all:
   - a task that calls AWS locally must opt in to the credentials mount;
   - the runner can start a workflow without a browser session;
   - a task's input and callback handle share an 8,192-character limit;
   - workflow-step Lambdas are declared under `events`.

   The one area with a written task procedure, data features, was the one area where I
   never had to search for what to do next.
2. **Verification stops at authentication.** Every route needs a Cognito ID token, and an
   agent cannot sign in. To verify anyway, I:
   - started workflows through the runner (`POST /workflows` with a caller that declares
     `startsWorkflow`);
   - moved route logic into a function I could call directly.

   I never exercised the UI, or the authenticated routes as routes.
3. **Per-target ceremony.**
   - Seven new targets meant 16 manifest, tsconfig and Docker files, an `npm install`, a
     lockfile change and a Compose rebuild.
   - Writing the files took seconds, since they were copied from neighbouring targets.
   - The install and rebuild are the real cost, and they exist by design: images own
     their dependencies.
4. **Seams nobody had run.**
   - Dev deployments never publish table and queue identifiers for local workflows. The
     guide describes that as supported, but it is broken. It surfaced only because the
     build was the first code to use it.
   - The failure message would have been specific, which is to the framework's credit.
   - The only declared workflow in this repository, invocation-test, uses a Lambda step
     and a container task. No workflow here exercises `dynamodb`, `sqs`, `sns`,
     `eventbridge`, `http.request`, `aws.call` or `runWorkflow`.
5. **Prose that has drifted.** Agents act on prose literally, and in four places it says
   something untrue:
   - `workflows:inspect` advises calling `bindWorkflowIntegration`, which doesn't exist
     ([inspect-workflows.ts:141](packages/framework/scripts/inspect-workflows.ts#L141)).
   - The provider catalog says a test catches drift between the provider list and the
     config enum
     ([catalog.ts:11](cdk-app/ecs_containers/services/langgraph/src/providers/catalog.ts#L11)).
     That test does not exist, so the protection described is absent.
   - `completesCallback` says a worker only ever answers a queue
     ([resources.ts:936](packages/framework/src/config/resources.ts#L936)). `sns.request`
     and `eventbridge.request` answer on other kinds.
   - The LangGraph service describes its load balancer as public
     ([index.ts:28](cdk-app/ecs_containers/services/langgraph/src/index.ts#L28)). FRAMEWORK.md
     documents an internal load balancer reached over a VPC link.
6. **Type-system snags.**
   - Prisma's branded timestamps reject plain strings on write.
   - The workflow DSL's type errors print internal symbols such as
     `[WORKFLOW_REFERENCE]`.
   - Both DSL errors I hit had simple causes: a `put` needs the whole item, and a fallback
     `transform` needs the body's type (`transform<T>(...)`). Establishing that still took
     a probe.
7. **In-flight work is lost on restart.** Compose Watch restarts the runner when
   framework-config/, framework.config.ts or packages/framework/src changes, and that
   discards in-flight executions and callbacks. It is documented, but it shapes how you
   work during any long run or demo.

## Recommendations, ranked

### Required if a local workflow uses tables or queues

1. **Publish the identifiers local workflows need in dev deployments.**
   - **Symptom:** a workflow run locally that uses a resource-backed step (`dynamodb.*`,
     `sqs.*`, `sns.*`, `eventbridge.*`) makes `npm run export:cdk-outputs` fail with
     "needs table:…, which this deployment has not published".
   - **Cause:** `requireIntegration`
     ([framework-integrations.ts:97](cdk-app/lib/framework/framework-integrations.ts#L97))
     publishes those identifiers. Only `WorkflowsStack`, which a dev deployment never
     builds, and `WorkflowBridgesStack`, which handles only `http.request` and `aws.call`,
     call it.
   - **Fix (fixed in the build, not included here):** in `createFrameworkWorkflows`
     ([framework-composition.ts:131](cdk-app/lib/framework/framework-composition.ts#L131)),
     when the mode is dev, do the following inside `deferResourceAttachment`:
     - go through every workflow enabled locally;
     - for each of its integrations that names a catalog resource and is not a bridge
       kind, call `requireIntegration`.

     No grant is needed, because the local lane uses the developer's credentials.
   - **Test:** add one to native-resources.test.ts. A dev-mode app with a linked table and
     queue, and a local workflow that uses `dynamodb.put` and `sqs.request`, must
     synthesize both `framework:workflow-integration:` outputs.

### Small (each under an hour)

2. **Correct the four drifted statements** from "Where it cost time" item 5. For
   catalog.ts, either write the promised test or delete the claim.
3. **Document the four missing facts** from "Where it cost time" item 1.
4. **Make the scaffold test fixture copy directories rather than hand-listed files.**
   - [scaffold.test.ts](packages/database/test/scaffold.test.ts) copies a hand-picked list
     of repository files and GraphQL context files. It also copies contract.prisma from
     `model Project {` to the end of the file.
   - It breaks `verify` as soon as anyone adds a model after Project, a new repository
     file, or a new import to graphql-context.ts. The build hit all three.
5. **Put a timestamp write helper in packages/database once.**
   - The first repository that writes a timestamp meets Prisma's branded-type error.
   - The fix is a one-line cast at the repository boundary
     (`value as TimestamptzString<6>`), and it belongs in one shared place.
6. **Add a container entry to `defaults`.**
   - Lambdas default to `arm64`, but containers are hard-coded to `x86_64` with no default
     to change.
   - On Apple silicon, every task has to spell out `arm64` to avoid an emulated build.
   - Only worth doing if parity with x86 Fargate isn't required.

### Medium: the biggest effect on agent-driven development

7. **A local test user for headless authentication.** This closes the largest verification
   gap.
   - The sign-in route already returns an ID token in its response body. It checks the
     request's origin, so send the local frontend's.
   - Create a dev-pool test user without two-step verification and keep its credentials in
     cdk-app/.env.
   - Add a small helper that signs in and makes the request, so the token is never printed.
   - With that, an agent can call authenticated routes, query GraphQL and drive the
     browser.
   - This is auth-sensitive: use the dev pool only, follow [agents/auth.md](agents/auth.md),
     and never enable it in production.
8. **A written procedure for building features that span workloads, with a thin skill
   pointing at it.** Use the same shape as propagate-contract.
   - Contents: decisions to make first, the build order below, the dev-lane loop, the
     traps, and completion checks.
   - It targets discovery, which was the largest time cost. The data-feature procedure is
     the evidence that this works.
   - A general agent would not help. This work spans config, CDK, handlers and UI in one
     change set, and checking it depends on the main session's deploys and running stack.
9. **Fixtures for every workflow step that crosses between local and AWS.**
   - Add a declared fixture workflow using `dynamodb`, `sqs`, `sns`, `eventbridge`,
     `http.request`, `aws.call` and `runWorkflow`, and run it in the dev lane with a smoke
     script.
   - This finds seam bugs before an application does.
   - Of these, the build exercised only `dynamodb` and `sqs.request`, and both hit the bug
     in recommendation 1. Nothing is known about the others.

### Framework features, if more workflows are coming

10. **A Lambda step that waits for a callback:**
    `invokeLambda(id, { completion: "callback" })`.
    - Today a callback needs a queue, topic, bus or container.
    - In the build, getting one task token into one database row took a queue, a
      dead-letter queue, an event source mapping, a Lambda deployed to AWS behind
      `localReplay`, and the replay round trip. It also needed a deploy before it could run
      locally at all.
    - It mirrors the existing `runTask` callback path. Estimate: about a day.
    - `completesCallback` would need a form that isn't tied to a queue.
11. **A status read for what `startWorkflow` and `runTask` start.**
    - The invocation API only starts things, and the rule against choosing local or AWS
      transport yourself leaves an application no sanctioned way to observe them.
    - In the build, a runner restart could leave a record pending forever.
    - Try an app-level cleanup first: mark records still pending after the workflow's
      timeout as failed.
12. **Deferred: execution context inside a graph** (execution name, start time, the time a
    state was entered).
    - A graph sees only its `input`, which cost the build its per-stage timestamps.
    - Add it when a second workflow needs them.

## Patterns that apply to any feature

**Build order.** This held for the whole build:

1. Stack and catalog entry.
2. Prisma contract and an offline migration plan.
3. Repositories.
4. Workload declarations, then `framework:generate` and `workflows:inspect`.
5. Handlers with a `contract.ts` beside each.
6. GraphQL, `codegen` and client operations.
7. UI.
8. `verify` and a dev synth.
9. Deploy, but only when resources or AWS-invoked Lambdas change.
10. Rebuild Compose when workspaces or dependencies change; this also applies migrations.
11. A headless run through the runner.

**Design rules:**

- **Put commands on their own routes and reads through GraphQL.** Bindings are per target,
  so each route holds only the capability it uses, and GraphQL stays free of Step Functions.
- **Keep handler logic callable without its auth wrapper.** It is the only way to exercise a
  route's real logic headlessly today.
- **Hand container tasks keys, not documents,** because of the 8,192-character limit.
- **Decide where workflow state lives before designing the graph.** A graph writes directly
  only to DynamoDB, SQS, SNS and EventBridge. Anything else needs a Lambda per write.
- **For AI steps, keep the decisions in code:**
  - end with a tool whose arguments follow a schema;
  - validate that output in code;
  - make any automatic decision in code;
  - label fallbacks, since a silent fallback hides a broken setup.

## Considered and not recommended

- **A durable local callback broker.** Only local development loses callbacks, and
  applications must handle dead tokens in AWS anyway.
- **Automatic S3 offload for large task inputs.** Passing keys is the better design.
- **Workspace-scoped `npm ci` in task Dockerfiles.** Measured on the build's AI task image:
  1.65 GB down to 1.47 GB, 11%. Real dependencies dominate the image.
- **A generator for per-target boilerplate.** Copying manifests took seconds. The install
  and rebuild, which are the real cost, would remain.
- **A workflow scaffolder.** The existing data scaffolder already could not express the
  build's feature, and workflows vary more.
- **A mechanical path or doc checker.** Two of the four drifts are in code strings and
  comments that such a checker would not read.
- **A separate package for sharing code between a service and a task.** Giving the task
  the LangGraph service's model providers needed only a subpath export in
  `@repo/langgraph`'s package.json and a COPY in the task's Dockerfile.
- **Commands as GraphQL mutations.** That would concentrate every capability on one Lambda.
