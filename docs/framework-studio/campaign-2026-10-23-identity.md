# Identity, Cognito, domains campaign evidence

Owner: `identity_domains`, October 23, 2026. Scope: original families B/C/D and
Cognito retention in E. Source checkout shared by exclusive file leases. Browser
experiments use a separate Chrome tab and port 4593; source application is confined
to `.cache/studio-identity-campaign/app` with fake public inputs and no copied secret
values. No AWS resources, users, roles, certificates or DNS records were created,
updated or deleted by this agent.

## Current-state matrix recorded before implementation

| Surface | Initial status | Source evidence | Owner |
| --- | --- | --- | --- |
| Cognito tab/users/paging/groups/client/providers | Missing | `src/main.tsx` and `Shell.tsx` exposed only Board/Isometric/Database/Deploy; no Cognito service/view | identity_domains |
| Federation source | Partial | `cdk-app/lib/app/cognito-stack.ts` implemented Google only with existing secret resource, preserved emailVerified mapping | identity_domains |
| Identity-pool authoring/roles | Missing | Native Cognito stack comment claimed identity pool, but created only user pool/client/domain; Stack creator supported queue/bucket only | identity_domains |
| Domain source inputs | Partial | Existing protected `.env.dev/.env.prod` editor and resolver existed; no domain tab/ACM/DNS evidence | identity_domains |
| Production-only custom domains | Broken | `cdk-app/deployment.ts` applied Cognito custom domain in development, unlike frontend production gate | identity_domains |
| Environment-specific retention | Partial | Existing `RETAIN_STATEFUL_RESOURCES` resolver/CDK policies; no dedicated controls | shared with sql_recovery |
| Actual provider acceptance/sign-in, effective IAM, deployed DNS | Unverified | No live isolated deployment/provider credentials supplied in this subtask | lead owns cloud inventory |

## Pass 1 source paths and evidence (expanded by wave 2 below)

* Cognito `/cognito`: OIDC/SAML creator, existing Google diagnostics, source
  declarations with environment scope, separate external-provider/sign-in status,
  and explicit owned-stack reads for user pool, app clients, provider allowlist,
  groups and 20-user pages with escaped username-prefix search. No secret-value,
  user mutation or token API exists in the service.
* Identity Pools `/identity-pools`: reviewed native Stack template plus literal
  typed catalog registration and existing app pool/client connection. The role
  trust requires this identity pool's audience and authenticated amr; guest and
  classic auth disabled, token role ambiguity denied, reader group precedence10.
  Default role has no API grants; optional explicit bucket/prefix grants only
  s3:GetObject. Declared pool members are shown from the ordinary source graph.
  Independent review found that granting reads on the default authenticated role
  could widen access for missing-group users. The final helper has a permissionless
  default role and a distinct reader-group role carrying only optional reads;
  the synth regression asserts the policy attaches only to that reader role.
* Domains `/domains`: production inputs stage the existing protected input draft;
  no competing config. Wrong-region ACM/invalid DNS/invalid frontend origin fails
  source review. Explicit read-only inspection checks account/status/name coverage,
  expiry/validation metadata and DNS A answers; external-record targets come from
  deployed outputs. TLS/HTTP/application health is explicitly unverified.
* Cognito custom domains now apply only in prod. Development values are parked;
  an explicit warning names the possible custom-domain removal for old dev pools.
  This requires a reviewed deployment diff; no existing infrastructure was changed.
* DataRetention is shared with Database from `sql_recovery`; duplicate controls
  were removed. Existing defaults stay unchanged. Automatic pool/RDS adoption,
  reattachment or password export is not claimed.

The new literal `framework-config/auth-providers.ts` is consumed by native Cognito
composition. OIDC source declares/reuses an existing resource.secret and the native
helper emits a managed ARN parameter/dynamic reference. SAML uses metadata URL,
explicit attributes and no IdP-initiated auth. Provider name and ID remain stable
construct identities. Native policy/advanced mapping edits remain code-first.

## Experiments and checks

* Focused identity/domain/native synth tests: **15/15 passed**. They cover
  unowned/unknown deployment refusal before AWS calls, safe failure redaction,
  provider metadata query allowlists, escaped paging/search, role mappings,
  wildcard certificate depth, pending/mismatched certificate and missing-parent
  DNS, wrong-region source refusal with zero writes, OIDC/SAML app-client wiring
  and managed secret references, IAM trust and precise object-read policy.
* Existing protected-input/auth regression batch: **25/25 passed** before
  federation/pool expansion. No new dependency or lockfile change was needed.
* Full OIDC creator fixture review/apply/discovery/conflict protection/undo/redo:
  **passed**. Initial test selected the existing Cognito resource for new metadata;
  final implementation selects the new declared OIDC secret instead of changing
  the existing pool's tags. SAML metadata remains native provider source.
* Full identity-pool creator fixture review/apply/catalog discovery/undo: **passed**.
  Generic post-apply typed-member check was extended for identityPool.
* `npm --workspace cdk-app run typecheck`: passed. Studio typecheck initially
  passed; later unrelated SQL UI-test JSDOM typing was corrected by its owner;
  final rerun is recorded by the lead.
* `node docs/aws-studio-knowledge/check.mjs`: passed, 28 pages/553 local links.
* Real GUI on shared-root preview: wrong-region Cognito certificate draft displayed
  a precise error; Review rejected it and Apply was disabled. No file was written.
* Real GUI in isolated fixture: OIDC configure → source review → Apply succeeded.
  The exact literal provider and resource.secret catalog files were inspected;
  source status shows CampaignEnterpriseOIDC selected in dev while deployment,
  provider-side acceptance, secret access and sign-in remain unverified.
* Final real GUI C replay after the independent role fix: configured an explicit
  fake bucket/prefix, reviewed the permissionless-default warning and separate
  ReaderRole/ReaderRoleArn source, applied, inspected the new native class file,
  and observed `campaignIdentity.identityPool` in the declared-pool list plus
  five inspector public fields. Dev available/prod unavailable matched the source
  scope. The final creator Apply/undo test was rerun and passed after this fix.
* Desktop dark-mode screenshot exposed unreadable new cards caused by undefined
  theme-token fallbacks. The cards now use shared sheet/rule/ink tokens; a second
  real screenshot verified readable content and inspector contrast.
* During simultaneous Studio frontend edits, Vite fast-refresh reloaded the React
  root and disrupted a pending C draft. The final browser replay was restarted
  against frozen source. This is a development-server interruption, not a
  successful Apply. Existing saved OIDC source survived.

## Independent review and limits

`identity_domains` independently reviewed the final frontend release/source-name
services. The review led to per-upload expected-bucket-owner checks and exact
CloudFormation bucket/distribution ownership plus CloudFront account/origin/ETag
binding. The revised source has no remaining blocker found by this review; live
publication/invalidation was not performed. Existing target keys are preserved
when adding an independent deployment name; naming does not claim migration.

Independent B/C security review by `sql_recovery` confirmed the dynamic secret,
verified-email mapping, read-only route/CLI allowlists and owned-stack gates. Its
default-role widening finding was fixed with a distinct reader role; that reviewer
independently reran the three native IAM synth tests, all passed, and found no
remaining blocking source security defect. Fresh-browser replay is assigned to
`release_identity` and recorded in the lead's report. This agent cannot self-certify
effective AWS IAM or external provider sign-in from synth/mock evidence. Remaining
Pass 1 limits included no user/group operations, policy editor/guest opt-in or
managed DNS/live health surface. Wave 2 below and the sibling operation/policy
reports replace those limits. Retained/external pool inventory, automatic primary
Cognito/RDS reattachment and custom-target input editing remain unsupported.
Production mutation authorization remains separate from implementation.

Cleanup: no run-owned AWS resources/costs. The isolated source fixture is retained
under ignored `.cache` for independent replay, with fake values only. Preview
server4593 is stopped after review when the independent agent releases its lease.

## Wave 2 domain operations and regression repair

The Domains view now exposes explicit saved-production-purpose DNS/TLS/HTTP
inspection and managed DNS discovery/review/apply. It continues to use only the
existing protected `.env.prod` inputs. The health service refuses IP literals,
local/private/reserved destinations, mapped/tunnel addresses and mixed public
answers. It resolves once, pins the public address and verifies TLS/SNI/Host for
the configured hostname; only HTTPS `/` is requested with 10-second timeout and
64-KiB body cap. It follows no redirects. DNS, TLS trust, HTTP status and HTML
content are separate observations; sign-in, application APIs and JavaScript
execution stay unverified.

Managed changes are deliberately bounded to simple non-apex CNAME routing to an
already deployed owned frontend CloudFront distribution or ACTIVE owned Cognito
custom domain. The service validates exact account/stack physical ownership,
source hostname/certificate, issued ACM coverage/expiry, public zone NS delegation,
all intermediate child NS cuts and current record shape. A 10-minute review shows
account/profile/region/deployment/zone/current/desired/transaction/dependencies/risks
and requires the exact production hostname/zone/account phrase. Apply repeats all
evidence reads. Atomic exact DELETE+CREATE protects concurrent CNAME replacement;
absent records use CREATE. The AWS CLI has one attempt. A file-synced receipt and
portable directory sync precede submission; unconfirmed outcomes survive restart
and never automatically retry. Accepted, authoritative INSYNC, recursive cache
behavior and application health remain distinct.

No actual AWS record write was run. Apex aliases, advanced/routing-policy records,
external targets and ACM validation record mutation remain manual. Official
[Route53 transaction](https://docs.aws.amazon.com/cli/latest/reference/route53/change-resource-record-sets.html)
and [CloudFront routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-cloudfront-distribution.html)
contracts informed those bounds. The implemented production Apply still needs
separate exact action-time authorization and an owned live deployment/zone.

Checks actually run:

* Final domain backend8 + DOM2: **10/10 passed**, also independently rerun by
  `sql_recovery`. Cases include private/mixed destinations, address pinning,
  DNS-vs-TLS/503 separation, wrong source purpose, exact typed gate, drift,
  undelegated parent/child NS cut, advanced/apex refusal and durable uncertain
  submission with consumed review/no retry. The DOM test verifies current/desired
  visibility, wrong confirmation disabled, backend failure inside the modal,
  dirty-source blocking and stale-target observation discard.
* A real read-only HTTPS probe of public `example.com` pinned `172.66.147.243`,
  completed trusted hostname TLS, observed HTTP200 and HTML title `Example Domain`
  (577 bytes). This used an explicit test authority and proves transport only,
  not configured production-domain health or AWS ownership.
* Own separate Chrome tab on the isolated4593fixture loaded the Domains controls
  in dark mode. Explicit health inspection with malformed selected region returned
  the visible backend target-validation error before any DNS/TLS probe; a screenshot
  verified readable controls, error and separate-health limitations. A concurrent
  reviewed C-source update discarded an earlier in-flight read instead of showing
  evidence for a stale source revision. No production DNS Apply was clicked.
* Cognito hook test regression: fixed a brittle frozen-line assertion to check
  the actual declaration at the current source location. Then repaired an actual
  Add-trigger regression: passing the public pool into an opaque federation helper
  correctly caused conservative parser manual-wiring refusal. The helper now
  prepares validated options without receiving the pool; CognitoStack directly
  constructs native providers. The parser remains conservative and unchanged.
  Three previously failing trigger UI flows passed. Native provider3 tests include
  exact template/logical-identity equivalence of the direct constructor form.
* Managed-route production-card regression was a test using development-model
  WebSocket flags to predict production. It now reads the actual production lens;
  focused route/hook tests **2/2 passed**.
* Final Studio and CDK typechecks **passed**. Knowledge check **passed**:
  28 pages, 556 local links and 151 source references. Root owns full integrated
  `npm run verify` and both-mode synth/live deployment evidence.

Independent D review by `sql_recovery` found the intermediate child-delegation
gap and directory-sync issue; both were fixed with regressions. That reviewer
reported no remaining blocking source defect. Independent C policy/simulator
review by this agent confirmed permissionless default and explicit guest roles,
unchanged audience/amr trust, ReaderRole-only bounded literal grants/denies,
existing source journal and account/source-bound read-only simulation. The review
led to authored convenience-comment protection and helper/validator drift checks;
final focused policy3 + domain10 tests **13/13 passed**. This is not effective
deployed IAM or credential-issuance evidence.

External dependencies remain: OIDC provider client registration/secret authored
through the secret resource/deployment flow, correct provider claims/redirects,
SAML reachable metadata/SP settings, issued certificates and required DNS,
owned deployed pool/distribution/zone, AWS permissions, separately authorized
mutations, real token/group-role issuance and successful browser sign-in.
