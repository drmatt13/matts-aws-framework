# Production

This guide owns first deployment, subsequent releases, custom domains/Google setup,
and teardown. Commands run from the repository root. Replace placeholders and use the
intended account/profile/region. [Framework](FRAMEWORK.md) explains configuration semantics;
[Database](DATABASE.md) owns migration commands.

## Before deployment

Install dependencies with npm ci and verify the account with aws sts get-caller-identity.
A production deployment is a target declared in `cdk-app/cdk.json`, with its name, the
account it is pinned to, and its own inputs file:

```json
"framework:targets": {
  "my-aws-app-prod": { "mode": "prod", "account": "<12-digit id>", "region": "us-east-1", "inputs": "cdk-app/.env.prod" }
}
```

Every command states production with `-c prodDeployment=true`; with one production target
declared it is selected automatically, and `-c deployment=<name>` picks among several. A synth
for any other account than the pin is refused. Create the inputs file from
[the production template](../cdk-app/.env.prod.template) as `cdk-app/.env.prod` (or generate
it from Studio's CDK environment files island), preserving existing configuration rather than
blindly overwriting it. Development keeps its own file (`cdk-app/.env.dev`), so the two never
share settings or secret values. Set:

- USE_FRONTEND_CUSTOM_DOMAIN=false to use the generated HTTPS CloudFront hostname,
  or true with FRONTEND_URL and FRONTEND_CLOUDFRONT_CERTIFICATE_ARN for a custom domain.
- Optional Cognito custom-domain/certificate pair and Google credentials.
- RETAIN_STATEFUL_RESOURCES deliberately. The resolver defaults to false; use true when
  Cognito/RDS data and the database secret must survive stack removal. Either way the
  database keeps DATABASE_BACKUP_RETENTION_DAYS of automated backups (7 by default), and
  deleting it without retention leaves a final snapshot.
- COGNITO_SES_FROM_EMAIL, an address or domain already verified in Amazon SES. Cognito's
  built-in sender stops after about 50 messages a day, which ends sign-up verification and
  password reset for everyone; synth warns while it is unset.
- WebSocket deployment settings and any cloud-enabled workload inputs. The example
  service and example agent are local-only until their declarations enable cloud deployment. SKIP_EMAIL_VERIFICATION is
  refused in production.

Both hostname choices serve the frontend and same-origin /api, with Cognito callback,
logout and trusted-origin settings matching that frontend. For a deployment without
owned domains, set USE_FRONTEND_CUSTOM_DOMAIN=false and USE_COGNITO_CUSTOM_DOMAIN=false;
no domain name or ACM certificate is required. Use the website stack's CloudFrontUrl output
to open the deployed client after publishing it. A generated-domain deployment populates
CloudFront's routing store automatically during deployment; there is no separate setup command.

A deployment never changes mode: deploy refuses a dev synth over a production deployment's
stacks (and the reverse), so development always runs under its own name.

```powershell
npm --workspace client-app run build
npm run verify
npm --workspace cdk-app exec -- cdk synth -c prodDeployment=true --profile <PROFILE> --quiet
npm --workspace cdk-app exec -- cdk diff -c prodDeployment=true --profile <PROFILE>
```

Review resource replacements, IAM, networking, and retention before deploying. The
database is private: it sits in the isolated subnets of the framework network, is not
publicly accessible, and admits only workloads that declare `database: true`. They log in
with IAM as `app_user`, each signing a short-lived token, over TLS verified against the
Amazon RDS certificate authorities; no workload holds a database password. Nothing outside
the VPC reaches it, your machine included, which is why migrations run as a task. See
[Framework](FRAMEWORK.md#network-and-database).

## Database infrastructure

The production template documents all `DATABASE_*` inputs. The resolver accepts the same
camelCase context keys, such as `-c databaseInstanceClass=db.m7g.large`, with context taking
precedence over environment and defaults. Defaults retain the existing small deployment:
PostgreSQL 16, db.t3.micro, gp2, 20 GiB, a 100 GiB autoscaling ceiling, seven-day backups,
one writer, no Proxy, no replicas and no log exports.

For an application that must survive an AZ outage, enable `DATABASE_MULTI_AZ` and choose
an instance sized for its measured load; the small default is not a capacity recommendation.
Set `RETAIN_STATEFUL_RESOURCES=true` when data must survive stack removal. Multi-AZ provides
a standby for failover, not read capacity. Add `DATABASE_READ_REPLICA_COUNT` (0–15) to scale
explicit replica reads; backup retention must be positive. Replicas inherit writer storage
and encryption and can override class and Multi-AZ independently. Initial allocation inherits
the writer's actual size, including previous autoscaling; subsequent storage autoscaling is
independent on each instance with the configured ceiling. Retained replicas have
deletion protection; unretained replicas are deleted without a final snapshot. CloudFormation
documents replica deletion-policy limitations: treat writer backups as the recovery source
and keep replica deletion protection enabled when removal must be prevented. See the
[DBInstance reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-rds-dbinstance.html#cfn-rds-dbinstance-sourcedbinstanceidentifier).

`DATABASE_STORAGE_TYPE` accepts gp2, gp3 or io2. gp3 is a useful choice for new deployments;
custom PostgreSQL gp3 IOPS/throughput starts at 400 GiB. io2 requires explicit IOPS and at
least 100 GiB. Autoscaling can be disabled with `DATABASE_MAX_ALLOCATED_STORAGE_GIB=0`;
otherwise its ceiling must be at least 10% above allocated storage. Storage cannot shrink.
Validation enforces documented combinations; AWS determines engine/class/region availability
and instance performance ceilings. Consult the
[AWS storage rules](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html).

`DATABASE_ENGINE_VERSION` accepts major or major.minor versions. Major upgrades require
`DATABASE_ALLOW_MAJOR_VERSION_UPGRADE=true` and a reviewed compatibility plan.
`DATABASE_AUTO_MINOR_VERSION_UPGRADE=true` retains current behavior. Optional UTC backup
and weekly maintenance windows must last at least 30 minutes and not overlap. When
`DATABASE_APPLY_IMMEDIATELY` is omitted, CDK behavior is preserved; explicitly setting it
may change when supported updates take effect. Maintenance, scaling and failover can
interrupt connections, including with Multi-AZ and Proxy. Review replacements and pending
modifications in the deployment diff and RDS console before a release.

`DATABASE_PROXY_ENABLED=true` routes application writers through an additional billed
service with end-to-end IAM and TLS. Bootstrap and migrations remain direct; replicas also
remain direct. Its default limits are 90% of database connections, 15 seconds borrowing
timeout, and 1800 seconds client idle timeout. Reserve database headroom for direct clients
and monitor pinning before relying on multiplexing. No database password reaches workloads.
`DATABASE_CLOUDWATCH_LOGS_EXPORTS=postgresql,upgrade` enables optional logs with configurable
retention (30 days by default). Development ignores these provisioning options and creates
no RDS, replicas or Proxy.

Monitor RDS `DatabaseConnections`, `CPUUtilization`, `FreeableMemory`, `FreeStorageSpace`,
I/O latency and storage headroom; replicas' `ReplicaLag`; and Proxy
`DatabaseConnectionsCurrentlySessionPinned`, `DatabaseConnectionsBorrowLatency`,
`ClientConnections` and `DatabaseConnections`. Alert thresholds depend on measured workload,
instance capacity and freshness requirements. Include all warm environments and both pools
when setting application connection limits.

Offline tests and synth verify the graph, not live connectivity or failover. After a separately
authorized deployment to the intended environment, validate:

1. Invoke a declared writer workload, confirm IAM login/TLS and a query succeeds, and check
   an undeclared workload has no connection permission or network path.
2. Invoke an explicit reader workload with replicas configured, record the selected endpoint,
   perform a writer update, and observe its eventual appearance and replica lag. Use the
   writer for immediate consistency. Do not inject faults into production without authorization.
3. With Proxy enabled, confirm application writers use Proxy and migrations use the direct
   endpoint. Under an approved representative concurrency test, measure borrowing latency,
   backend connections and session pinning; inspect logs for authentication failures.
4. In an explicitly authorized test environment, request a Multi-AZ failover, observe the
   writer endpoint, connection interruption and recovery, and verify application handling.
   Transactions can fail; this framework adds no query or transaction retries.

Aurora, named databases, cross-region replication and automatic read routing are later
extensions. This release keeps one logical PostgreSQL database and the `app_user` ownership
model. Database names and custom parameter groups belong in application CDK source.

## Custom domains and Google

For a custom frontend or Cognito hostname, issue a matching ACM certificate in us-east-1
in the deployment account. Keep its DNS validation records and wait for ISSUED. The
Cognito custom-domain parent must resolve before creation. See
[AWS Cognito custom-domain requirements](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html).

For a new domain whose parent/apex does not resolve, bootstrap the frontend distribution:

1. Temporarily set USE_FRONTEND_CUSTOM_DOMAIN=false, preserving the configured values.
2. Deploy the production resources with USE_COGNITO_CUSTOM_DOMAIN=false too:

   ```powershell
   npm run deploy:resources -- --all -c prodDeployment=true --profile <PROFILE>
   ```

3. Read its CloudFrontDomainName output and point the apex to it with your provider's
   alias/flattened record. Keep records DNS-only for this documented configuration.
4. Confirm the parent resolves, then restore USE_FRONTEND_CUSTOM_DOMAIN=true and the
   intended Cognito custom-domain setting, and deploy again. Existing distribution and
   user-pool identities are preserved when changing hostname settings.

This uses the actual distribution for parent DNS instead of a documentation-only IP.
For first-time Cognito custom-domain creation, do not point its hostname at the frontend
or an old CloudFront distribution. Create the Cognito DNS alias after deployment returns
its own target. A conflicting distribution/DNS alias can cause a generic InvalidRequest;
see [AWS's CloudFront troubleshooting](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/troubleshooting-distributions.html).

For Google, configure a Web application OAuth client and put its credentials only in
backend deployment inputs. Keep the two redirect URLs distinct:

| Purpose | Example |
| --- | --- |
| Google authorized redirect URI | https://auth.example.com/oauth2/idpresponse |
| Cognito app-client callback | https://example.com/auth/callback |

With a generated Cognito domain, use that domain in the Google URI. If Google consent is
in testing mode, include the intended test accounts. Start real sign-in from the application's
login button so state and PKCE are present. Preserve Cognito's emailVerified mapping for
federated identity checks. Auth implementation details live in [Framework](FRAMEWORK.md#authentication).

## Deploy

```powershell
npm run deploy:resources -- --all -c prodDeployment=true --profile <PROFILE>
```

The command validates the synthesized graph and target account, resolves existing managed
secrets, uploads supplied changes, and deploys that assembly with complete ARN parameters.
It validates all required inputs and secret ownership before uploading. Secret names are
preserved and removed declarations never delete secrets. A failed deployment reports any
secret updates already performed. Synthesis and diff require no secret-binding file and
perform no uploads.

Before the first secret upload, deploy also checks what CloudFormation holds under the
deployment's name, and it refuses:

- a deployment that is currently dev mode;
- stacks without a framework identity;
- stacks whose identities disagree;
- a deployment still changing or awaiting recovery.

See [Development](DEV-DEPLOYMENT.md#first-setup) for the rules.

A production deploy also refuses `--hotswap`, `--hotswap-fallback`, `--no-rollback` (`-R`),
`--express`, `--yes` (`-y`) and `--require-approval never`. Hotswap, express and no-rollback
deploys skip CloudFormation's safety. The approval flags would accept IAM and security
changes nobody reviewed. For a reviewed production deployment, plan first and apply exactly what was reviewed:

```powershell
npm run deploy:resources -- --all -c prodDeployment=true --profile <PROFILE> --plan .cache/plans/prod
npm run deploy:resources -- --apply .cache/plans/prod --confirm <NAME> --profile <PROFILE>
```

`--plan` synthesizes into the plan directory, runs every check, and prepares CloudFormation change
sets (which modify no resource) so the review shows CloudFormation's own replacement decisions. It
writes `plan.json`: per-resource changes, secrets by name, IAM broadening, exports other stacks still
import, container images, and what the review cannot know. A stack that imports from a stack the plan
creates is deferred until that stack exists. Planning needs every managed secret to exist: when one is
new, plan again with `--create-secrets`. `--apply` refuses a plan older than a day, a plan whose stacks
changed since the review, an obsolete change set, or secret values that changed; consequential
production changes (removals, replacements, stateful resources, IAM broadening, exports in use, a first
deployment) need `--confirm <NAME>`. After deploying, AWS is checked: every stack must have completed
with this deployment's identity and the reviewed template. `--discard <dir>` removes a plan's change
sets and the empty stacks it created. [Deploy & Run](framework-studio/deploy-and-run.md) has the design.

Production deployment does not automatically export root .env or a local resource manifest. Retrieve
public deployment outputs directly from CloudFormation or the CDK deployment output:

```powershell
aws cloudformation describe-stacks --stack-name <CDK_APP_NAME>-CognitoStack --query 'Stacks[0].Outputs' --region <REGION> --profile <PROFILE>
```

Use the same command for FrontendWebsiteS3Stack and RdsStack as needed. Their established
output names and stack identities are unchanged. Do not copy production outputs into the
development manifest. To export production frontend settings and public deployment outputs
without starting containers, run:

```powershell
npm run export:cdk-outputs -- --deployment <NAME> --profile <PROFILE>
```

The command detects the mode from deployed metadata. In production it writes
`.framework/prod/outputs.json` (public outputs, including the frontend bucket and
distribution used for publishing) and `client-app/.env.production.local`, which
`vite build` reads over `client-app/.env`. It never touches root `.env` or the development
resource manifest, which belong to local development. Both output files are ignored by Git;
no secrets are exported.

For custom DNS, use the deployment output targets:

| Hostname | Target |
| --- | --- |
| Frontend origin | CLOUDFRONT_DOMAIN_NAME |
| Custom Cognito origin | COGNITO_DOMAIN_CLOUDFRONT_ENDPOINT |

These are different distributions. An apex needs an alias/flattened record; a subdomain
can use CNAME. Verify resolution and Cognito's domain state before browser testing:

```powershell
Resolve-DnsName example.com
Resolve-DnsName auth.example.com
aws cognito-idp describe-user-pool-domain --domain auth.example.com --region <REGION> --profile <PROFILE>
```

## Database release

Review the planned migration and compatibility with both old and new application versions.
For changes requiring staged rollout or backfill, choose that order before deployment;
a universal deploy-then-migrate sequence is not safe for every schema change. On first
installation, the schema must exist before sign-up/sign-in provisions an application user.

Plan and review the migration offline first, following
[Database](DATABASE.md#changing-storage). Then apply it with the `db-migrate` task, which
runs inside the network:

```sh
npm run db:migrate:cloud -- --profile <PROFILE>
```

It launches the task through the descriptor the deployment published, waits for it, and
exits with Prisma's exit code; the task's log is in CloudWatch under the `db-migrate` stream
prefix. The task declares `database: { connection: "direct" }`, bypasses Proxy, and logs in with IAM, so no
credential reaches your machine. The deployment creates the `app_user` login it uses, so on a
first installation deploy before migrating. `npm run task:cloud -- <task-id>` launches any
other cloud-enabled task the same way.

A failed migration or incompatible release needs its own recovery plan; redeploying an old
frontend does not undo data changes. Do not use direct schema synchronization as a substitute
for reviewing a production migration.

## Publish the client

Export, then build: `vite build` reads `client-app/.env.production.local`, which export
wrote. It holds the production Cognito region, pool, client and domain; the CloudFront
URL as VITE_API_GATEWAY_URL, which only the Vite dev server's proxy reads; the deployed
WebSocket endpoint as VITE_API_GATEWAY_WS_URL when DEPLOY_PROD_WEBSOCKET_API is on; and empty
VITE_LOCAL_WS_URL and tester URLs, since neither Compose service runs. Empty values
clear local defaults that do not apply. A browser always calls same-origin /api; no
deployed cross-origin API URL is needed.

```powershell
npm run export:cdk-outputs -- --deployment <NAME> --profile <PROFILE>
npm --workspace client-app run build
aws s3 sync client-app/dist s3://<FRONTEND_WEBSITE_BUCKET_NAME> --delete --profile <PROFILE>
aws cloudfront create-invalidation --distribution-id <CLOUDFRONT_ID> --paths "/*" --profile <PROFILE>
```

The sync deletes remote files absent from this build. Use only the intended frontend bucket.
Ship coupled auth changes (cookies, PKCE, refresh rotation, /api behavior) with the matching
frontend in one release window. Build release assets before infrastructure changes when
possible; on initial setup, first obtain the public outputs needed by the build.

## Verify the release

- Test direct navigation to a nested frontend route and confirm /api errors remain API errors.
- Sign in, reload, exercise session refresh, and sign out. Test Google if configured.
- List/create/archive/delete a Project and reload to confirm persisted results. Test with two
  accounts when changing ownership behavior; one account must not mutate the other's records.
- Run db:verify for the selected database. Check relevant Lambda/container logs.
- For invocation changes, follow [task/workflow verification](FRAMEWORK.md#verifying-task-and-workflow-invocation)
  and record terminal results, not only submission acknowledgements.

Offline verify, CDK synth, and successful deployment each check different things. Report
which were actually performed; none alone proves browser or live database behavior.

## Routine updates and recovery

For an existing deployment, review changes, verify/build, synth/diff, apply the reviewed
release/migration order, deploy affected stacks, re-export changed outputs, publish changed
client assets, and smoke-test. Use `cdk list` to identify exact stack names. A single-stack
deploy may deploy dependencies; use --exclusively only after reviewing what must co-release.
The async/event stack keeps its historical AsynchronousLambdaFunctionsStack suffix.

| Failure | Investigation |
| --- | --- |
| Cognito custom-domain InvalidRequest | Inspect DNS and current domain/distribution ownership, certificate region/coverage, and CloudFormation events; remove only a confirmed conflicting old record |
| Hosted UI returns frontend HTML | The auth hostname points at the website distribution instead of Cognito's target |
| Google succeeded but callback fails | Check redirect URI, state/PKCE, emailVerified mapping, application tables, and callback logs |
| API Gateway 401 | Check ID-token audience/issuer/expiry and Authorization header |
| Auth endpoint 403 | Check trusted-origin settings and the same-origin /api route |
| Lambda 500 on first sign-in | Check RDS connectivity/credentials and whether reviewed migrations were applied |
| Local works but prod synth fails | Inspect prod-only resources/dependency edges and root esbuild resolution |

Do not delete a live Cognito stack as routine domain-error recovery. A failed fresh stack
may require CloudFormation cleanup, but first inspect its state, existing users, retention,
and dependent resources. Custom-domain CloudFront creation/deletion can take time.

## Teardown

Teardown is a separate deliberate action. Without RETAIN_STATEFUL_RESOURCES the database is
deleted with a final snapshot, and its automated backups are kept for their retention window.
First see what would be deleted, in which order, and what would remain:

```powershell
npm run destroy:resources -- --deployment <NAME> -c prodDeployment=true --profile <PROFILE> --plan
npm run destroy:resources -- --deployment <NAME> -c prodDeployment=true --profile <PROFILE> --confirm <NAME>
```

The stacks are the ones whose own records name the deployment, found in AWS rather than by
synthesizing the current source, so a renamed or removed stack is still deleted and no Docker
is needed. The mode must be stated and must match what is deployed; omit `-c prodDeployment=true`
for a development deployment. Importers are deleted before the stacks they import from.
Termination protection is switched off only after the typed confirmation. Stacks named like
the deployment's but without its identity are left in place. A stack that fails to delete
stops the teardown and names the resources CloudFormation could not remove; `--retain-failed`
keeps those and deletes the rest. Managed secrets are kept (a returning deployment reuses them),
the deployment record is removed, and anything still tagged `framework:deployment=<NAME>`
afterwards is listed. Avoid custom
Cognito domains for disposable deployment tests when domain lifecycle is not under test.
