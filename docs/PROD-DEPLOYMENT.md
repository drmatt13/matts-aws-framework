# Production

This guide owns first deployment, subsequent releases, custom domains/Google setup,
and teardown. Commands run from the repository root. Replace placeholders and use the
intended account/profile/region. [Framework](FRAMEWORK.md) explains configuration semantics;
[Database](DATABASE.md) owns migration commands.

## Before deployment

Install dependencies with npm ci, verify the account with aws sts get-caller-identity,
and create cdk-app/.env from [the production example](../cdk-app/.env.prod.example).
Preserve existing configuration rather than blindly overwriting it. Set:

- PROD_DEPLOYMENT=true and the environment's stable CDK_APP_NAME.
- USE_FRONTEND_CUSTOM_DOMAIN=true, FRONTEND_URL, and FRONTEND_CLOUDFRONT_CERTIFICATE_ARN
  for the supported same-origin browser/API deployment.
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

Current limitation: a generated CloudFront URL without a configured frontend domain serves
static files but has no /api behavior. It is useful for bootstrap, not a complete browser
auth deployment. This guide does not change that infrastructure behavior.

Do not switch an existing production deployment to dev mode as a local-development shortcut:
it can remove resources from that stack graph. Use a separate deployment name/account for dev.

```powershell
npm --workspace client-app run build
npm run verify
npm --workspace cdk-app exec -- cdk synth -c useLocalDevStack=false --profile <PROFILE> --quiet
npm --workspace cdk-app exec -- cdk diff -c useLocalDevStack=false --profile <PROFILE>
```

Review resource replacements, IAM, networking, and retention before deploying. The
database is publicly reachable on port 5432 by design: the framework's Lambdas run outside
any VPC and reach it over its public endpoint, as do migrations from your machine. It is
guarded by its generated password and by TLS, which RDS enforces and which deployed
handlers verify against the Amazon RDS certificate authorities (`sslmode=verify-full`).
Narrowing the security group needs Lambdas inside the VPC.

## Custom domains and Google

For a custom frontend or Cognito hostname, issue a matching ACM certificate in us-east-1
in the deployment account. Keep its DNS validation records and wait for ISSUED. The
Cognito custom-domain parent must resolve before creation. See
[AWS Cognito custom-domain requirements](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html).

For a new domain whose parent/apex does not resolve, bootstrap the frontend distribution:

1. Temporarily set USE_FRONTEND_CUSTOM_DOMAIN=false, preserving the configured values.
2. Deploy only the website stack:

   ```powershell
   npm --workspace cdk-app exec -- cdk deploy <CDK_APP_NAME>-FrontendWebsiteS3Stack -c useLocalDevStack=false --profile <PROFILE>
   ```

3. Read its CloudFrontDomainName output and point the apex to it with your provider's
   alias/flattened record. Keep records DNS-only for this documented configuration.
4. Confirm the parent resolves, then restore USE_FRONTEND_CUSTOM_DOMAIN=true.

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
npm run deploy -- --all -c useLocalDevStack=false --profile <PROFILE>
```

The command validates the synthesized graph and target account, resolves existing managed
secrets, uploads supplied changes, and deploys that assembly with complete ARN parameters.
It validates all required inputs and secret ownership before uploading. Secret names are
preserved and removed declarations never delete secrets. A failed deployment reports any
secret updates already performed. Synthesis and diff require no secret-binding file and
perform no uploads.

Production deployment does not export root .env or a local resource manifest. Retrieve
public deployment outputs directly from CloudFormation or the CDK deployment output:

```powershell
aws cloudformation describe-stacks --stack-name <CDK_APP_NAME>-CognitoStack --query 'Stacks[0].Outputs' --region <REGION> --profile <PROFILE>
```

Use the same command for FrontendWebsiteS3Stack and RdsStack as needed. Their established
output names and stack identities are unchanged. Do not copy production outputs into the
development manifest; standalone development export rejects production metadata.

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

After RDS exists, retrieve its credentials into memory without printing them. For example,
using the RdsCredentialsSecretArn output from the RDS stack:

```powershell
$databaseSecret = aws secretsmanager get-secret-value --secret-id <RDS_CREDENTIALS_SECRET_ARN> --region <REGION> --profile <PROFILE> --query SecretString --output text | ConvertFrom-Json
Invoke-WebRequest https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -OutFile "$env:TEMP\rds-global-bundle.pem"
$env:DATABASE_URL = "postgresql://$([uri]::EscapeDataString($databaseSecret.username)):$([uri]::EscapeDataString($databaseSecret.password))@$($databaseSecret.host):$($databaseSecret.port)/$($databaseSecret.dbname)?sslmode=verify-full&sslrootcert=$([uri]::EscapeDataString("$env:TEMP\rds-global-bundle.pem"))"
```

On macOS or Linux:

```sh
database_secret="$(aws secretsmanager get-secret-value --secret-id <RDS_CREDENTIALS_SECRET_ARN> --region <REGION> --profile <PROFILE> --query SecretString --output text)"
rds_bundle="${TMPDIR:-/tmp}/rds-global-bundle.pem"
curl -fsSL -o "$rds_bundle" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export DATABASE_URL="$(DATABASE_SECRET="$database_secret" RDS_BUNDLE="$rds_bundle" node -e '
const s = JSON.parse(process.env.DATABASE_SECRET);
const e = encodeURIComponent;
process.stdout.write(`postgresql://${e(s.username)}:${e(s.password)}@${s.host}:${s.port}/${s.dbname}?sslmode=verify-full&sslrootcert=${e(process.env.RDS_BUNDLE)}`);
')"
```

Afterwards: `unset DATABASE_URL database_secret`.

The example verifies the server certificate against AWS's published RDS certificate
bundle, the same authorities deployed handlers use.
With DATABASE_URL set for the intended environment, follow
[Database's application and verification steps](DATABASE.md#changing-storage). Remove the
process variable and credential variable afterwards. Do not commit or echo the connection.

A failed migration or incompatible release needs its own recovery plan; redeploying an old
frontend does not undo data changes. Do not use direct schema synchronization as a substitute
for reviewing a production migration.

## Publish the client

Copy public outputs into client-app/.env using [its example](../client-app/.env.example):
VITE_AWS_REGION, VITE_USER_POOL_ID, VITE_USER_POOL_CLIENT_ID, and VITE_COGNITO_DOMAIN.
A browser always calls same-origin /api; no deployed cross-origin API URL is needed.

```powershell
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
- For invocation changes, run the [task/workflow smoke checks](FRAMEWORK.md#invocation-smoke-checks)
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

Teardown is a separate deliberate action. Confirm account, mode, deployment name, and
retention before executing. Without RETAIN_STATEFUL_RESOURCES the database is deleted with a
final snapshot, and its automated backups are kept for their retention window:

```powershell
npm run destroy -- --all -c useLocalDevStack=false --profile <PROFILE>
```

Review CDK's confirmation list. Use useLocalDevStack=true for a dev graph. Retained resources
can remain after stacks disappear; inspect CloudFormation and resource state. Avoid custom
Cognito domains for disposable deployment tests when domain lifecycle is not under test.
