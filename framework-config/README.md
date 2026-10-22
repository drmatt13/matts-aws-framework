# Authoring application infrastructure

Start at [`../framework.config.ts`](../framework.config.ts): it explicitly imports and
composes every declaration. Files are never registered by scanning a directory.

| Location | Owns |
| --- | --- |
| `workloads/<kind>.ts` | One literal section per workload kind; `area` tags describe concerns |
| `resources.ts` | Explicit public catalog names used by workloads and native CDK |
| `resources/stacks.ts` | Typed stack descriptors and public-member metadata |
| `resources/inputs.ts` | Authored input/secret declarations; never their values |
| `networks/`, `databases/` | Independently imported network and database declarations |
| `shared/` | Reusable application fragments, such as model permissions |
| `contracts.ts` | Type-only section types specialized to this resource catalog |
| `defaults.ts` | Shared compute and connection defaults |
| `descriptions.ts`, `client-environment.ts` | Studio descriptions and client mappings |

Start with the existing kind module: add HTTP routes to `workloads/http.ts`, event handlers
to `workloads/events.ts`, and tasks to `workloads/tasks.ts`. Shared fragments and comments
stay beside the declarations. Use `tags: { area: "auth" }`, `area: "graphql"`, or another
concern to organize filtering across kinds. Studio appends to those same modules.

If a section grows too large, explicitly compose smaller literal modules in its root
array. A feature folder may export several such maps. Neither filenames nor module depth
determine deployment identity, topology or tags; filesystem registration remains explicit.

Use `satisfies HttpSection` (or the matching type), literal keys, and root arrays rather
than spreads between section maps. Shared fragments inside an entry remain supported.
Keep the resource catalog separate from the root to avoid cycles.

Tags are authored beside the declaration they describe. They organize Studio across files
and workload kinds and propagate only through explicit AWS ownership. Read the
[declarations and tags guide](../docs/framework-studio/declarations-and-tags.md) for
code and GUI examples, supported source shapes, inheritance and AWS propagation.
