# Cognito, identity pools and domains

Studio has one **Cognito** authentication workspace with **User Pools**, **Identity
Pools**, **Providers**, and **Permissions & RBAC** subsections. **Domains** remains
a separate production workspace. Source intent, observed deployed configuration,
external provider configuration and actual sign-in/IAM outcomes are independent.
Opening a view never creates users, changes IAM, reads secret values, writes DNS
or deploys infrastructure.

## Navigation and shared inspection context

Start at `/cognito` for User Pools. The subsections have direct URLs:

| Section | Route |
| --- | --- |
| User Pools | `/cognito/user-pools` (also `/cognito`) |
| Identity Pools | `/cognito/identity-pools` |
| Providers | `/cognito/providers` |
| Permissions & RBAC | `/cognito/permissions` |

Existing `/identity-pools` and `/identity` bookmarks redirect to Identity Pools. Browser
back/forward uses the same routes. The parent workspace retains its panels, so
moving between subsections preserves inspection, search, policy edits and source
proposals. Leaving the workspace and changing environment retain the existing
source-draft navigation guard. Local policy edits also warn before leaving or
refreshing; context/source mismatches preserve edits but pause review until the
original context is restored or local edits are discarded.

Studio's global environment is the source-mode authority. One inspection toolbar
selects profile, declared deployment and region for all four subsections, seeded
from Deploy's remembered preferences. There is no second independent environment
selector. Each environment retains its own target selection. Inspect explicitly
reads AWS; a source-only pool is never presented as deployed. Changing context
invalidates incompatible observations and operation reviews; changed source marks
existing evidence stale. Account, region, deployment and observation time identify
the evidence's scope. A failed refresh remains visible and does not establish that
resources are absent.
The toolbar names both the fixed mode source input file and the selected target's
input file. Custom target paths show a mismatch notice: fixed-file Google presence
and freshness do not verify that deployment's inputs, and its retention editor is
not silently redirected. Declared account changes invalidate the shared context;
saved target account pins take precedence over older observations for simulation.

The User Pools page starts with pool/app-client evidence and links to related
providers, identity pools and permissions. Identity Pools explains the chain from
user claims through role selection to IAM. Permissions & RBAC keeps application
authorization, Cognito groups, identity-pool mappings and IAM diagnostics distinct.

## Federation source

In Cognito → **Providers**, **Add federation provider** proposes an OIDC or SAML entry in the
literal `framework-config/auth-providers.ts` array. The same source is usable
without Studio. `cdk-app/bin/cdk-app.ts` filters entries by their explicit dev/prod
scope, and the existing `CognitoStack` creates providers and registers them on its
existing app client. Google, user-pool and app-client construct identities remain
unchanged. Provider IDs/names are stable infrastructure identities; editing or
removing an existing declaration remains source work followed by synth/diff.

**Open Google inputs in editor** links to the visibly named mode input file using
Studio's existing editor-link mechanism. Configure `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` there; this handoff does not fetch stored values into the
authentication workspace. Google input presence, deployed provider metadata and
accepted Google application credentials remain separate evidence. OIDC/SAML
declarations continue through Studio's reviewed source proposals.

OIDC proposals declare or reuse one `resource.secret("NAME")` in the resource
catalog. Enter its value only in the intended `cdk-app/.env.<mode>` file. The
existing deploy runner provisions it and supplies the ARN parameter; the Cognito
template contains a Secrets Manager dynamic reference. The source proposal never
accepts a secret value. OIDC requires an HTTPS issuer, `openid` scope, explicit
attribute mappings and provider support for `client_secret_post`. SAML uses an
HTTPS metadata URL and explicit mappings; IdP-initiated auth and SAML sign-out
are disabled by the template.

The verified-email mapping must reflect an IdP claim that proves ownership of the
address. Supplying a convenient constant does not verify an address. Test the
provider's claim semantics and existing account-linking safeguards independently.
For OIDC configure `https://<cognito-domain>/oauth2/idpresponse` at the provider.
For SAML configure `urn:amazon:cognito:sp:<pool-id>` as the SP entity ID and
`https://<cognito-domain>/saml2/idpresponse` as ACS. The application's
`/auth/callback` URL is a separate app-client callback.

**Inspect deployed settings** selects an explicit profile/deployment/region,
requires verified owned CloudFormation stacks, and reads their actual user-pool
physical identity. It shows app clients/callbacks/logout/providers, groups and
20-user pages with a username-prefix search. The provider response uses an
allowlist that excludes client secrets and SAML metadata bodies. AWS metadata
success does not establish provider-side credential validity or a successful
browser sign-in.

Provider evidence presents supported type, selected source declaration, deployed
Cognito configuration, secret presence/access, provider-side setup and observed
sign-in separately. An authored secret presence flag cannot establish that a
deployed Secrets Manager value exists or that Cognito can use it. Inspect does not
request secret contents or run external sign-in.

## Reviewed user and group operations

**User and group operations** supports creating a user without invitation, creating
a group without an IAM role, adding/removing membership and enabling/disabling a
user. The destination is resolved again from verified owned deployment stacks;
the browser never supplies an arbitrary pool ID. Review displays mode, account,
region, caller ARN, pool ARN, exact subject, current metadata and effects. Apply
requires the complete action/subject/pool/account phrase. Production additionally
requires a separate operation-specific phrase including the region. Every review
expires in five minutes and can be consumed once; changed destination, credentials,
pool configuration or subject metadata requires a new review.

User creation uses `AdminCreateUser` with `MessageAction=SUPPRESS`, without a
`TemporaryPassword`, verified-email assertion or forced alias reassignment. Cognito
generates the temporary password; Studio does not retrieve or deliver it. This
flow refuses pools with passwordless OTP factors or unsupported required
attributes. Password changes, resets, user deletion, arbitrary attribute updates
and group role assignment are unavailable. User creation does not establish a
working sign-in or an application database user. See the official
[AdminCreateUser contract](https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-create-user.html).

The service rechecks the target and subject fingerprint under an exclusive pool
lock, durably records its intent, and sends one write with CLI retries disabled.
Already-matching membership/enabled state records `unchanged` without a write.
An acknowledgement and a subsequent metadata observation are separate outcomes;
connection loss or interrupted durable history remains `unconfirmed`, including
after restart. Studio never automatically retries, replays or rolls back a write.
Preserve uncertain records and inspect the exact pool before another approval.
History stores target, action, time, caller ARN and a subject digest, excluding
user/group text, email/names, credentials and raw AWS responses. Match the digest
with the review and correlate CloudTrail by action, pool, account, caller and time;
the digest is a correlation reference rather than anonymous data. A stale pool lock
is deliberately not reclaimed automatically.

Membership can alter future RBAC/identity-pool role claims; existing JWTs can
remain accepted until expiry. Disabling a user does not prove every application's
cached authorization is revoked. Configured pool triggers can execute during
administrative operations. Successful token refresh, sign-in and effective IAM
remain separate checks.

## Identity pools

In Cognito → **Identity Pools**, **Create identity pool source** uses the existing Stack creator and reviewed
source journal. It creates a native application stack, declares its typed
`resource.stack` catalog entry and registers it beside application stacks.
`identityPoolAccess` connects the existing user pool/client, disables guest access
by default and always disables classic flows, restricts web-identity trust to this identity pool's `aud` and an
authenticated `amr`, and uses token role mapping with ambiguous resolution set to
`Deny`. A reader group has precedence 10. Group membership is a separate action.

The default authenticated role always has no AWS API policies. A separate reader
role supplies the group's role claim. Optionally select one explicit S3
bucket ARN and object prefix for `s3:GetObject` on the reader role only; the template grants no
listing, writing or deleting. In **Permissions & RBAC**, **Reader role policies and permission simulation**
edits the recognized generated stack's literal `readerPolicyStatements` options,
replacing the convenience bucket/prefix fields so there is one source authority.
The same reviewed batch, native source ownership, helper/validator hashes,
TypeScript checks, two-mode evaluation, journal and Undo apply. Computed/custom
helper shapes and comments inside a replaced setting require deliberate source
editing; Studio refuses to discard them.

Statements accept explicit `Effect: Allow | Deny`, concrete `Action` names and
scoped `Resource` ARNs. Allow supports bounded S3, DynamoDB, SQS, SNS, Lambda,
Step Functions and EventBridge data operations. Wildcard actions, account/region
wildcards, resource-class wildcards, administration, secrets/credential grants,
conditions and principals require native source review. A terminal object or
named-resource `/*` scope is supported; S3 listing uses a separate exact bucket
statement. These editor bounds do not replace application authorization.

The explicit **Enable permissionless guest identities** opt-in creates a separate
unauthenticated role constrained by the same pool `aud` and unauthenticated `amr`.
It has no API policies; ReaderRole statements never attach to guests. Enabling it
allows public guest credential issuance after a separate deployment. The default
authenticated role also remains permissionless. Token role mapping rejects
ambiguous claims. Missing reader-group claims select no ReaderRole grants; equal
precedence conflicting roles may prevent credentials rather than selecting one.

**Simulate saved policy** verifies the selected profile's expected account with
STS and sends only saved statements, explicit actions and resource ARNs to the
read-only AWS IAM simulator. Unsaved drafts and changed stack/helper/validator
bytes invalidate the evidence. A default role with no statements reports a
source-model implicit deny after STS verification, explicitly without an IAM
simulation request. IAM results distinguish allowed, implicit deny and explicit
deny; explicit Deny wins within the supplied policy document. The simulator does
not issue credentials or call the resource. Attached deployed policies,
permissions boundaries, SCPs, session/resource policies, actual group claims,
provider/trust configuration, application RBAC and runtime/network behavior
remain unverified. AWS may refuse this read if the profile lacks
`iam:SimulateCustomPolicy`; no role mutation is attempted.
The deployed inspector displays owned identity pools, guest settings and mappings;
it does not claim effective authorization from graph edges or role selection.
Retained/external pools can exist outside the inspected stack inventory.

## Production domain intent

Domains stages only the existing `cdk-app/.env.prod` domain inputs through the
protected environment editor. Both Cognito and frontend custom domains apply only
to production. Development parks authored custom-domain values. Updating an older
development deployment that used a custom Cognito domain can replace it with the
generated domain and break existing hosted-login or federation redirects. The
deployment wrapper compares the owned deployed template with the exact next
assembly before secret writes. Direct deployment refuses this transition. Prepare
a new saved plan, review its explicit domain/authentication consequences and
provide the typed deployment name to apply it. Older plans without that consequence
are refused even if a name is supplied. The guard also covers custom-domain removal,
renaming, pool reassignment and changed conditional context. It preserves the new
production-only default without silently applying a legacy development migration.
Offline synthesis can still describe this transition; source approval and synth
do not authorize deployment. Invoking CDK directly bypasses wrapper protections.

The source review rejects malformed hostnames, non-origin frontend URLs and ACM
ARNs outside `us-east-1`. Explicit production inspection additionally checks the
certificate account, observed status, name coverage, expiry and validation records,
resolves A records including Cognito's immediate parent, and derives external DNS
instructions from deployed output targets. Missing targets are left unknown.
**Inspect live DNS / TLS / HTTP** resolves only the saved selected-purpose hostname.
It refuses IP literals, local/private/reserved destinations and mixed public/private
answers, pins one public address, validates TLS against the original hostname, and
sends a bounded HTTPS request to `/`. It never follows redirects or accepts arbitrary
URLs, credentials or ports. DNS, certificate trust, HTTP status and sampled HTML
content are displayed separately. A 200 response or HTML title does not establish
JavaScript execution, application API behavior or successful sign-in. Targets
with a custom inputs-file path are refused by this fixed-path editor/inspection
rather than being silently confused with `.env.prod`.

**Discover managed DNS zones** is an explicit read against the selected verified
production account. **Review exact production DNS change** supports one simple
non-apex CNAME to an already deployed owned CloudFront frontend or ACTIVE Cognito
custom domain. Source hostname/certificate, issued ACM coverage, owned deployment,
public zone delegation, intermediate child-zone delegation and the complete current
record are verified. Apex aliases, advanced routing, competing records, external
targets and certificate-validation mutations require external/manual management.

Review shows profile/account/region/deployment, zone, current record, exact desired
record and transaction, dependencies, cache/cost risks and an operation-specific
hostname/zone/account confirmation. Apply revalidates that evidence. An existing
CNAME is replaced by an atomic exact DELETE plus CREATE; Route53 rejects concurrent
record changes instead of silently overwriting them. The CLI sends once with retries
disabled. A durable receipt is saved before submission; interrupted/uncertain outcomes
are preserved after restart and never replay automatically. Route53 acceptance and
INSYNC remain distinct from recursive caches and served application health. No
certificate request is supported. Source approval never submits this DNS operation;
production DNS Apply requires its own action-time authorization.

Official contracts: [Cognito domains](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html),
[CloudFront certificates](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html),
[Route53 CloudFront routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-cloudfront-distribution.html),
[atomic Route53 record changes](https://docs.aws.amazon.com/cli/latest/reference/route53/change-resource-record-sets.html),
[OIDC](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html),
[SAML](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html),
[IAM custom-policy simulation](https://docs.aws.amazon.com/cli/latest/reference/iam/simulate-custom-policy.html).

## Retention

Cognito and Database have independent dev/prod policies in
`framework-config/stateful-resources.ts`; an omitted policy inherits the existing
target-specific `RETAIN_STATEFUL_RESOURCES` input. Studio uses the same reviewed
source, and deployment remains separate. Source intent and actual deployed
removal/deletion-protection policies are distinct evidence.

Cognito retention preserves original pool/users and native client, domain,
providers and invoke grants. Lambda functions, groups, Identity Pools, IAM roles,
provider secrets and certificates require their own dependency review. An explicit
external reference reconnects the original retained pool, surviving public client
and domain without changing configuration or CloudFormation ownership. It does
not imply password recovery. See [Cognito lifecycle](cognito-lifecycle.md) for
code-only source, inspection, dependency prerequisites, identity preservation and
import/restore/reconciliation boundaries. Local `postgres_data` storage and
production RDS remain separate database lifecycles.
