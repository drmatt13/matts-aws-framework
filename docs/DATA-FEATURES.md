# Data features

Edit storage in `packages/database/prisma/contract.prisma`, describe the intended
application behavior, and let the agent carry the change through to exported
TanStack Query options. You do not need to author GraphQL or custom hooks yourself.

## Asking for a change

An example request:

> Propagate Project.description. Owners can read and edit it, limit it to 500
> characters, and include it in ProjectSummary. Keep the existing ownership rule.

For a new feature, supply the model, public and writable fields, ownership rule,
operations, and fields the screen needs. For an existing feature, the agent preserves
its established policy and asks only for decisions the request and existing code do
not resolve. A new database column alone does not grant permission to expose it.

Agents must follow the [automation contract](../agents/typed-contract-propagation-agent.md).
That is the single home for required filenames, naming, operation shapes, error
semantics, tests, and completion criteria. The repository's Claude entry point is
`/propagate-contract <ModelName>`; other agents can follow that same procedure directly.
This is a source-editing workflow, not a runtime API endpoint.

## The chain

```text
contract.prisma -> repository -> Pothos schema -> GraphQL documents -> query/mutation options -> React
```

Storage, public API, and screen selection express separate decisions. Record types
are derived with `ContractRow<"Model">`; Codegen derives operation results and variables.
Typechecking verifies compatibility along declared paths. It cannot decide exposure,
notice a requested field omitted everywhere, or prove an ownership rule is correct.
The agent must verify the requested behavior using executable-schema and API tests.

## Project is the reference

| Layer | Source |
| --- | --- |
| Storage | [contract.prisma](../packages/database/prisma/contract.prisma) |
| Record, write inputs, repository interface | [contracts.ts](../packages/database/src/contracts.ts) |
| Persistence operations | [projects.ts](../packages/database/src/projects.ts) |
| Static repository registration | [database index](../packages/database/src/index.ts) |
| Public types, validation, authorization, resolvers | [project.ts](../cdk-app/lambda_functions/http_functions/graphql-api/schema/project.ts) |
| Static schema registration | [schema index](../cdk-app/lambda_functions/http_functions/graphql-api/schema/index.ts) |
| Executable behavior tests | [project.test.ts](../cdk-app/lambda_functions/http_functions/graphql-api/schema/project.test.ts) |
| Documents, fragment, query/mutation options | [operations.ts](../client-app/src/api/projects/operations.ts) |
| Cache and operation tests | [operations.test.ts](../client-app/src/api/projects/operations.test.ts) |
| Ordinary React consumers | [ProjectsPanel.tsx](../client-app/src/components/ProjectsPanel.tsx) |

The Project implementation exposes id, name, archived, createdAt, and updatedAt;
ownerId stays private. Every resolver resolves the session's application user once per
request (`requireCurrentUserId`). Lists filter by that id. Creates trim and validate names and
assign ownership on the server. Archive and delete write in one owner-scoped statement:
another user's project is NOT_FOUND, exactly like a missing one, so the API never reveals
that it exists. Deletes return `{ deletedId }`; create/archive return `{ project }` in named
mutation payloads. Queries live under one key factory (`projectKeys`); mutation options
invalidate `projectKeys.all` after success and preserve errors.

The screen's ProjectSummary selects id, name, archived, and updatedAt. Components use
`useQuery(projectsQuery)` and `useMutation(deleteProjectMutation)`, then
`deleteProject.mutate({ id })`. No feature hook wrapper is required.

currentUser uses the same frontend pattern: its
[operations.ts](../client-app/src/api/currentUser/operations.ts) exports
`currentUserKeys`, `currentUserQuery`, and `updateCurrentUserMutation`. Components use
`useQuery(currentUserQuery)` and `useMutation(updateCurrentUserMutation)`; updates pass
`{ data: { firstName, lastName } }`. Its singleton cache key remains `["currentUser"]`.
Session-expired errors are not retried; other failures receive at most two retries.
Override per-consumer options with `useQuery({ ...currentUserQuery, enabled })`.
Its [API tests](../client-app/src/api/currentUser/operations.test.ts) cover selections,
retries, and invalidation. All features keep documents, options, and cache behavior in
operations.ts rather than adding a feature hook wrapper solely for these concerns.

User's backend still handles a single profile with verified-identity provisioning,
instead of generic owner CRUD. Its
[schema tests](../cdk-app/lambda_functions/http_functions/graphql-api/schema/user.test.ts)
cover that behavior.

## New-feature scaffolding

After emitting the Prisma contract, preview the owned-list/create recipe:

```powershell
npm --workspace @repo/database run scaffold -- Note --dry-run
```

The interactive command asks for public fields, create fields, the owner foreign key,
operation names, and selected screen fields. Explicit flags make it usable by an agent:

```powershell
npm --workspace @repo/database run scaffold -- Note --dry-run --public id,name,archived --create name --owner ownerId --query notes --mutation createNote --select id,name
```

Use `--write` instead of `--dry-run` once the choices are authorized. The command emits
ordinary application source, static registrations, and a neighboring schema test.
It refuses collisions and existing feature files. Customize the source directly;
there is no retained feature configuration and no regeneration over customized code.

The recipe supports a single UUID id, exactly one UUID owner relation to User.id,
and non-null text, UUID, Boolean, Int32, Float64, and string-timestamp fields. Omitted
required create fields need defaults. Nullable fields, enums, additional relations,
updates, deletes, and domain validation require the agent to edit ordinary source
using the automation contract. Scaffold output is a starting point; the agent must
also supply frontend API tests and all validation required by the request.

## Completing a change

The agent returns the implemented options, the exposed/withheld field decisions,
the tests and checks run, and any migration still awaiting application. Every feature
schema requires a neighboring `<feature>.test.ts` and an explicit import in schema/index.ts.
`verify` checks those files exist and runs them; test quality remains part of review.

Use [Database](DATABASE.md#changing-storage) for migration planning and application.
An agent can plan and show a migration while continuing source work. Applying it to
a database is a separate, explicitly authorized action. A GraphQL-only operation,
such as deleting Project, needs no storage migration.
