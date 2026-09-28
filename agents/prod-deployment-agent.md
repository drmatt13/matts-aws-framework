# Production deployment procedure

Follow [Production](../docs/PROD-DEPLOYMENT.md), the single deployment runbook. Consult
[Framework](../docs/FRAMEWORK.md#configuration-and-environment) for input/mode semantics
and [Database](../docs/DATABASE.md#changing-storage) for migration operations.

1. Establish the requested environment, account/profile/region, deployment name, and
   release scope from the user's request and existing context. Do not infer permission
   to deploy from a request to review or edit source/docs.
2. Inspect the source and working tree. Identify infrastructure replacements, database
   changes, and coupled client/auth changes. Preserve unrelated edits and secrets.
3. Prepare a reviewable release: build/verify, synth/diff where credentials permit,
   inspect planned SQL, and determine compatible deployment/migration ordering.
4. Use existing authorization for the specified release. If authorization is missing,
   present the concrete planned action and unresolved risks after preparation. Never
   ask again for an already authorized action in the same environment/scope.
5. Execute only the authorized release steps, using explicit deployment mode and the
   current runbook. Export changed outputs, publish the correct client assets, and
   perform the applicable live checks.
6. Report what ran, the environment affected, verification evidence, and any failures
   or remaining actions. Stop dependent mutations on failure; investigate before retrying.

Retain deployment/construct identities and stateful data. Switching production to dev,
applying SQL, destroying stacks, and removing DNS records are not routine recovery
shortcuts. Inspect the actual failure and use the runbook's relevant recovery section.
