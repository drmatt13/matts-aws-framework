# Development

This guide gets a checkout running and explains the everyday edit/reload loop.
Commands run from the repository root. Replace placeholders before running commands.

The local API server uses browser paths: `/api/<http-or-service-path>` for HTTP/service
declarations and the exact `route` for agents. The Vite proxy preserves those paths.
`npm run dev:request` still takes an HTTP declaration key (e.g. `/graphql`) and adds `/api`.

## First setup

Install Node 24+, npm, AWS CLI credentials for the intended dev account, and Docker
Desktop using Linux containers with Compose Watch support (Compose 2.32+). The workspace
provides the CDK CLI; use `npm --workspace cdk-app exec -- cdk ...`.

```powershell
npm ci
aws sts get-caller-identity
```

Create `cdk-app/.env.dev` from [the dev template](../cdk-app/.env.dev.template) if it does
not already exist (Studio's CDK environment files island has a Generate button for it). Preserve existing values when switching configurations. Set:

- A distinct CDK_APP_NAME for your own development deployment. It may not be the name of a
  target declared in `cdk-app/cdk.json` (`framework:targets`), such as the production one.
- LOCAL_DEV_URL, LOCAL_AWS_REGION, and every host port in the example. Leave
  LOCAL_AWS_PROFILE blank to use your AWS default profile.
- Any workload settings, such as the example agent's LangGraph model provider. With
  LANGGRAPH_MODEL_PROVIDER=openai, also set OPENAI_API_KEY and deploy: the agent reads the
  key from Secrets Manager by ARN, locally as in AWS.
- Optional Google OAuth credentials. Leave custom domains off for routine development.
- SKIP_EMAIL_VERIFICATION=true if new users should skip the emailed code. Without it, sign-up
  sends Cognito's own verification code, which the Verify page accepts. It is refused in
  production, and federated sign-in never links to an account confirmed this way.

The [framework guide](FRAMEWORK.md#configuration-and-environment) owns configuration
precedence and environment-file responsibilities. Do not author LOCAL_BROWSER_ORIGINS;
it is derived during export. Never put backend secrets in a VITE_ variable.

Deploy the AWS portion of development. The deploy command synthesizes the dev
graph and exports the root `.env` and local resource manifest after deployment.
Commands build your development deployment unless they say `-c prodDeployment=true`,
so no mode flag is needed:

```powershell
npm run deploy:resources -- --all
```

For a named AWS profile, use `aws sts get-caller-identity --profile <PROFILE>`
to check the account, then deploy with `npm run deploy:resources -- --all --profile=<PROFILE>`.
Without a profile flag or an authored `AWS_PROFILE`, deployment uses the AWS
default credential chain.

The deploy command synchronizes only the selected graph's configured/required secrets,
supplies ARN parameters, deploys, then exports development files. Existing managed secrets
are reused when no local value is supplied; unchanged values create no version. Synth and
diff perform no secret uploads and do not require a secret-binding file. For a standalone
refresh, run `npm run export:cdk-outputs -- --profile <PROFILE> --region <REGION>`.

Before any secret is uploaded, deploy reads what CloudFormation already holds under the
deployment's name and refuses to change stacks it does not own:

- **The other mode.** It refuses a deployment that is currently the other mode, such as a
  dev deploy over a prod deployment of the same `CDK_APP_NAME`.
- **Unidentified stacks.** It refuses stacks that follow the deployment's names but carry
  no framework identity; they are never adopted on their name alone.
- **Stacks that disagree.** It refuses stacks whose identities disagree with each other or
  with their own account and region.
- **Busy or stuck deployments.** It refuses a deployment that CloudFormation is still
  changing, or that needs recovery.

To see what an account holds, read-only:

```powershell
npm run deploy:status -- discover --profile <PROFILE>
npm run deploy:status -- status --profile <PROFILE>
```

`discover` lists every framework deployment in the profile's account and region, with its mode as
its own stacks record it, and matches this repository's targets against them. `status` adds recent
events, pending change sets, and whether local development can run against the deployment and its
exported files are current. `--plan <dir>` / `--apply <dir>` review a deployment before it changes
anything; see [Production](PROD-DEPLOYMENT.md#deploy).

Each refusal names the stacks and a remedy, and nothing is changed. Two deploys of the same
name on one machine cannot run at once (`.cache/deploy/<name>.lock`). Assemblies that an
interrupted run left in `.cache/deploy` are removed after a day. Deploy and export read
authored inputs from `FRAMEWORK_INPUTS_FILE` when it is set, otherwise from the target's
inputs file: `cdk-app/.env.dev` for development, `cdk-app/.env.prod` with `-c prodDeployment=true`.
There is no `cdk-app/.env.dev`.

The dev graph holds Cognito, AWS-invoked event handlers, and replay resources. Routed
HTTP handlers, services, tasks, and workflows run locally; no ECS image is published by a
dev deployment. The one exception is DEPLOY_PROD_WEBSOCKET_API=true: it builds the AWS
WebSocket API and its handlers in a dev deployment too, because API Gateway is then their
AWS caller, while local-ws-dev-server keeps serving the same routes under Compose. Those
handlers run in AWS against nothing else the dev graph lacks, so synth refuses one that
declares `database: true`, a `subnet` other than `"none"`, or a task, workflow or agent binding; turn the flag
off to serve it locally. Use a separate full cloud deployment when testing HTTP routing.

Export writes root `.env` with fixed Compose controls and `.framework/local/resources.json`
with discovered development resource identifiers. It does not rewrite authored
`cdk-app/.env.dev`. If export reports conflicting old assignments, move authored local
settings to cdk-app/.env.dev and rerun it. The generated manifest directory and authored input
file are mounted read-only; neither is copied into images.

Export also writes `client-app/.env.development.local`, which `vite dev` reads over
`client-app/.env`: the Cognito settings, the Vite proxy target derived from the local API
host port, and the WebSocket tester URL. Nothing is copied by hand; keep your own client
settings in `client-app/.env` (from [its example](../client-app/.env.example)). Two WebSocket names are
written independently: VITE_LOCAL_WS_URL is always local-ws-dev-server on its host port,
because Compose runs it whatever DEPLOY_PROD_WEBSOCKET_API says; VITE_API_GATEWAY_WS_URL is
the deployment's WebSocketApiStack endpoint when DEPLOY_PROD_WEBSOCKET_API=true built one,
and is empty otherwise. The home page's tester link passes both in its query, and the tester prefills its
left panel with the local server and its right panel with the API Gateway stage.
Application requests continue to use the same-origin `/api` prefix.

Those are the initial mappings in `framework-config/client-environment.ts`. Edit them in
Studio's **Client environment** inspector, then review and apply. Each field's Dev/Prod
pills control inclusion; renames retain both environments' sources. The next export uses
the saved mappings, resolving public CDK inputs from `.env.dev` and public stack outputs
from the selected deployment. Missing required sources stop export before any file is
written. Studio edits do not run export or deployment.

### macOS (Apple silicon)

- Docker Desktop must expose the default socket, `/var/run/docker.sock`: the invocation
  runner builds and runs task images through it. `ls -l /var/run/docker.sock` should
  resolve.
- Compose images run as linux/arm64 while `npm run dev:client` runs on macOS, so the
  lockfile needs both platforms' native bindings. `npm run verify` checks them.
- Change package-lock.json only with npm 11, which ships with Node 24 and later. npm 10
  removes the lockfile's `libc` fields.
- Node 24 matches the containers. Node 25 and later work too: client-app's Vitest config
  already disables Node's own localStorage. Node 26 prints harmless DEP0205 warnings
  from tsx.
- Container targets follow `defaults.container.architecture`. With `arm64`, task and
  service images build natively. With `x86_64` they build under emulation, which
  Docker Desktop's Rosetta option speeds up.
- Commands in these guides are PowerShell unless an `sh` variant is shown. Plain `npm`
  lines work in any shell.

### Line endings (Windows and macOS)

`.gitattributes` checks every text file out with LF on every platform. Git for Windows
otherwise writes CRLF, and a bundled Lambda's source map embeds its source, so the same
commit built on Windows and on macOS gets different asset hashes and each deploy from the
other machine updates those Lambdas for nothing. A Windows checkout made before the file
existed keeps its CRLF files until they are rewritten. With a clean working tree, run once:

```powershell
git rm -rq --cached .
git reset --hard HEAD
git ls-files --eol   # every text file should show w/lf
```

## Start development

The shortest path is Framework Studio (`npm run studio`), **Deploy** tab. Choose your AWS
profile, select your development deployment, and press the action it offers: Deploy
development, then Start development. Studio exports the outputs when this machine's
settings are missing or out of date, starts Docker Desktop if it is installed and stopped,
starts the containers in the background (`npm run dev:containers -- --detach`), then runs
the source watch (`docker compose watch --no-up`) and the web client for you. Containers
keep running if Studio closes; the watch and the web client stop with it, and Studio offers
to resume them when it opens again. See [Deploy & Run](framework-studio/deploy-and-run.md).

From the command line, in one root terminal:

```powershell
npm run dev:containers
```

In another:

```powershell
npm run dev:client
```

`npm run dev:containers` runs `docker compose up --build --watch`; `npm run dev:client` is the Vite dev server.
`npm run dev:containers -- --detach` starts the same stack in the background and returns
(watch it with `docker compose watch --no-up`; stop it with `docker compose stop`).
It uses the AWS `default` profile unless you pass a profile for this run or set
`AWS_PROFILE` in the shell:

```powershell
npm run dev:containers -- --profile=<PROFILE>
```

With npm 11, `npm run dev:containers --profile=<PROFILE>` also works, but npm warns about
the unknown npm config option. The `--` form passes the flag directly to the
dev script. Use the same profile for deployment and local execution when they
must access the same AWS account.

Compose runs postgres, migration, the local API/WebSocket servers, invocation runner,
the declared services (generated into docker-compose.services.yml; see
[Framework](FRAMEWORK.md#local-service-containers)), WebSocket tester, and pgAdmin. Postgres and pgAdmin listen on 127.0.0.1 only.
Each Node Lambda you call keeps a warm process for its next call, as a warm Lambda does, up
to LOCAL_LAMBDA_WARM_MAX processes, each stopped after LOCAL_LAMBDA_WARM_IDLE_SECONDS idle;
set LOCAL_LAMBDA_WARM=false in cdk-app/.env.dev to start every call cold. See
[Framework](FRAMEWORK.md#local-resource-delivery). Services use the framework launcher, so adding
a resource environment reference or secret requires no Compose interpolation change. It applies local migrations before consumers
start, then deletes local users the current dev Cognito pool does not hold and creates the
local test user; see [Database](DATABASE.md#local-database). The React client runs separately.
Use the configured LOCAL_DEV_URL and host ports rather than assuming defaults.

The image owns Linux dependencies and generated database artifacts. Only postgres_data
is a persistent data volume. Do not mount host node_modules or the whole checkout over
image-owned dependencies. Only the invocation runner gets the Docker socket.

## What to do after an edit

| Change | Action |
| --- | --- |
| Ordinary handler/service/client source | Keep Watch and the client dev server running; the owning process reloads |
| Task/container Lambda source or Dockerfile | Watch delivers it to the runner; the next invocation builds it |
| Framework config or runner/framework source | Watch restarts affected processes; in-flight local work may stop |
| A service added, removed, or given another port or healthCheckPath; `x-framework-service` | Restart `npm run dev:containers`: it regenerates docker-compose.services.yml first |
| Manifests, lockfile, Dockerfile.dev, ignore rules, deleted files while Watch was off | Rebuild and restart with `npm run dev:containers` |
| A captured event whose handler failed every replay | Fix the handler, then `npm run replay:redrive` (`npm run replay:list` shows what is waiting) |
| Ports, outputs, local secrets | Edit cdk-app/.env.dev, rerun export, recreate containers |
| Local AWS profile | Restart with `npm run dev:containers -- --profile=<PROFILE>`; deploy that account's dev graph first if needed |
| Database contract | Follow Database planning/application steps and rebuild; Watch does not regenerate it |
| AWS event handler, Cognito, or infrastructure | Redeploy the dev graph, then re-export changed outputs |

A service's production Dockerfile is separate from Dockerfile.dev. Compose uses the
shared development image; the invocation runner uses a task's own Dockerfile when it runs.
Concurrent submissions may share a build, but each run gets its own container/input.

## Verification and troubleshooting

Set `LOCAL_TEST_USER_EMAIL` and `LOCAL_TEST_USER_PASSWORD` in ignored `cdk-app/.env.dev`
and every `npm run dev:containers` makes them a working account. Its seed-test-user
step creates the user in the dev pool if it is missing, with the email marked verified
and no invitation sent, sets its password to `LOCAL_TEST_USER_PASSWORD`, and writes
its local users row. An existing row is kept, with any name edited in the app. The
password must meet the pool's policy (12 characters). It runs only for the pool a
development export wrote to root `.env` (`LOCAL_FRAMEWORK_DEPLOYMENT`, which a production
export never writes); without both settings, or if Cognito rejects a call,
it says so in `docker compose logs seed-test-user` and changes nothing. Sign in as
this user in the browser or headlessly. Use an address you control: the account is
marked verified, so a password reset mails a code there.
These are local CLI credentials, not workload environment variables or deployment
secrets. Never set them for a production deployment or commit their values.

```sh
npm run dev:request -- POST /graphql '{"query":"{ currentUser { id email } }"}'
```

The helper refuses production mode, signs in through the existing `/sign-in`
route with the configured frontend origin, and uses the returned ID token for
one request to the local API. It prints the status and route response, without
printing the sign-in token or password. Expect HTTP 200 with the current user
from GraphQL. For an application task starter, check the task's terminal exit
code separately from submission acceptance. Use the helper to verify authenticated routes and GraphQL headlessly.
The same dedicated user can sign in through browser automation to check the UI;
headless requests do not replace browser verification.

```powershell
npm --workspace client-app run build
npm run verify
docker compose ps
docker compose logs -f local-api-dev-server local-invocation-runner
```

The offline gate does not verify credentials, container startup, or live migrations.
After startup, sign in, list/create/archive/delete a Project, reload the page, and check
that the expected changes persist. Use the framework's [invocation verification](FRAMEWORK.md#verifying-task-and-workflow-invocation)
when changing tasks or workflows.

| Symptom | Check |
| --- | --- |
| Source appears unchanged | Watch must remain attached. Inspect the file with `docker compose exec <service> cat <path>`; rebuild if stale |
| Port conflict | Change the host port in cdk-app/.env.dev, export, and recreate; container ports are fixed |
| Auth endpoints return Forbidden origin | Re-export LOCAL_BROWSER_ORIGINS and recreate containers; use the frontend's /api proxy |
| Service returns 502 | The route exists but its upstream is unavailable; inspect that service's startup logs |
| Missing table/column | Check the selected database and reviewed migrations; generation alone changes no tables |
| "A user already exists ... with a different Cognito identity" | The local row predates the current dev pool. Restart Compose; if `docker compose logs prune-cognito-orphans` says it skipped, fix the credentials or USER_POOL_ID it names |
| Google redirect fails on a LAN HTTP origin | Hosted UI needs HTTPS except loopback; use localhost or configured HTTPS |
| Prisma config missing during image installation | Use the current Dockerfile.dev, which defers root generation until its inputs exist |

`docker compose watch --no-up` attaches Watch to an already current stack. A running
container cannot reload a file that was never synchronized. Rebuild after edits/deletions
made while Watch was stopped when the image and checkout may disagree.

## Stop and reset

Use `docker compose stop` to stop or `docker compose down` to remove containers/networks.
The runner removes the task/container-Lambda containers it owns. Local run history is
in memory and is lost on runner restart. Keep the same Compose project name to reuse
postgres_data. Do not use `down --volumes` during routine updates.

A deliberate database reset requires stopping the project, identifying its exact
postgres_data volume, and removing that volume. This deletes local application data;
it is separate from rebuilding dependencies. AWS teardown is documented in
[Production](PROD-DEPLOYMENT.md#teardown), using the dev mode and account instead.

### Local images

Images are cleaned up automatically. Nothing is removed with force, so an image any
container uses, running or stopped, is kept until a later pass:

| Images | Named | Removed |
| --- | --- | --- |
| Compose development images | `<project>-<service>:latest`, labelled `com.docker.compose.project`/`service` | By `npm run dev:containers` before it starts Compose: untagged images an earlier `--build` replaced, and images of services docker-compose.yml no longer declares. The previous start's images remain until the next start |
| Task images | `matts-framework-task-<id>:<arch>` | By the runner after each build and at startup: the image a build replaced, an architecture no longer declared, a task no longer declared |
| Container-Lambda images | `matts-framework-<id>:<source hash>-<arch>` | By the runner after each build and at startup: every source hash but the current one, and Lambdas no longer declared or no longer container-packaged |

Runner images carry `com.matts-aws-framework.kind` (`task` or `lambda`), `.project` and
`.target`, so `docker image ls --filter label=com.matts-aws-framework.target=<id>` finds a
workload's image. The runner touches only images labelled with its own Compose project.
The exception is a container-Lambda image built before project labels existed, which any
runner may remove because it is only a cache. A reverted edit rebuilds from the build cache
in seconds. `--remove-orphans` removes containers of services removed from the file.
Build cache is left to Docker's builder garbage collection (`docker builder prune` reclaims
it by hand). Checkouts with the same directory name share one Compose project, and with it
these images, container names and postgres_data.
