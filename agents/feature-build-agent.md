# Build a feature across workloads

Use this procedure for a feature spanning routes, event Lambdas, tasks, workflows,
and application resources. Read [Framework](../docs/FRAMEWORK.md) for the APIs and
[Development](../docs/DEV-DEPLOYMENT.md) for setup. Changes confined to the
database → GraphQL → React path follow the
[data-feature contract](typed-contract-propagation-agent.md).

## Decide before writing code

Establish the requested behavior and authorization before selecting workloads:

- Choose Lambda steps (declared under `events`), container tasks, and callbacks.
- Decide where workflow state lives. Graph steps can write directly to DynamoDB,
  SQS, SNS, and EventBridge; other stores need a Lambda or task to perform the write.
- Identify resources and AWS-invoked handlers that need a deployment.
- Put commands on their own routes, each with only the binding it uses. Reads go
  through GraphQL with explicit public fields and record authorization.
- Pass keys to large documents. A task's input and callback handle share the
  8,192-character container override limit.

Keep approved application decisions and unrelated edits. Ask only for unresolved
behavior; no infrastructure deployment or database application is implied by a
request to implement a feature.

## Build order

1. Create the application stack with public construct fields, declare its
   `resource.stack<T>()` in the catalog, and finish its constructor with
   `linkResources(this, resources.<stack>)`. Instantiate it at the marked place
   in `cdk-app/bin/cdk-app.ts`. Bind HTTP/AWS-operation integration references
   beside their constructs before workflows are created.
2. For storage changes, edit the Prisma contract, then emit and plan offline:

   ```sh
   npm --workspace @repo/database run generate
   npm --workspace @repo/database run migration:new -- --name <change_name> --from <graphTipHash>
   ```

   Use a confirmed graph tip when one is required; follow
   [Database](../docs/DATABASE.md#changing-storage). Inspect and present the SQL,
   then continue source work. Planning does not apply it.
3. Implement repositories and their explicit write boundaries. For a supplied
   timestamp column, pass its ISO string through `toTimestamptz` from
   `packages/database/src/timestamps.ts`. Keep automatic timestamps in PSL.
4. Declare workloads in literal section modules composed as arrays, then run:

   ```sh
   npm run framework:generate
   npm run workflows:inspect
   ```

5. Implement handlers, with a self-contained `contract.ts` beside each handler
   whose payload is shared. Use `authenticated(...)` for an HTTP handler needing
   a user, and `withLocalReplay(...)` for an event declared `localReplay: true`.
6. Wire GraphQL and client operations using the data-feature contract, including
   explicit schema registration and neighboring executable-schema tests. Run
   `npm run codegen` before building consumers of new documents.
7. Build the requested UI. Run `npm --workspace client-app run build` before
   typechecking when routes changed, so the route tree is generated.
8. Run `npm run verify`, inspect the workflow, and synthesize the explicit dev
   graph. Infrastructure changes also require the production synth described in
   [Framework](../docs/FRAMEWORK.md#generated-contracts-and-verification).
9. Prepare a deployment only when resources or AWS-invoked handlers changed.
   Follow the deployment guide and obtain authorization for the intended account
   and environment before running `npm run deploy`. Its dev export is automatic.
10. Rebuild Compose when workspaces or dependencies changed. Starting Compose
    applies local migrations, so confirm the database target and obtain separate
    authorization for application before starting it.
11. Run the feature headlessly and through its intended user flow. Record
    terminal outcomes, not just accepted submissions.

## Development loop

[Development's edit/action table](../docs/DEV-DEPLOYMENT.md#what-to-do-after-an-edit)
owns the reload rules. Handler, graph, and UI edits normally reload locally;
new workspaces/dependencies require an install and image rebuild. Resources and
AWS-invoked handlers need a dev deployment. A successful dev deploy also exports
the local resource manifest; there is no separate secret-sync command.

Compose Watch restarts the invocation runner after framework/config edits.
That discards in-flight executions and pending callbacks. Finish long runs before
editing those files and handle expired callbacks in application behavior.

## Headless verification

- `npm run workflows:smoke` checks the repository fixtures after dev setup.
- `POST /workflows` on the local runner starts a graph with a declared caller
  holding `startsWorkflow(<id>)`; `GET /workflows/:id` reads its terminal status
  and history. See [Invocation smoke checks](../docs/FRAMEWORK.md#invocation-smoke-checks).
- Once the local test user is configured, `npm run dev:request -- <METHOD>
  </route> [json-body]` verifies authenticated routes and GraphQL. Never print
  the credentials, session token, or cookies.
- Keep a route's application logic callable separately from its
  `authenticated(...)` wrapper. Test that logic and separately exercise the
  authenticated route; one does not prove the other.

## Traps

- Prisma timestamp writes require `toTimestamptz`; avoid duplicated branded casts.
- `dynamodb.put` needs the whole item. A fallback transform may need the body's
  explicit type: `transform<T>(...)`. Workflow outputs remain references; use
  `expr`, `when`, and `choose`, never JavaScript coercion or conditions.
- AWS SDK utility packages use different version lines. Check `npm view` before
  pinning a new dependency, and preserve native lockfile bindings with npm 11.
- A new Lambda workspace needs `npm install` and a Compose rebuild.
- GraphQL results may contain null-prototype objects; compare their JSON values
  when object prototypes are irrelevant to the assertion.
- Root scripts are CommonJS: put `await` inside `async function main()`.
- A task calling AWS locally needs `local: { resources: ["awsCredentials"] }`.
- Label fallbacks so a failed model or AWS setup does not look like a successful
  execution. Keep domain decisions and output validation in code.

## Completion checks and handoff

Run `verify`, `workflows:inspect`, both required synths, `workflows:smoke`, a
headless run of the new graph, and `dev:request` against new routes where the
authorized environment is available. Exercise requested browser behavior too.
Report actual results and any check deferred by environment or authorization.
Name the migration/deployment actions still pending; do not infer live behavior
from offline tests or a successful synth.

Working examples:

- [Capabilities](../framework-config/workflows/capabilities.ts): managed services,
  an AWS-operation bridge, nested workflows, and a task callback; HTTP is excluded.
- [Invocation workflow](../framework-config/workflows/invocation-tests.ts): a
  Lambda followed by a task.
- [Project data feature](../docs/DATA-FEATURES.md#project-is-the-reference): storage,
  repository, schema, client operations, and UI.
