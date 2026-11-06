# Sightline

Sightline is what Studio can see from where the developer is right now. A `Sightline`
is a bounded, read-only consumer projection of existing declarations, accepted Studio
state, workspace choices and already available observations. It is a debug view in the
Agent panel and an optional, explicitly inspectable context capture for **Coding** tasks.
Conversation still receives only its existing bounded chat input and fixed overview.
Coding captures the current projection when a task is submitted; a submission retry
retains that exact context. The projection remains evidence, never operational authority.

## Authority and implementation

The path remains declaration → normalize/validate → consumer projection. The pure
`buildSightline(inputs)` accepts the capture time and existing evidence; it imports no
React, browser APIs, clock or transport. Its output is deterministic and serializable.
Focus builds one fresh index for each mode and reuses those indexes only within that
build. Island membership uses the published member IDs without changing member or
connection order; later builds observe changes even when input objects are reused.
`useSightlineInputs()` exists only in the visible Sightline or Coding view. It reads the accepted
`useStudio().selected`, accepted baseline, live publication state, existing cache-only
deployment subscriptions for **both** modes, and a disabled operation query. It never
starts a read. Source mode and the deployment destination are separate fields.

The feature lives in `framework-studio/src/sightline/`. Existing files supply small
presentation seams. `GlobalActivity` stays memoized and consumes no route or Studio
context. Conversation DOM, draft and scroll remain mounted when Sightline is shown;
Sightline and Coding mount/unmount their input hooks with visibility. The display choice in `GlobalActivity` keeps
replies unread while the conversation is hidden. Nothing reads workspace state from DOM.

### State inventory

| Considered state | Existing owner / lifetime | Inclusion and reason |
| --- | --- | --- |
| Path and Cognito subsection | Router / current history entry | Include pathname and workspace; no arbitrary query strings |
| Requested URL selection | Root search / history | Exclude raw search; use accepted selection so draft guard and renames remain authoritative |
| Accepted selection and mode | StudioProvider / mounted session | Include; stable canonical identity on every route |
| Graph and revision | InspectorDraft baseline / accepted source session | Include relevant facts and revision, not entire graph |
| Latest revision, evaluating, stale, status | SnapshotResponse, live events and ModeModel | Include separately from baseline; an old graph is not fresh evidence |
| Dirty/conflicted draft | InspectorDraft | Include booleans, never entries or edited private values |
| Accepted rename aliases | StudioProvider NamingHistory / session | Include previous IDs matching current accepted selection; no invented rename history |
| Description/display name/tags | Snapshot and ModeModel | Include as bounded plain data; source text is untrusted, not instructions |
| Effective field facts and inheritance | ModeModel.fields / accepted baseline | Include registry-backed configuration facts and provenance; omit environment/input literals |
| Placement, compute, deploy lanes | ModeModel / accepted baseline | Include declaration evidence; lanes never mean deployed/running |
| Connections and group members | ModelIndex, groupEntries/groupUse / baseline | Include bounded immediate relations, provenance and endpoints; especially input-group consumers |
| Islands | Existing Map scene / mounted Map | Publish existing membership, no duplicate classification/layout engine; outside Map membership may be unavailable |
| Source locations | SourceIndex / baseline | Repository-relative file, line, column; omit snippets and editor URLs |
| Dev/Prod differences | Both existing ModeModels | Compare safe metadata only; no reevaluation or resolved values |
| Diagnostics | Model/workspace owners | Include codes, severity, source and counts; omit arbitrary error text that may quote private inputs |
| Map search, tags, categories, navigator | Isometric useState / mounted Map | Include active filters; never camera, hover, pointer, frame timing or scrolling |
| Database tab, editor mode, schema selection | Database useState / mounted workspace | Include to identify the work in progress; schema metadata only |
| Database draft/validation | DatabaseSession / mounted workspace | Include dirty/conflict/current validity/problems; exclude source text and SQL |
| Migration selection | DatabaseHistory useState / mounted hidden tab | Include selected migration identity and load availability, not SQL or artifact text |
| Database target | DatabaseEvidence/DatabaseSql/DatabaseCloud | Include explicit target identity and availability by tab; never connection credentials, queries or row results |
| Deploy selected target, findings, review | Deploy / mounted workspace | Include target name/mode/region, finding IDs/severities, open review key and running job identities |
| Deployment observations | GlobalDeploymentObservations and TanStack cache / shell session | Always include Dev and Prod availability and labeled observed status/time/freshness; no new polling |
| AWS profile association | StudioProvider / repository-scoped session | Include configured availability, omit credential material and account IDs |
| Cognito subsection/destination | AuthenticationWorkspace / persistent across child routes | Include source vs observed identities. Pool/provider selection only when accepted selection identifies one; do not infer selection from disclosure DOM |
| Cognito users, attributes and provider secrets | Workspace protected responses/forms | Exclude entirely |
| Domains destination and domain intent | DomainsWorkspace and protected source inputs | Include destination, input names/presence/pending changes and diagnostic metadata. Domain values themselves are env-file values and excluded |
| WebSocket panels/connections | WebSocketTester / mounted page | Include Local and AWS connection state/configured/valid; both panels coexist, no invented active panel |
| WebSocket URL/token/messages | WebSocketTester | Exclude even if a URL looks public; query strings can carry tokens |
| GraphQL | GraphQL route | Explicit placeholder; no fabricated schema/workspace work |
| Agent test | AgentLab / mounted page | Minimal experiment label only; omit prompt, proposal and CLI output |
| Running/recent operations | Existing operations cache / shell session | Include kind/status/execution/outcome/times/deployment; exclude params, titles, summaries, logs and recovery prose |
| Synthesized inventory | Explicit inspector query / inspector session | Not globally available; do not imply declared facts were synthesized |
| Source/private detail caches | Selected inspectors | Exclude; the public graph being safe does not make protected detail responses safe |

### One-way workspace publication

Moving local choices into URL search was rejected: it changes navigation, history and
the shared unsaved-change guard. Lifting every choice into StudioProvider was rejected:
it spreads a debug consumer through core ownership and causes unrelated rerenders.
A global query-cache scrape cannot see local state, and may disclose protected values.

Use a small browser-only registry of typed, lazy workspace readers. An owner registers
a reader and removes it on unmount; a committed reader closure points at its existing
local state. Workspaces never read Sightline back. The registry has no polling or network
activity. With both Sightline and Coding closed there are no projection, route, cache or observation
subscriptions for this feature and no reader invocation. The unavoidable seam is reader
registration/closure replacement during an owner's existing commit; it collects no data
and schedules no owner render. This is preferable to a visibility subscription in every
workspace. When visible, changes notify only the consumer; child tab readers compose into
one workspace fragment. Unmount identity guards prevent old cleanup from clearing a new
workspace. Route matching prevents a previous workspace fragment appearing during lazy
navigation. Large/private values are never copied into published fragments.

One Sightline contributor per workspace is an exhaustive typed map. A route/workspace
coverage check ties that map to Studio's real routes, so adding a destination requires
an explicit contributor. Each contributor allow-lists its output again. Registration is
browser glue, not a second application state store or an API for workspaces to depend on.

## JSON contract

The Coding composer serializes this same 12,000-character bounded object. It exposes
**Inspect task context** and **Include current Studio context**; it never broadens the
allow-list to fill missing evidence. The independent host stores the accepted bounded
context with the task. No pull tools or fresh operational reads are implied by this
first integration. See [Coding tasks](local-agent-lab.md#coding-tasks) for task lifecycle,
source approval and the distinction between source permissions and operational authority.

`schemaVersion: 1`, `capturedAt`, `location`, `source`, `focus`, `workspace`,
`deployments: {dev, prod}`, `activity`, `issues`, and `omitted` are always present.
Capture time describes this projection, not observation freshness. Source contains
accepted mode/revision, latest revision, model status, stale/evaluating and draft flags.
Workspace is a discriminated union. Availability is explicit: not-loaded, loading,
error, available and not-applicable are different from an available empty collection.
Deployment keeps the existing missing-profile/loading-profiles/unavailable-profile/
catalog-error/available states, plus cache evidence availability.
Observed freshness is evaluated at capture using the existing read owner's stale-time
policy, invalidation and failure state. `freshUntil` makes that boundary inspectable;
there is no extra timer. A disabled query's `isStale` flag alone cannot supply this fact.

Focus is null when nothing is selected. Otherwise it has status (found, not-found,
other-mode-only, stale-model or renamed), kind/id/name, available metadata and a separate
rename/source-staleness indication so concurrent conditions cannot be lost. Focus handles
gateway, target, route, resource (including groups, inputs, secrets and files), local
service, island, defaults, network, connection and schema. Unknown IDs remain explicit.
Unavailable fields say not-applicable or not-loaded, rather than inventing facts.

Evidence sections are named declared, observed and localView. Connections keep their
original declared/derived/source provenance. Source locations are not runtime evidence.
Dev/Prod comparison contains presence, bounded safe leaf differences and changed connections,
not full duplicate entities. Names, catalog paths, public routes, target references and construct IDs retain
their existing meanings.

Actual captures from the real repository on port 4591 (November 5, 2026). These
are complete objects, including empty or unavailable evidence. The deployment names
come from this repository; they do not imply a deployment exists.

<details>
<summary>Map overview</summary>

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-11-05T08:05:07.344Z",
  "location": {
    "pathname": "/",
    "workspace": "map",
    "subsection": null
  },
  "source": {
    "mode": "dev",
    "revision": "1-b5ecbab4c1da",
    "latestRevision": "1-b5ecbab4c1da",
    "modelStatus": "ok",
    "stale": false,
    "evaluating": false,
    "connected": true,
    "draft": {
      "dirty": false,
      "conflicted": false
    }
  },
  "focus": null,
  "workspace": {
    "kind": "map",
    "localView": {
      "availability": "available",
      "search": "",
      "resourceKind": "",
      "categories": [
        "interactions"
      ],
      "errorsShown": true,
      "tagFilter": {
        "key": "",
        "value": null
      },
      "view": "closed"
    },
    "declared": {
      "counts": {
        "targets": 27,
        "routes": 16,
        "resources": 93,
        "gateways": 2,
        "localServices": 1,
        "connections": 139
      },
      "networks": [
        {
          "id": "application",
          "name": "application",
          "constructId": "NetworkStack",
          "cidr": "10.0.0.0/16",
          "zones": 2,
          "natGateway": false,
          "egressOnlyInternetGateway": true,
          "subnets": [
            {
              "name": "public",
              "egress": {
                "ipv4": true,
                "ipv6": true
              }
            },
            {
              "name": "private",
              "egress": {
                "ipv4": false,
                "ipv6": true
              }
            },
            {
              "name": "isolated",
              "egress": {
                "ipv4": false,
                "ipv6": false
              }
            }
          ],
          "gatewayEndpoints": [
            "s3",
            "dynamodb"
          ],
          "interfaceEndpoints": [],
          "builtInProd": true
        }
      ]
    }
  },
  "deployments": {
    "dev": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-dev",
        "mode": "dev"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    },
    "prod": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-prod",
        "mode": "prod",
        "region": "us-east-1"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    }
  },
  "activity": {
    "evidence": "observed",
    "availability": "available",
    "updatedAt": "2026-11-05T08:05:06.887Z",
    "counts": {
      "running": 0,
      "recent": 13
    },
    "running": [],
    "recent": [
      {
        "id": "mw32u00k-2b7d1d",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T05:00:02.324Z",
        "endedAt": "2026-11-05T05:00:06.990Z"
      },
      {
        "id": "mw2u6xuq-ba817c",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T00:58:09.506Z",
        "endedAt": "2026-11-05T00:58:13.985Z"
      },
      {
        "id": "mw2fep30-860f84",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:04:17.148Z",
        "endedAt": "2026-11-04T18:04:19.913Z"
      },
      {
        "id": "mw2fa87k-1ac3a3",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:00:48.656Z",
        "endedAt": "2026-11-04T18:00:52.069Z"
      }
    ]
  },
  "issues": [],
  "omitted": [
    {
      "path": "source.repositoryRoot-privateValues-sourceText",
      "reason": "privacy"
    },
    {
      "path": "activity.logs-params-titles-summaries-recovery",
      "reason": "privacy"
    },
    {
      "path": "activity.recent",
      "reason": "budget",
      "count": 9
    }
  ]
}
```

</details>

<details>
<summary>Database, saved schema editor</summary>

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-11-05T08:05:18.450Z",
  "location": {
    "pathname": "/database",
    "workspace": "database",
    "subsection": null
  },
  "source": {
    "mode": "dev",
    "revision": "1-b5ecbab4c1da",
    "latestRevision": "1-b5ecbab4c1da",
    "modelStatus": "ok",
    "stale": false,
    "evaluating": false,
    "connected": true,
    "draft": {
      "dirty": false,
      "conflicted": false
    }
  },
  "focus": null,
  "workspace": {
    "kind": "database",
    "evidence": "local-view",
    "availability": "available",
    "tab": "schema",
    "editorMode": "split",
    "selection": null,
    "draft": {
      "dirty": false,
      "conflicted": false
    },
    "revision": "987ce4aeca616b265ce9a90b5b5b547cf30812cc30b25016d149fb05c2d7a970",
    "file": "packages/database/prisma/contract.prisma",
    "validation": {
      "availability": "available",
      "current": true,
      "valid": true,
      "diagnostics": [],
      "diagramRetained": false
    },
    "migration": {
      "availability": "not-loaded",
      "selectedId": null,
      "selected": null,
      "busy": null
    },
    "target": {
      "availability": "not-applicable",
      "id": null,
      "selected": null,
      "inspecting": false,
      "reviewing": false,
      "applying": false,
      "observed": {
        "availability": "not-loaded"
      },
      "cloud": {
        "availability": "not-applicable"
      }
    }
  },
  "deployments": {
    "dev": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-dev",
        "mode": "dev"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    },
    "prod": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-prod",
        "mode": "prod",
        "region": "us-east-1"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    }
  },
  "activity": {
    "evidence": "observed",
    "availability": "available",
    "updatedAt": "2026-11-05T08:05:18.243Z",
    "counts": {
      "running": 0,
      "recent": 13
    },
    "running": [],
    "recent": [
      {
        "id": "mw32u00k-2b7d1d",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T05:00:02.324Z",
        "endedAt": "2026-11-05T05:00:06.990Z"
      },
      {
        "id": "mw2u6xuq-ba817c",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T00:58:09.506Z",
        "endedAt": "2026-11-05T00:58:13.985Z"
      },
      {
        "id": "mw2fep30-860f84",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:04:17.148Z",
        "endedAt": "2026-11-04T18:04:19.913Z"
      },
      {
        "id": "mw2fa87k-1ac3a3",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:00:48.656Z",
        "endedAt": "2026-11-04T18:00:52.069Z"
      }
    ]
  },
  "issues": [],
  "omitted": [
    {
      "path": "source.repositoryRoot-privateValues-sourceText",
      "reason": "privacy"
    },
    {
      "path": "workspace.database.source-sql-results-errors",
      "reason": "privacy"
    },
    {
      "path": "activity.logs-params-titles-summaries-recovery",
      "reason": "privacy"
    },
    {
      "path": "activity.recent",
      "reason": "budget",
      "count": 9
    }
  ]
}
```

</details>

<details>
<summary>Deploy with no associated AWS profile</summary>

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-11-05T08:05:20.084Z",
  "location": {
    "pathname": "/deploy",
    "workspace": "deploy",
    "subsection": null
  },
  "source": {
    "mode": "dev",
    "revision": "1-b5ecbab4c1da",
    "latestRevision": "1-b5ecbab4c1da",
    "modelStatus": "ok",
    "stale": false,
    "evaluating": false,
    "connected": true,
    "draft": {
      "dirty": false,
      "conflicted": false
    }
  },
  "focus": null,
  "workspace": {
    "kind": "deploy",
    "evidence": "local-view",
    "availability": "available",
    "target": {
      "name": "studio-test-dev",
      "mode": "dev"
    },
    "reviewKey": null,
    "findings": {
      "availability": "not-loaded",
      "entries": null
    },
    "running": []
  },
  "deployments": {
    "dev": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-dev",
        "mode": "dev"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    },
    "prod": {
      "availability": "missing-profile",
      "target": {
        "evidence": "declared",
        "name": "studio-test-prod",
        "mode": "prod",
        "region": "us-east-1"
      },
      "observed": {
        "evidence": "observed",
        "availability": "not-loaded"
      }
    }
  },
  "activity": {
    "evidence": "observed",
    "availability": "available",
    "updatedAt": "2026-11-05T08:05:19.771Z",
    "counts": {
      "running": 0,
      "recent": 13
    },
    "running": [],
    "recent": [
      {
        "id": "mw32u00k-2b7d1d",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T05:00:02.324Z",
        "endedAt": "2026-11-05T05:00:06.990Z"
      },
      {
        "id": "mw2u6xuq-ba817c",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-05T00:58:09.506Z",
        "endedAt": "2026-11-05T00:58:13.985Z"
      },
      {
        "id": "mw2fep30-860f84",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:04:17.148Z",
        "endedAt": "2026-11-04T18:04:19.913Z"
      },
      {
        "id": "mw2fa87k-1ac3a3",
        "kind": "docker-start",
        "status": "succeeded",
        "startedAt": "2026-11-04T18:00:48.656Z",
        "endedAt": "2026-11-04T18:00:52.069Z"
      }
    ]
  },
  "issues": [],
  "omitted": [
    {
      "path": "source.repositoryRoot-privateValues-sourceText",
      "reason": "privacy"
    },
    {
      "path": "workspace.deploy.finding-details-review-content",
      "reason": "privacy"
    },
    {
      "path": "activity.logs-params-titles-summaries-recovery",
      "reason": "privacy"
    },
    {
      "path": "activity.recent",
      "reason": "budget",
      "count": 9
    }
  ]
}
```

</details>

For `/?select=resource%3Alanggraph`, focus identifies the `langgraph` group, its
four named provider/model inputs, each requirement state and repository-relative input
file, the example agent consuming them, and their source relationships. It withholds
input values and shows bounded Dev/Prod leaf and connection differences. The final
real capture fits below the unchanged 12,000-character limit.

### Privacy and size

Build every field explicitly; never spread models, responses or query objects. Omit all
literal environment values, input defaults/values/comparisons, private input details,
AWS account IDs/ARNs/caller identities, credentials, tokens, logs, SQL, row data, user data,
socket payloads and absolute paths. Account IDs are not passwords, but destination name,
mode and region suffice for this debug consumer; any future operational resolver must
resolve account identity on the server. Environment variable names and symbolic references
remain useful without values. Structured configuration such as memory, subnet and timeout
is allowed. Arbitrary diagnostic text and source snippets are withheld because they can
quote private values. Paths must be repository-relative with no traversal. Descriptions,
tags and display names are bounded source data, never mixed with instructions.

`SIGHTLINE_CHARACTER_BUDGET = 12_000` measures compact `JSON.stringify` characters,
the exact copied representation. Bound collections and prose first, then trim low-priority
detail deterministically. Preserve location/source/focus identity/both deployments/activity
availability. Every deliberate privacy, relevance or budget cut is recorded in `omitted`
with path and reason (and count where known). Canary fixtures seed all excluded surfaces,
including nested query responses and unknown keys; every workspace/selection must contain
none of those markers. This tests an allow-list, not a secret-pattern blacklist.

## Relevance matrix

Each row has three realistic questions and the corresponding retained evidence. No field
is retained merely because it was convenient to serialize. Real-app captures will refine
this matrix after implementation.

| Route or selection | Questions | Answer / deliberate limit |
| --- | --- | --- |
| Map overview `/` | What is in this app? Which networks does it declare? Why is my view narrowed? | Counts; declared networks; active search/tag/category filters |
| Gateway | Which protocol? Which routes/authorizer? Is it intended for this mode? | Gateway kind/routes/authorizer and mode presence; no deployed inference |
| Target | What runs and where? Why these settings? What does it depend on? | Compute/placement/lanes; field provenance; bounded connections and symbolic env/secret refs |
| Route | Which public path/methods? Which target? What guards it? | path/browserPath/methods; target ID; auth/authorizer |
| Resource/member/stack | What is it and where authored? Who consumes it? Does Dev differ from Prod? | Kind/catalog/source/stack metadata; connections; safe metadata comparison |
| Input group (`langgraph`) | Which inputs are required? Which workloads use them? What is missing here? | Members and requirement states; member consumers; relevant issue metadata, no values |
| Input/secret/env file | What name/reference is this? Is a required value supplied? Who reads it? | Identity, safe availability/requirement state, connections; values always withheld |
| Local service | Which Compose service? Which declared database counterpart? Is it running? | Local identity/source/ports where safe and connections; runtime explicitly unknown |
| Island | Which entries are grouped here? Why this grouping? What issues affect members? | Existing scene title/membership and issue counts; membership unavailable outside current Map scene |
| Defaults | Which effective defaults? Where from? How many inherit/override? | Field facts, provenance and usage |
| Network | Which VPC/subnets? What egress is declared? Is it deployed? | Stable ID/construct/placement/egress; declared-only, deployment summary cannot prove individual VPC presence |
| Connection | What relates these endpoints? What evidence supports it? Does it exist in both modes? | Relation/direction/provenance/source and mode comparison; no full IAM proof |
| Schema selection | Which logical/storage entity? Which fields/relations? Is the editor current? | Saved schema metadata plus local selection/validation; no rows or query data |
| Database `/database` | Which tab/editor/selection? Is my schema dirty or invalid? Which migration and target? | Local choices, draft/validation metadata, migration and target readers; no automatic DB inspection |
| Deploy `/deploy` | Which destination? What findings/review? What is running? | Explicit workspace target, finding IDs/severity/review key, summarized cached jobs |
| Cognito `/cognito`, `/user-pools` | Which subsection/pool? What declaration/observation exists? Which destination? | Subsection, accepted pool identity if selected, observation availability and explicit destination; no users |
| Cognito `/identity-pools` | Which identity pool? Where authored/observed? Which mode/destination? | Accepted selection, existing metadata availability, destination; no fabricated local selection |
| Cognito `/providers` | Which provider is selected? Is source loaded? What needs attention? | Accepted provider selection if any, source status, diagnostic codes/counts; disclosure open state omitted |
| Cognito `/permissions` | Which pool/provider is in focus? Has evidence been inspected? Is that evidence current? | Accepted focus, observation status/time/staleness; arbitrary policy/simulation payload omitted |
| Domains `/domains` | Which destination? What domain intent is configured? What diagnostics are current? | Destination; input names/presence/pending changes; diagnostic availability/codes. Values withheld |
| WebSockets `/websockets` | Which panels exist? Are they connected? Is a URL configured/valid? | Local/AWS panel states and booleans; tokens/URL/message contents omitted |
| GraphQL `/graphql` | Is this implemented? What source mode? What is selected? | Explicit placeholder; mandatory source and focus |
| Agent test `/test` | Where am I? What experiment? What else is running? | Minimal fixed-message experiment label; mandatory source/activity; no prompt/plan data |

## Future pull tools: analysis only

The current Coding integration captures the bounded JSON once at submission. The
following narrower pull-based design remains a future option; it is not an implemented
tool API, and Conversation retains its unchanged inputs.

A pull model is preferable to sending the full debug JSON with every question. Send a
small question-time Sightline containing version, location, accepted source revision/mode,
focus identity/status/rename, local selection and draft flags, deployment availability and
target identity, running operation summaries and relevant diagnostic counts. Capture once
per submitted question; do not stream navigation or hover into a conversation. Browser-only
facts include unsaved flags, active filters/tabs, editor selection and connection booleans.
Do not transmit unsaved text or protected values.

Read-only lookups could later resolve source-backed details by canonical ID and revision:
effective fields/provenance, bounded related entities, group members, source locations,
safe schema metadata, fresh deployment evidence under explicit policy, and structured
diagnostics. The server would validate workspace/ID/revision and independently resolve
its own accepted model, permissions and destination; browser JSON cannot authorize reads
or writes. Any new AWS read needs its own policy rather than this cache-only feature.
Descriptions/tags remain untrusted data separated from trusted system instructions.
An operation proposal would still need the existing target-bound review/approval flow.
None of that delivery or lookup machinery is implemented here.

## Critique, revisions and gaps

The initial instinct to serialize an Inspector or workspace response fails the privacy and
authority rules. Revision: explicit allow-lists at each contributor and the pure builder,
no response spreads, no query-cache enumeration. A selected input group needs member
consumers, so a direct-edge-only focus was rejected. Full duplicated Dev/Prod entities
waste budget; compare projected safe metadata instead. Derived resource availability is
not observed AWS health. Reuse existing state labels and never substitute `[]` for a read
that has not happened.

The existing model lacks safe structured codes for many diagnostic messages; current
owners are source evaluation/diagnostics and each workspace service. Counts/severity and
source can be retained now; adding value-free codes/entity references would improve future
explanations, but requires a separate user decision. No producer changes here.

Island membership is a scene projection with no cheap standalone shared selector. Its
existing owner is scene/build.ts. Reusing the mounted scene avoids expensive duplicate
layout work; carried island selection on another workspace may lack member detail.
Cognito has no dedicated selected pool/provider state beyond accepted shared selection;
do not manufacture it. Domains intent values belong to the protected deployment-input
owner and remain withheld even though this limits answering exact hostname questions.
Synthesized per-entity evidence is not globally available; its owner remains the explicit
stack inventory service. A deployment summary cannot establish whether one declaration
exists in AWS. None of these gaps requires a DSL/core-model change for this proof of concept.

## Verification and removal review

Disposable evidence is in `output/playwright/sightline/`; the permanent browser spec is
`framework-studio/test/browser/sightline.spec.ts`. The design was committed before feature
code. The budget remains 12,000 characters: the final real-app capture set spans 1,790–8,832
compact characters, and the oversized unit fixture fits at 11,774 with 24 recorded cuts.
No measurement justified increasing the limit.

### Real-app capture review

The second Studio ran on port 4591 against this repository. Port 4590 and running dev
stacks were left alone. A fresh browser with no selected AWS profile visited every route,
all listed selection kinds and Cognito subsection, then switched source mode and tested
1440px/390px and light/dark presentation. Each of the 25 captures was read as JSON and
paired with a screenshot. The separate DevTools browser found no console errors or warnings.
No AWS action, deployment, migration, database apply or model request was performed.

| Capture group | Useful facts checked / resulting decision |
| --- | --- |
| Map overview | Counts, networks, issue counts and live filters; avoid whole entity inventories |
| Langgraph, Prod and mobile variants | Four input members, requirement state, input file, consuming agent and relationships; added group consumers and concrete safe mode differences |
| Gateway and route | Gateway kind/route ownership and target references; public route remains distinct from target/construct identity |
| Target | Effective configuration/provenance, placement, lanes and implementation readiness; repository-owned absolute directory becomes a relative path |
| Local service | Compose source, image/dependencies and lanes; environment values remain absent |
| Island | Existing scene membership and metadata; do not run layout to reconstruct it elsewhere |
| Defaults | Inherited fields/usage and source; no fabricated deployment evidence |
| Network fixture | Network identity, NAT/endpoints/gateway settings; expanded settings needed to explain placement |
| Connection | Original endpoints, relationship/provenance and mode differences; no invented invocation history |
| Database and schema | Active editor/tab, dirty/validation state, selected logical/storage schema metadata; raw type expressions were found to contain defaults/SQL and are now withheld |
| Deploy | Explicit target, finding availability, open review and work; missing-profile stays separate from not-loaded AWS observations |
| Cognito plus four subsections | Subsection, destination, declared identities and observation availability; no false pool selection or user data |
| Domains | Production intent authority, destination, input names/presence and diagnostics; exact hostnames remain private-input data |
| WebSockets | Both panel states and configured/valid booleans; connection URL/messages/tokens stay absent |
| GraphQL | Honest placeholder plus mandatory envelope |
| Test | Minimal experiment identity plus mandatory envelope |

These checks revised the relevance matrix above. Fixture browser tests additionally
exercise live cached AWS evidence, dirty drafts, source publication, operations, migration
selection and WebSocket connection transitions without making those real-world changes.
Real AWS observations and deployed behavior remain unverified by design.

### Original Sightline proof-of-concept checks and known failures

The final focused unit suite passed all 20 tests and covers every workspace, selectable kind and focus state,
determinism, canaries, budget/omissions, availability, freshness and registry lifetimes.
The final focused browser suite passed all 48 tests, including the unchanged
`agent-panel.spec.ts` (28 tests). It checks both
themes, keyboard/axe accessibility, 1440px/390px, navigation/history, map selection,
accepted source mode, live state, copy/count, preserved expansion/chat/draft/scroll and
the exact unchanged chat body. Opening Sightline adds zero API requests, event streams
or WebSocket connections compared with leaving it closed. Lazy JavaScript chunks are
ordinary code loading and are not counted as data reads.

The complete Studio unit run recorded 1,438 passes, 14 failures and 3 skips. Thirteen
failures reproduce against untouched starting commit `510fb39`. The remaining VPC-rim
assertion passes in isolation but fails in the current full isometric file. Replacing
Sightline publication with an inert function in memory reproduces the exact same five
isometric failures, including that assertion, with the same checkout and private-input
availability. This rules out the new workspace seam; its underlying order/environment
cause remains unresolved. The baseline archive omits ignored private inputs, so its
additional fixture failures are not presented as evidence of a regression here.
The complete browser run recorded 456 passes and 30 failures (15 per theme). Every
failing category reproduces on the starting commit: old footer screenshots, a removed
machine heading, and old deployment-read expectations. Eleven of twelve compared
screenshots are byte-identical; the remaining one differs by five antialiasing pixels.
Existing tests and screenshot expectations were not changed.

`npm run verify` reaches Studio typechecking, then fails at four existing references to
`LayoutQuality.crowding` in `test/island-composition.test.ts`. Earlier verification gates
passed; gates after that failure did not execute. The user explicitly chose to keep
layout repair separate. An existing Database diagram label also fails the page-wide
light-theme contrast scan; Sightline's accessibility checks pass on the GraphQL page.
Frontend TypeScript and `node docs/aws-studio-knowledge/check.mjs` pass. The production
client and browser-gallery builds pass. No infrastructure synth, integration with real AWS,
live database application or deployed check was run. The repository-wide green gate is
therefore not claimed. Detailed commands/results and
baseline comparisons are retained in the evidence directory.

### Existing-file seams and removal

This table records the original debug-view implementation. Coding now also consumes the
projection; removing Sightline requires removing or replacing that context capture first.

| Existing file (under `framework-studio/src/views/` unless stated) | Change and reason |
| --- | --- |
| `GlobalActivity.tsx` | Lazy-load `AgentViews`; own the display-only view choice, shown by `AgentViewTabs` in the bar, and pass its conversation visibility to the existing chat owner so hidden replies remain unread. No route/Studio subscription |
| `Isometric.tsx` | Publish lazy filter/search/view and existing island membership metadata |
| `Database.tsx` | Publish tab/editor/selection, draft and value-free validation metadata |
| `DatabaseHistory.tsx` | Publish selected migration identity and load state |
| `DatabaseEvidence.tsx` | Publish selected target and already available observation statuses |
| `DatabaseCloud.tsx` | Publish target, busy and review-open state |
| `DatabaseSql.tsx` | Publish target, busy and review-open state, never SQL |
| `Deploy.tsx` | Publish destination, finding codes/severity, review key and running job identities |
| `AuthenticationWorkspace.tsx` | Publish subsection, destination and allowed declared/observed identity metadata |
| `DomainsWorkspace.tsx` | Publish destination, input presence/pending-change flags and safe diagnostics from the workspace and its local controls |
| `websockets/WebSockets.tsx` | Publish existing defaults-read availability |
| `websockets/WebSocketTester.tsx` | Publish each panel's connection/configured/valid state |
| `docs/aws-studio-knowledge/README.md` | Add canonical task routing row |
| `docs/aws-studio-knowledge/reference/glossary.md` | Define Sightline and its read-only/debug-only boundary |
| `docs/aws-studio-knowledge/studio/interface.md` | Document new display/publication ownership and lifecycle |
| `docs/framework-studio/local-agent-lab.md` | Document the view, preserved conversation and unchanged model input |

Remove `src/sightline/`, its new tests and canonical doc, undo the imports/publications in
the table, restore the old lazy AgentPanel import/chat visibility, and remove the four doc
additions to remove the feature. No provider, model, server, core declaration or generator
needs repair. Workspaces retain their owners, setters, URL behavior and render triggers.
Only the visible consumer receives publication notifications. With both consumer views closed, the constant
registration cost is the documented exception to a literal zero-instruction interpretation
of “no work”; there is no closed-view projection, subscriber, polling or data read.

The weakest part is maintaining safe adapters beside many local owners. Explicit typing,
route coverage and canaries constrain drift, but cannot decide whether a newly introduced
field is useful or safe. Sparse structured diagnostic metadata also limits explanations.
Keep the future pull model small, and require a separate reviewed projection for every
new detail surface. No current gap warrants changing a declaration for Sightline.
