---
name: build-feature
description: Build an application feature spanning HTTP routes, events, container tasks, workflows, and AWS resources. Use when a change crosses workload boundaries; use propagate-contract for changes confined to the database, GraphQL, and React data path.
argument-hint: [Feature description]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# Build a feature across workloads

Target: **$ARGUMENTS**. Preserve the user's intended behavior and unrelated edits.

Read and follow the repository's
[feature-build procedure](../../../agents/feature-build-agent.md). It provides
the decisions, build order, development loop, traps, and completion checks; the
linked Framework guide owns the API reference.

For changes confined to the database → GraphQL → React path, use
[propagate-contract](../propagate-contract/SKILL.md) and its automation contract.

Complete authorized source work and offline checks. Deployment and database
application require separate explicit authorization for the intended environment.
Return the procedure's handoff, including any deferred live or browser checks.
