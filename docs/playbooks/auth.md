# Auth change checklist

Read [Framework's authentication model](../docs/FRAMEWORK.md#authentication) before
changing auth or authorization. Read [Production](../docs/PROD-DEPLOYMENT.md) for provider,
domain, or rollout changes. These documents own the architecture and commands; this
file is the agent's change checklist.

1. Identify which coupled surfaces change: client lifecycle, API transport, Cognito
   settings/triggers, shared token/cookie helpers, auth Lambdas, local proxy, CloudFront.
   Preserve the other halves of a contract when changing one.
2. Keep ID-token verification and request construction in shared helpers. Feature
   resolvers use the verified context and enforce record authorization separately.
3. Test rejected access and verify zero unauthorized writes. For schema changes, follow
   the [data-feature contract](typed-contract-propagation-agent.md), including a
   neighboring executable-schema test.
4. Preserve refresh single-flight, 401-only expiry, transient-failure session retention,
   request replay, PKCE/state, same-origin cookies, and trusted-origin checks unless the
   task explicitly changes those behaviors. Do not log credentials while investigating.
5. Preserve identity reconciliation: email equality cannot rebind a Cognito sub. For
   provider linking, verify configured provider names and verified-email attribute mapping.
6. Build the client when affected, run verify, and run focused tests for changed behavior.
   If infrastructure changed, synth both graphs. Report live sign-in/refresh/sign-out and
   Google checks separately; offline tests are not proof of deployed auth behavior.
7. Coordinate coupled client/server auth changes in the release plan. Do not deploy,
   publish, or alter a live user pool merely to validate a source change.

Useful source entry points: client-app/src/lib/auth.ts and auth.test.ts;
packages/framework/src/runtime/auth.ts and http.ts;
cdk-app/lib/app/cognito-stack.ts; auth HTTP/event handlers; local API routeProxyHelpers;
GraphQL schema/user.test.ts and project.test.ts.
