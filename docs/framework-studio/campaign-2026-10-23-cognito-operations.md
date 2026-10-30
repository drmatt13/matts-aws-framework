# Cognito user/group operations — campaign evidence

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

## Baseline and change

The first campaign pass implemented deployed Cognito inspection and federation
source authoring. Users/groups were visible, but there was no user/group operator
journey. Wave two adds a separate reviewed operation UI and fixed operation service;
it uses the existing guarded identity router, selection and ownership resolver.

| Journey | Implemented behavior | Evidence |
| --- | --- | --- |
| Fake development user | Explicit review/apply; suppressed invitation; Cognito-generated temporary credential; no credential returned | Service test, real browser with simulated AWS runner |
| Group | Create without role ARN or precedence | Service test and simulated browser |
| Membership | Explicit add/remove, current group role/precedence warning; unchanged is write-free | Service lifecycle test and simulated browser |
| Account access | Explicit enable/disable with stale-token warning | Service test and simulated browser |
| Production | Separate exact per-operation authorization; no production execution | DOM gate test and simulated service test |
| Destination/subject drift | Re-resolve owned stack/account/region/pool/actor and metadata; refuse stale review | Simulated service tests |
| Interrupted write | Durable redacted unconfirmed receipt; no retry/replay after restart | Simulated outcome/restart tests |

## Safety and ownership

`IdentityService.verifiedUserPool` derives exactly one physical pool from deployment
stacks whose identity and account match the selected declared target, verifies its
ARN, and fingerprints pool metadata plus caller and owned stack identities. The
operations service requires an account-matching IAM/STS caller ARN. The request
parser accepts six fixed operations and exact keys only. It accepts no arbitrary
AWS command, pool ID, credential, role, verified-email claim or delete request.

Review reads current user/group metadata and membership, then creates a five-minute
single-use approval. Apply requires exact phrases, takes an exclusive durable
per-pool lock and rechecks the target and subject fingerprint. Production has an
additional operation-specific typed phrase. Every write sets `AWS_MAX_ATTEMPTS=1`.
Durable records exclude entered names/email/group strings, password values and raw
AWS responses. They retain caller ARN, exact target, action, timestamps and a
deterministic digest of the exact username/group pair for correlation. Hashes can
be guessable and are not advertised as anonymization. Uncertain records stay
uncertain after restart; consumed reviews are never replayed.

`AdminCreateUser` omits `TemporaryPassword`, uses `SUPPRESS` and
`--no-force-alias-creation`, and never sets `email_verified`. Because passwordless
OTP can change the meaning of an omitted temporary password, that pool mode is
refused. Unsupported required attributes also refuse before a write. The UI
does not offer any password/reset/delete-user flow. Configured trigger execution
is disclosed in review. AWS acknowledgement, follow-up metadata, application rows,
sign-in, refreshed token claims and effective IAM are distinct outcomes.

## Checks actually performed

- `test/cognito-operations.test.ts`: eight tests passed, including a five-write
  group/membership/enable lifecycle, no-op writes, exact production gate, stale
  destination/subject refusal, suppressed user creation, known rejection versus
  unknown acknowledgement versus failed follow-up, and unknown-after-restart
  correlation with no replay.
- `test/cognito-operations-ui.test.ts`: two tests passed. A production operation
  cannot apply with only its first phrase, interrupted response reports uncertainty
  without retry, and a late review for a previous target never opens an approval.
- Root's independent review found no ownership/write-scope blocker and requested
  better crash correlation; caller ARN and subject digest plus CloudTrail guidance
  were added and checked in the restart test.
- Real Chrome author journey on isolated `127.0.0.1:4592` used the actual
  `CognitoManagement`, router and service with an explicitly simulated in-memory
  AWS runner. Created `campaign.fake` with `example.invalid` email, created
  `campaign-reader`, added membership, disabled, enabled and removed membership.
  All six exact typed approvals reported `applied` and follow-up `observed`.
  Reload showed durable history with six records. No AWS CLI process or cloud
  request was made by this fixture. Screenshot:
  `.cache/studio-campaign-20261023/cognito-management-simulated.png`.
- Independent root-agent browser replay created `root-pass-two` after reviewing
  account/pool/caller/digest. A wrong phrase left Apply disabled; the exact phrase
  applied and follow-up metadata was observed (history seven). A duplicate-user
  review refused without overwrite or invitation. Screenshot:
  `.cache/studio-campaign-20261023/cognito-independent-simulated.png`.
- Studio typecheck was attempted; the first attempt was blocked only by an
  unrelated contemporaneous `model.test.ts` optional-source assertion. Root was
  notified; subsequent full Studio frontend/server typechecks both passed, including
  after domain-operation integration. The full integrated gate is tracked in the
  main campaign report.

## Limits and cleanup

No run-owned development pool existed, so no actual Cognito user/group mutation,
invitation, sign-in, token refresh or IAM runtime test was performed. Production
was exercised only in simulated tests. The temporary browser fixture stores fake
metadata under `.cache/studio-campaign-20261023/cognito-browser`; it creates no
Docker/AWS resources. The owned fixture process was stopped after independent
replay, and no listener remained on port 4592. Real operator use still requires an explicitly selected
owned destination, credentials with the relevant read/write permissions, and a
fresh exact approval. Source/deployment and operation approvals remain separate.
