import type { Mode, Snapshot } from "../../shared/model";
import type { SightlineOmission } from "./types";
import { relativePath, text as safeText } from "./safe";

export type WorkspaceKind =
  | "map"
  | "database"
  | "deploy"
  | "cognito"
  | "domains"
  | "websockets"
  | "graphql"
  | "test";
type Availability =
  "not-loaded" | "loading" | "error" | "available" | "not-applicable";
type Diagnostic = {
  code?: string;
  severity: string;
  from?: number;
  to?: number;
};
type Destination = { deployment: string; region: string };
type Selection = { table: string; field?: string; relation?: string };
export interface WorkspaceFragments {
  map?: {
    search: string;
    resourceKind: string;
    categories: readonly string[];
    errorsShown: boolean;
    tagFilter: { key: string; value: string | null };
    view: string;
    islands: readonly {
      id: string;
      title: string;
      members: readonly { id: string; name: string }[];
    }[];
  };
  database?: {
    availability: Availability;
    tab: "schema" | "history" | "database" | "sql" | "retention";
    editorMode: "split" | "source" | "diagram";
    selection?: Selection;
    dirty: boolean;
    conflicted: boolean;
    validation: {
      availability: Availability;
      current: boolean;
      valid?: boolean;
      diagnostics: readonly Diagnostic[];
    };
    diagramRetained: boolean;
    revision?: string;
    file?: string;
  };
  databaseHistory?: {
    availability: Availability;
    selectedId?: string;
    selected?: {
      id: string;
      name: string;
      from: string | null;
      to: string;
      integrity: string;
    };
    busy?: string;
  };
  databaseTarget?: {
    availability: Availability;
    targetId?: string;
    target?: { id: string; label: string; available: boolean };
    inspecting: boolean;
    reviewing: boolean;
    applying: boolean;
    observation?: {
      status: string;
      observedAt: string;
      marker: string;
      physical: string;
      migrationState: string;
    };
  };
  databaseCloud?: {
    deployment: string;
    targetId: string;
    busy?: string;
    reviewOpen: boolean;
  };
  databaseSql?: { targetId: string; busy: boolean; reviewOpen: boolean };
  deploy?: {
    availability: Availability;
    target?: { name: string; mode: Mode; region?: string };
    reviewKey?: string;
    findings: {
      availability: Availability;
      entries: readonly { code: string; severity: string; scope: string }[];
    };
    running: readonly { id: string; kind: string; status: string }[];
  };
  cognito?: {
    subsection: string;
    destination: Destination;
    source: {
      availability: Availability;
      declaredPoolIds: readonly string[];
      providers?: readonly {
        id: string;
        name: string;
        type: string;
        scope: string;
      }[];
      problemCount?: number;
    };
    observed: {
      availability: Availability;
      poolId?: string;
      observedAt?: string;
      stale: boolean;
      providerNames?: readonly string[];
      identityPoolIds?: readonly string[];
    };
  };
  domainIntent?: {
    inputs: readonly { name: string; present: boolean; modified: boolean }[];
    diagnostics: readonly Diagnostic[];
  };
  domains?: {
    destination: Destination;
    source: {
      availability: Availability;
      mode: "prod";
      inputs?: readonly { name: string; present: boolean; modified: boolean }[];
      diagnostics?: readonly Diagnostic[];
    };
    observed: {
      availability: Availability;
      observedAt?: string;
      stale: boolean;
      certificateStatuses?: readonly {
        purpose: string;
        status?: string;
        problemCount: number;
      }[];
      warningCount?: number;
      dnsProblemCount?: number;
    };
  };
  websockets?: { availability: Availability };
  websocketLocal?: {
    connection: "connecting" | "connected" | "disconnected";
    configured: boolean;
    valid: boolean;
  };
  websocketAws?: {
    connection: "connecting" | "connected" | "disconnected";
    configured: boolean;
    valid: boolean;
  };
}

export const sightlineWorkspacePaths = {
  "/": "map",
  "/database": "database",
  "/deploy": "deploy",
  "/cognito": "cognito",
  "/domains": "domains",
  "/websockets": "websockets",
  "/graphql": "graphql",
  "/test": "test",
} as const satisfies Record<string, WorkspaceKind>;
export function workspaceFor(pathname: string): WorkspaceKind {
  if (pathname === "/cognito" || pathname.startsWith("/cognito/"))
    return "cognito";
  return (
    sightlineWorkspacePaths[pathname as keyof typeof sightlineWorkspacePaths] ??
    "map"
  );
}

const destination = (value: Destination) => ({
  deployment: value.deployment,
  region: value.region,
});
const diagnostic = (value: Diagnostic) => ({
  code: value.code,
  severity: value.severity,
  from: value.from,
  to: value.to,
});
const selection = (value?: Selection) =>
  value
    ? {
        table: value.table,
        field: value.field,
        relation: value.relation,
      }
    : null;
const privacy = (omitted: SightlineOmission[], path: string) =>
  omitted.push({ path, reason: "privacy" });
function limit<T>(
  values: readonly T[],
  path: string,
  omitted: SightlineOmission[],
  count = 12,
): readonly T[] {
  if (values.length > count)
    omitted.push({ path, reason: "budget", count: values.length - count });
  return values.slice(0, count);
}
type ContributorInput = {
  fragments: WorkspaceFragments;
  snapshot: Snapshot;
  mode: Mode;
  omitted: SightlineOmission[];
};
const contributors = {
  map: ({ fragments, snapshot, mode, omitted }: ContributorInput) => {
    const view = fragments.map,
      model = snapshot.models[mode];
    const networks = limit(
      model.networks ?? [],
      "workspace.declared.networks",
      omitted,
    ).map((network) => ({
      id: network.id,
      name: network.name,
      constructId: network.constructId,
      cidr: network.cidr,
      zones: network.zones,
      natGateway: network.natGateway,
      egressOnlyInternetGateway: network.egressOnlyInternetGateway,
      subnets: network.subnets.map((subnet) => ({
        name: subnet.name,
        egress: { ipv4: subnet.egress.ipv4, ipv6: subnet.egress.ipv6 },
      })),
      gatewayEndpoints: network.gatewayEndpoints.map((value) => value),
      interfaceEndpoints: network.interfaceEndpoints.map((value) => value),
      builtInProd: network.builtInProd,
    }));
    return {
      kind: "map" as const,
      localView: view
        ? {
            availability: "available",
            search: view.search,
            resourceKind: view.resourceKind,
            categories: view.categories.map((value) => value),
            errorsShown: view.errorsShown,
            tagFilter: {
              key: view.tagFilter.key,
              value: view.tagFilter.value ?? null,
            },
            view: view.view,
          }
        : { availability: "not-loaded" },
      declared: {
        counts: {
          targets: model.targets.length,
          routes: model.routes.length,
          resources: model.resources.length,
          gateways: model.gateways?.length ?? 0,
          localServices: model.localServices?.length ?? 0,
          connections: model.edges.length,
        },
        networks,
      },
    };
  },
  database: ({ fragments: f, omitted }: ContributorInput) => {
    const d = f.database,
      h = f.databaseHistory,
      t = f.databaseTarget,
      sql = f.databaseSql,
      cloud = f.databaseCloud;
    privacy(omitted, "workspace.database.source-sql-results-errors");
    return {
      kind: "database" as const,
      evidence: "local-view",
      availability: d?.availability ?? "not-loaded",
      tab: d?.tab ?? null,
      editorMode: d?.editorMode ?? null,
      selection: selection(d?.selection),
      draft: d
        ? { dirty: d.dirty, conflicted: d.conflicted }
        : { availability: "not-loaded" },
      revision: d?.revision,
      file: relativePath(d?.file, "workspace.file", omitted),
      validation: d
        ? {
            availability: d.validation.availability,
            current: d.validation.current,
            valid: d.validation.valid,
            diagnostics:
              d.validation.availability === "not-loaded"
                ? null
                : limit(
                    d.validation.diagnostics,
                    "workspace.validation.diagnostics",
                    omitted,
                  ).map(diagnostic),
            diagramRetained: d.diagramRetained,
          }
        : { availability: "not-loaded" },
      migration: h
        ? {
            availability: h.availability,
            selectedId: h.selectedId ?? null,
            selected: h.selected
              ? {
                  id: h.selected.id,
                  name: h.selected.name,
                  from: h.selected.from ?? null,
                  to: h.selected.to,
                  integrity: h.selected.integrity,
                }
              : null,
            busy: h.busy ?? null,
          }
        : { availability: "not-loaded" },
      target:
        d?.tab === "sql"
          ? sql
            ? {
                availability: "available",
                id: sql.targetId,
                busy: sql.busy,
                reviewOpen: sql.reviewOpen,
              }
            : { availability: "not-loaded" }
          : t
            ? {
                availability: t.availability,
                id: t.targetId ?? null,
                selected: t.target
                  ? {
                      id: t.target.id,
                      label: t.target.label,
                      available: t.target.available,
                    }
                  : null,
                inspecting: t.inspecting,
                reviewing: t.reviewing,
                applying: t.applying,
                observed: t.observation
                  ? {
                      status: t.observation.status,
                      observedAt: t.observation.observedAt,
                      marker: t.observation.marker,
                      physical: t.observation.physical,
                      migrationState: t.observation.migrationState,
                    }
                  : { availability: "not-loaded" },
                cloud: cloud
                  ? {
                      deployment: cloud.deployment,
                      targetId: cloud.targetId,
                      busy: cloud.busy ?? null,
                      reviewOpen: cloud.reviewOpen,
                    }
                  : { availability: "not-applicable" },
              }
            : { availability: "not-loaded" },
    };
  },
  deploy: ({ fragments, omitted }: ContributorInput) => {
    const d = fragments.deploy;
    privacy(omitted, "workspace.deploy.finding-details-review-content");
    return {
      kind: "deploy" as const,
      evidence: "local-view",
      availability: d?.availability ?? "not-loaded",
      target: d?.target
        ? {
            name: d.target.name,
            mode: d.target.mode,
            region: d.target.region,
          }
        : null,
      reviewKey: d?.reviewKey ?? null,
      findings: {
        availability: d?.findings.availability ?? "not-loaded",
        entries:
          d && d.findings.availability === "available"
            ? limit(
                d.findings.entries,
                "workspace.findings.entries",
                omitted,
              ).map((f) => ({
                code: f.code,
                severity: f.severity,
                scope: f.scope,
              }))
            : null,
      },
      running: d
        ? limit(d.running, "workspace.running", omitted).map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
          }))
        : null,
    };
  },
  cognito: ({ fragments, omitted }: ContributorInput) => {
    const c = fragments.cognito;
    privacy(omitted, "workspace.cognito.users-provider-settings-input-values");
    return {
      kind: "cognito" as const,
      evidence: "local-view",
      availability: c ? "available" : "not-loaded",
      subsection: c?.subsection,
      destination: c ? destination(c.destination) : null,
      source: c
        ? {
            availability: c.source.availability,
            declaredPoolIds: limit(
              c.source.declaredPoolIds,
              "workspace.source.declaredPoolIds",
              omitted,
            ).map((value) => value),
            providers: c.source.providers
              ? limit(
                  c.source.providers,
                  "workspace.source.providers",
                  omitted,
                ).map((p) => ({
                  id: p.id,
                  name: p.name,
                  type: p.type,
                  scope: p.scope,
                }))
              : null,
            problemCount: c.source.problemCount,
          }
        : { availability: "not-loaded" },
      observed: c
        ? {
            availability: c.observed.availability,
            poolId: c.observed.poolId,
            observedAt: c.observed.observedAt,
            stale: c.observed.stale,
            providerNames: c.observed.providerNames
              ? limit(
                  c.observed.providerNames,
                  "workspace.observed.providerNames",
                  omitted,
                ).map((value) => value)
              : undefined,
            identityPoolIds: c.observed.identityPoolIds
              ? limit(
                  c.observed.identityPoolIds,
                  "workspace.observed.identityPoolIds",
                  omitted,
                ).map((value) => value)
              : undefined,
          }
        : { availability: "not-loaded" },
    };
  },
  domains: ({ fragments, omitted }: ContributorInput) => {
    const d = fragments.domains,
      intent = fragments.domainIntent;
    privacy(
      omitted,
      "workspace.domains.input-values-dns-values-arns-error-text",
    );
    return {
      kind: "domains" as const,
      evidence: "local-view",
      availability: d ? "available" : "not-loaded",
      destination: d ? destination(d.destination) : null,
      source: d
        ? {
            mode: "prod",
            availability: d.source.availability,
            inputs:
              intent?.inputs || d.source.inputs
                ? limit(
                    intent?.inputs ?? d.source.inputs!,
                    "workspace.source.inputs",
                    omitted,
                  ).map((i) => ({
                    name: i.name,
                    present: i.present,
                    modified: i.modified,
                  }))
                : null,
            diagnostics:
              intent?.diagnostics || d.source.diagnostics
                ? limit(
                    intent?.diagnostics ?? d.source.diagnostics!,
                    "workspace.source.diagnostics",
                    omitted,
                  ).map(diagnostic)
                : null,
          }
        : { mode: "prod", availability: "not-loaded" },
      observed: d
        ? {
            availability: d.observed.availability,
            observedAt: d.observed.observedAt,
            stale: d.observed.stale,
            certificateStatuses: d.observed.certificateStatuses
              ? limit(
                  d.observed.certificateStatuses,
                  "workspace.observed.certificateStatuses",
                  omitted,
                ).map((c) => ({
                  purpose: c.purpose,
                  status: c.status,
                  problemCount: c.problemCount,
                }))
              : undefined,
            warningCount: d.observed.warningCount,
            dnsProblemCount: d.observed.dnsProblemCount,
          }
        : { availability: "not-loaded" },
    };
  },
  websockets: ({ fragments, omitted }: ContributorInput) => {
    privacy(omitted, "workspace.websockets.urls-tokens-payloads-messages");
    const panel = (p: WorkspaceFragments["websocketLocal"]) =>
      p
        ? {
            availability: "available",
            connection: p.connection,
            configured: p.configured,
            valid: p.valid,
          }
        : { availability: "not-loaded" };
    return {
      kind: "websockets" as const,
      evidence: "local-view",
      availability: fragments.websockets?.availability ?? "not-loaded",
      panels: {
        local: panel(fragments.websocketLocal),
        aws: panel(fragments.websocketAws),
      },
    };
  },
  graphql: () => ({
    kind: "graphql" as const,
    availability: "not-applicable",
    status: "placeholder",
  }),
  test: () => ({
    kind: "test" as const,
    evidence: "local-view",
    experiment: "fixed-message coding CLI experiment",
  }),
} satisfies Record<WorkspaceKind, (inputs: ContributorInput) => unknown>;

export type SightlineWorkspace = ReturnType<
  (typeof contributors)[WorkspaceKind]
>;
export const sightlineContributorKinds = Object.keys(
  contributors,
) as WorkspaceKind[];
export function buildWorkspace(
  kind: WorkspaceKind,
  fragments: WorkspaceFragments,
  snapshot: Snapshot,
  mode: Mode,
  omitted: SightlineOmission[],
): SightlineWorkspace {
  const result = contributors[kind]({ fragments, snapshot, mode, omitted });
  // Only the explicitly projected structure reaches this pass. It is never a model serializer.
  const sanitize = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return safeText(value, path, omitted, 200);
    if (Array.isArray(value))
      return value.map((item, index) => sanitize(item, `${path}[${index}]`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          sanitize(item, `${path}.${key}`),
        ]),
      );
    return value;
  };
  return sanitize(result, "workspace") as SightlineWorkspace;
}
