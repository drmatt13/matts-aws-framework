---
name: propagate-contract
description: Propagate an application data change from contract.prisma through repositories, Pothos GraphQL, tests, generated documents, and TanStack Query options. Use for adding or changing a data feature or exposing a field end to end.
argument-hint: [ModelName]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# Propagate a data feature

Target: **$ARGUMENTS**. If absent, identify the affected model from the request and
working-tree diff without absorbing unrelated edits.

Read and follow the repository's authoritative
[automation contract](../../../agents/typed-contract-propagation-agent.md).
It defines required source, naming, authorization, tests, and completion checks.
Read linked references only as needed for the current change.

Inspect Project end to end as the standard implementation. User is the documented
profile/provisioning compatibility exception. Preserve existing application behavior
and approved decisions; ask only for unresolved application intent.

Complete the requested source and regression tests, generate artifacts, and verify.
Planning SQL does not apply it and does not prevent continuing source work. Database
application and deployment require separate explicit authorization. Return the handoff
specified by the automation contract, including any unverified work.
