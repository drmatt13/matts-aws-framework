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

Create `cdk-app/.env` from [the dev example](../cdk-app/.env.dev.example) if it does
not already exist. Preserve existing values when switching configurations. Set:

- PROD_DEPLOYMENT=false and a distinct CDK_APP_NAME for this deployment.
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
`PROD_DEPLOYMENT=false` in `cdk-app/.env` selects the dev graph, so no mode flag
is needed:

```powershell
npm run deploy -- --all
```

For a named AWS profile, use `aws sts get-caller-identity --profile <PROFILE>`
to check the account, then deploy with `npm run deploy -- --all --profile=<PROFILE>`.
Without a profile flag or an authored `AWS_PROFILE`, deployment uses the AWS
default credential chain.

The deploy command synchronizes only the selected graph's configured/required secrets,
supplies ARN parameters, deploys, then exports development files. Existing managed secrets
are reused when no local value is supplied; unchanged values create no version. Synth and
diff perform no secret uploads and do not require a secret-binding file. For a standalone
refresh, run `npm run export:cdk-outputs -- --profile <PROFILE> --region <REGION>`.

The dev graph holds Cognito, AWS-invoked event handlers, and replay resources. Routed
HTTP/WebSocket handlers, services, tasks, and workflows run locally; no ECS image is
published by a dev deployment. DEPLOY_WEBSOCKET_API does not turn dev mode into a cloud
workload deployment. Use a separate full cloud deployment when testing AWS routing.

Export writes root `.env` with fixed Compose controls and `.framework/local/resources.json`
with discovered development resource identifiers. It does not rewrite authored
`cdk-app/.env`. If export reports conflicting old assignments, move authored local
settings to cdk-app/.env and rerun it. The generated manifest directory and authored input
file are mounted read-only; neither is copied into images.

Create `client-app/.env` from [its example](../client-app/.env.example). Copy the public
Cognito outputs: VITE_AWS_REGION, VITE_USER_POOL_ID, VITE_USER_POOL_CLIENT_ID, and
VITE_COGNITO_DOMAIN. The Vite proxy target is derived into root .env from the local API
host port; application requests continue to use the same-origin `/api` prefix.

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

In one root terminal:

```powershell
npm run dev
```

In another:

```powershell
npm run dev:client
```

`npm run dev` runs `docker compose up --build --watch`; `npm run dev:client` is the Vite dev server.
It uses the AWS `default` profile unless you pass a profile for this run or set
`AWS_PROFILE` in the shell:

```powershell
npm run dev -- --profile=<PROFILE>
```

With npm 11, `npm run dev --profile=<PROFILE>` also works, but npm warns about
the unknown npm config option. The `--` form passes the flag directly to the
dev script. Use the same profile for deployment and local execution when they
must access the same AWS account.

Compose runs postgres, migration, the local API/WebSocket servers, invocation runner,
the example service, WebSocket tester, and pgAdmin. Postgres and pgAdmin listen on 127.0.0.1 only.
Each Node Lambda you call keeps a warm process for its next call, as a warm Lambda does, up
to LOCAL_LAMBDA_WARM_MAX processes, each stopped after LOCAL_LAMBDA_WARM_IDLE_SECONDS idle;
set LOCAL_LAMBDA_WARM=false in cdk-app/.env to start every call cold. See
[Framework](FRAMEWORK.md#local-resource-delivery). Services use the framework launcher, so adding
a resource environment reference or secret requires no Compose interpolation change. It applies local migrations before consumers
start; see [Database](DATABASE.md#local-database). The React client runs separately.
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
| Manifests, lockfile, Dockerfile.dev, ignore rules, deleted files while Watch was off | Rebuild and restart with `npm run dev` |
| A captured event whose handler failed every replay | Fix the handler, then `npm run replay:redrive` (`npm run replay:list` shows what is waiting) |
| Ports, outputs, local secrets | Edit cdk-app/.env, rerun export, recreate containers |
| Local AWS profile | Restart with `npm run dev -- --profile=<PROFILE>`; deploy that account's dev graph first if needed |
| Database contract | Follow Database planning/application steps and rebuild; Watch does not regenerate it |
| AWS event handler, Cognito, or infrastructure | Redeploy the dev graph, then re-export changed outputs |

A service's production Dockerfile is separate from Dockerfile.dev. Compose uses the
shared development image; the invocation runner uses a task's own Dockerfile when it runs.
Concurrent submissions may share a build, but each run gets its own container/input.

## Verification and troubleshooting

For headless checks, create a dedicated user through the running development
app's sign-up page, with two-step verification off. This is a dev-pool user only;
creating it is a separate authorized live action. Keep its email and password in
`LOCAL_TEST_USER_EMAIL` and `LOCAL_TEST_USER_PASSWORD` in ignored `cdk-app/.env`.
These are local CLI credentials, not workload environment variables or deployment
secrets. Never set them for a production deployment or commit their values.

```sh
npm run dev:request -- POST /graphql '{"query":"{ currentUser { id email } }"}'
npm run dev:request -- POST /test/run-task '{"message":"headless"}'
```

The helper refuses production mode, signs in through the existing `/sign-in`
route with the configured frontend origin, and uses the returned ID token for
one request to the local API. It prints the status and route response, without
printing the sign-in token or password. Expect HTTP 200 with the current user
from GraphQL and HTTP 202 from the task starter; check the task's terminal exit
code separately. Use it to verify authenticated routes and GraphQL headlessly.
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
that the expected changes persist. Use the framework's [invocation smoke checks](FRAMEWORK.md#invocation-smoke-checks)
when changing tasks or workflows.

| Symptom | Check |
| --- | --- |
| Source appears unchanged | Watch must remain attached. Inspect the file with `docker compose exec <service> cat <path>`; rebuild if stale |
| Port conflict | Change the host port in cdk-app/.env, export, and recreate; container ports are fixed |
| Auth endpoints return Forbidden origin | Re-export LOCAL_BROWSER_ORIGINS and recreate containers; use the frontend's /api proxy |
| Service returns 502 | The route exists but its upstream is unavailable; inspect that service's startup logs |
| Missing table/column | Check the selected database and reviewed migrations; generation alone changes no tables |
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
