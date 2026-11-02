# AWS connections

Studio uses the machine's AWS CLI configuration and authentication caches. The navbar
associates a named profile with each declaration mode; both modes may share one profile.
Only these local names are stored in repository-scoped browser preferences. Account
observations, credentials, tokens and authentication links are not stored there.

Declaration mode, connection, deployment target and operation approval are separate.
Every operational page uses the active declaration mode's association, even when its
explicit destination uses another mode. Target account/region and ownership checks remain
authoritative. Selecting a target never restores an older per-target profile. Changing
the connection expires evidence/reviews and requires an explicit refresh before resource
discovery. Running operations retain their captured connection.

## Profile management

Open the navbar chevron, then Configure AWS profiles. The dialog discovers safe metadata
without testing every profile. It shows profile usage, configured methods, source-role
relationships, file editability and cached connection observations. Test connection checks
the selected profile. The icon-only refresh reloads configuration metadata without checking
credentials; its spinner lasts at least one second. The viewport-bounded dialog keeps its
height while profiles change, with scrolling within the list/details and reserved feedback
space for association changes and errors.

Add profile offers Console sign-in, IAM Identity Center, an IAM role, and guidance for
access keys or external providers. Creating/authenticating a profile does not select it:
use the explicit Development/Production actions afterward.

- Console sign-in runs native `aws login` and stages its configuration changes. A changed
  Console principal requires confirmation and a reviewed profile edit.
- Identity Center reuses or configures an `sso-session`, runs native `aws sso login`, then
  lists assigned accounts and permission sets through official SDK token/SSO providers.
  SSO region and workload region are separate settings.
- Role profiles declare an existing source profile and role ARN. Existing MFA/external
  sources remain native-provider workflows; Studio does not collect MFA codes.
- Existing access-key, temporary-key, process and web-identity profiles can be used and
  diagnosed. Configure secrets and arbitrary provider commands in the native terminal.
  Studio has no browser credential-entry or general INI editor.

Supported non-secret changes require a review. The writer preserves unrelated text,
comments and line endings and checks both original files before atomic config replacement.
Ambiguous touched definitions, linked/read-only files and credentials-file-owned settings
remain externally managed. Renaming and method conversion are outside this release.
Removing a mode association does not remove the AWS profile.

Each profile card has a Delete action with explicit confirmation. Its review identifies
which AWS files contain the profile and any Development/Production associations that will
be cleared. Applying removes only that profile's sections from the effective config and
credentials files; shared sessions, caches, unrelated profiles and standalone comments stay
intact. Source-profile dependents, active operations/sign-in, managed or ambiguous files,
links and read-only files block deletion. A stale review writes nothing. Each file is
replaced atomically; a multi-file failure compensates completed replacements only when
their bytes still belong to Studio. If an external edit prevents compensation, private
`.studio-profile-delete-*.restore` copies retain the originals for manual recovery.
Deletion never selects a replacement profile or signs out native sessions.

## Identity and session meaning

Identity verified means STS identified an account and principal at the displayed time.
It does not establish authorization for deployment or any other service operation.
Transport failures retain a labeled stale observation; they do not prove a session expired.
An explicit Test connection also requests expiration metadata from native credential
resolution when supported. Only the expiration timestamp is returned; failed or unsupported
expiration lookup keeps the verified identity and an unknown expiration. This separately
observed provider timestamp is distinct from upstream session expiry.

Connect/Reconnect operates on the upstream native session. Related profiles share one
attempt. Native Console logout can affect profiles sharing its session. Native SSO logout
affects all Identity Center sessions; the reviewed action states that scope. Already-issued
role credentials may remain valid after logout. Canceling a local authentication attempt
cannot guarantee that native shared caches were unchanged.

The catalog reports installed CLI capabilities. Credential export and modern SSO require
CLI 2.9.0; PKCE is preferred from 2.22.0; Console login requires 2.32.0. Unsupported native
interactions offer a terminal handoff rather than accepting arbitrary input through Studio.

## Backend boundaries

`scripts/aws-connections.ts` owns host-only discovery, source/region policy, private CLI
execution, identity formatting and a refreshable SDK credential provider. The compatibility
`aws-profiles.ts` projection remains available to repository scripts.

Explicit named-profile execution removes unrelated inherited credential selectors and
disables metadata fallback. A declared Environment/EC2/ECS credential source retains its
intentional inputs. Regions resolve as explicit operation/target, AWS_REGION,
AWS_DEFAULT_REGION, then profile region. Trusted AWS identity checks ignore configured
endpoint overrides. Standalone commands without an explicit profile retain ambient behavior.

Host SDK calls can use native `aws configure export-credentials --format process` through
a private refreshable provider, sharing native CLI role/MFA cache behavior. Credentials
stay in backend memory. Sensitive helpers use restrictive temporary copies of both AWS
files with CLI history disabled; copies are removed by their owner and scoped recovery.
Native login/SSO cache locations remain native. Original AWS files are changed only by
explicitly applying a configuration or deletion review.

`server/aws-connections` owns the guarded `/api/aws-connections` catalog, POST checks,
ephemeral authentication sessions, profile review/apply/discard, deletion review/apply
and logout review/apply. Deletion reviews expose file kinds and safe blockers, never file
contents or credential fields.
It never sends raw files, provider commands, raw subprocess errors or credentials to the
browser/log stream. Shared-session leases coordinate Studio processes. Existing token,
Host/origin and mutation-protocol checks protect these endpoints.

Credential lifecycle events invalidate observations and pending reviews; they never replay
mutations. Source/config hashes and target/account checks are repeated at effect boundaries.
Saved deployment plans bind their profile and observed caller ARN. Older plans without
caller evidence require a new plan before application; discard remains available.
Switching actor requires a new review. Frontend publication also binds its observed caller.

## Local execution and verification

Local processes keep their launch-time profile. Changing the browser selection requires
an explicit restart to change that launch context. Containers still use native SDKs and
the existing read-only AWS mount; host sign-in alone does not prove container cache refresh
or availability of external provider executables. No credential proxy or broader mount is
introduced.

Offline fixtures cover catalog/precedence, private exports, authentication coordination,
preserving writes and browser workflows. Real Console/Identity Center sign-in, role/MFA,
Docker provider compatibility and deployed authorization require separately reported live
checks. Implementation and offline tests never require signing in or modifying AWS.
