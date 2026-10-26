# Client settings, deployment names and frontend release

In **Deploy**, select the intended deployment/profile/region. Open **Client environment & frontend release** to refresh public settings or build a static frontend. Docker is not a prerequisite when completed deployed outputs exist.

**Generate / refresh client env** uses the existing output exporter and the selected target's authored inputs, including a named target's custom `inputs` path. It writes only the selected project's `.env.development.local` or `.env.production.local`; it does not modify root `.env`, the local resource manifest or authored CDK inputs. Public mapping recipes remain in `framework-config/client-environment.ts`; secret declarations, secret-like input names and nonpublic stack outputs are refused. The separate ordinary development export continues to own Compose settings and resource identifiers.

Client input mappings use declared public catalog parameters, including their selected-mode
presence, defaults and enum choices. CDK files supply those parameters; they are not direct
client mapping sources. An optional `when: { input, equals }` condition writes an empty
value when its selecting parameter does not match. `VITE_LOCAL_WS_URL` uses
`enableWebSocketApi` as its switch and `client.webSocketPort` to construct the URL.

The same public-only CLI action is available without Studio:

```powershell
npm run export:cdk-outputs -- --deployment <NAME> --profile <PROFILE> --region <REGION> --client-only
```

An alternate frontend can add `--client-env-file web/.env.production.local`. The exporter detects the deployed mode and refuses a contradictory `--expected-mode dev|prod`. Authored input files, root environment and the resource manifest cannot be used as client destinations.

**Frontend project and publication settings** reviews changes to `framework-config/frontend-release.json`. It contains an existing package.json script, arguments, project directory, generated output directory, include/exclude globs, bucket prefix, optional remote deletion and CloudFront invalidation paths. The bucket/distribution are resolved from the selected deployment's website-stack outputs; pasting another destination into browser settings is not supported. The reference project uses TanStack/Vite; another package script can produce Astro, Next static export or ordinary HTML. Its script must load the generated public env file if it needs those settings. Server-rendered processes are not static publication artifacts.

**Build & review release** performs these local/read-only steps:

1. Resolve STS account, completed identity-bearing CloudFormation stacks, target pins, public outputs and bucket owner.
2. Check that output is an untracked generated directory, outside reserved source/public/configuration folders. Existing source/config files or linked paths block the build before any output is moved.
3. Generate public client env, preserve previous output under the release's cache directory, then run the configured project script without a shell. A successful no-op cannot reuse stale output.
4. Validate/filter static output, stage exact bytes and hash every file. `.env*`, `.git` and `node_modules` content is always excluded; source maps are excluded by default.
5. Recheck output identity, authored-input/mapping/package hashes and settings. Show exact bucket/prefix/account/region, file hashes, optional delete keys, invalidation paths, expiry and rollback limits.

No upload happens during these steps. Review expires after 15 minutes. Type the displayed `Publish <deployment> to <bucket>` approval to publish. A production publication still requires the user's separate authorization for that exact operation and destination; infrastructure approval does not imply it.

Publication rechecks destination, input sources, settings, bucket owner and staged bytes. CloudFormation's physical resource list must bind the bucket/distribution to this website stack; CloudFront's actual account, enabled state and S3-origin configuration must match. That configuration and its ETag are bound to the review. Every S3 PutObject includes the expected bucket owner and reviewed SHA256 checksum. It uploads assets before HTML, optionally deletes only reviewed obsolete keys with their reviewed ETags and expected bucket owner, then calls **CloudFront create-invalidation** with a release-specific idempotency token. This does not clear a CloudFormation cache. ETag mismatch or an AWS failure stops dependent steps. CloudFront invalidation retry uses the same token; confirmed upload/deletion progress is preserved. No automatic rollback or object-version restoration runs.

A saved review also binds the identity-bearing stacks' IDs, status and public outputs. A backend update that changes those observations can invalidate a frontend review even if the bucket name stays the same. A stale review refuses before uploads; use **Build & review release** again against the current deployment. Starting a new action clears the preceding action's transient message; use the saved release result to distinguish a local build, confirmed uploads, invalidation submission and application checks.

Atomic durable review/result files live under `.cache/framework-studio/frontend-releases/<id>/`. Recent outcomes remain visible after restart. An interrupted uploading/deleting/invalidating phase has an uncertain outcome; inspect AWS before a new review. An old process's review is not automatically resumed. Corrupt or missing result evidence is reported as unknown rather than as no operations. Previous output backups are retained there for manual review/recovery; they are not a deployed rollback.

An invalidation ID/status proves submission, not cache completion. The observed HTTP status is separate from actual application/sign-in health. Test the released application and auth flows, and inspect CloudFront completion separately. Prefix publication probes the selected URL beneath that prefix.

In **Development & production deployment names**, create a *new* independent deployment identity. Review the cdk.json change and any CDK_APP_NAME edit before applying source. Existing targets stay intact. When the personal development default changes, its previous identity becomes an explicit dev target so it remains selectable. New names may create new infrastructure and costs when separately deployed; they do not move users, data, outputs or physical infrastructure. Production/staging identity remains the `framework:targets` key in cdk.json; `.env.prod` CDK_APP_NAME is not a second authority. Missing mode-specific inputs are initialized from that mode's template, preserving existing files, comments and secret values. Arbitrary existing-resource rename/adoption is deliberately unavailable.
