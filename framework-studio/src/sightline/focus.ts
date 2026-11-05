import type {
  Compute,
  FieldFact,
  Lanes,
  Mode,
  ModeModel,
  ModelEdge,
  ModelResource,
  ModelTarget,
  Placement,
  Snapshot,
} from "../../shared/model";
import {
  ISLAND_IDS,
  connectionDescriptionId,
  networkFixtureIds,
} from "../../shared/descriptions";
import { aggregateConnections } from "../connections";
import { groupEntries, withinGroup } from "../input-groups";
import { indexModel, titleOf, type ModelIndex } from "../lookup";
import {
  bounded,
  lexical,
  notApplicable,
  omit,
  relativePath,
  sourceLocation,
  text,
} from "./safe";
import type {
  SightlineFocus,
  SightlineInputs,
  SightlineOmission,
  SightlineRecord,
  SightlineValue,
} from "./types";

const LAMBDA_FIELDS = [
  "architecture",
  "packaging",
  "runtime",
  "logRetentionDays",
  "bundling.minify",
  "bundling.sourceMap",
  "reservedConcurrentExecutions",
  "provisionedConcurrentExecutions",
  "subnet",
  "memorySize",
  "timeoutSeconds",
];
const FIELD_IDS = new Set([
  "deploy",
  "events.localReplay",
  "http.auth",
  "container.subnet",
  ...LAMBDA_FIELDS.map((key) => `lambda.${key}`),
  ...["lambda", "http", "webSocket", "events", "tools"].flatMap((group) =>
    LAMBDA_FIELDS.map((key) => `defaults.${group}.${key}`),
  ),
  "defaults.container.architecture",
  "defaults.container.subnet",
  "defaults.database.pool.maxConnections",
  "defaults.database.pool.connectionTimeoutMs",
  "defaults.database.pool.idleTimeoutMs",
]);

function fields(
  values: readonly FieldFact[],
  omitted: SightlineOmission[],
): readonly SightlineRecord[] {
  const allowed = values.filter((value) => FIELD_IDS.has(value.field));
  if (allowed.length !== values.length)
    omit(
      omitted,
      "focus.declared.fields.unrecognized",
      "privacy",
      values.length - allowed.length,
    );
  const primitive = (
    value: string | number | boolean | null | undefined,
    path: string,
  ) => (typeof value === "string" ? text(value, path, omitted, 120) : value);
  return bounded(allowed, 24, "focus.declared.fields", omitted).map((fact) => ({
    field: fact.field,
    effective: primitive(fact.effective, "focus.declared.fields.effective"),
    provenance: text(
      fact.provenance,
      "focus.declared.fields.provenance",
      omitted,
    ),
    authored: primitive(fact.authored, "focus.declared.fields.authored"),
    inherited: fact.inherited
      ? {
          value: primitive(
            fact.inherited.value,
            "focus.declared.fields.inherited.value",
          ),
          from: text(
            fact.inherited.from,
            "focus.declared.fields.inherited.from",
            omitted,
          ),
        }
      : undefined,
    usage: fact.usage
      ? { inherited: fact.usage.inherited, overridden: fact.usage.overridden }
      : undefined,
  }));
}

function lanes(
  value: Lanes | undefined,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (!value) return notApplicable();
  if (value.when) omit(omitted, "focus.declared.lanes.when.equals", "privacy");
  return {
    availability: "available",
    deploy: value.deploy,
    origin: value.origin,
    local: value.local,
    cloud: value.cloud,
    dev: value.dev,
    prod: value.prod,
    derivedFrom: value.derivedFrom
      ? bounded(
          value.derivedFrom,
          12,
          "focus.declared.lanes.derivedFrom",
          omitted,
        ).map((id) => text(id, "focus.declared.lanes.derivedFrom", omitted))
      : undefined,
    when: value.when
      ? {
          resource: text(
            value.when.resource,
            "focus.declared.lanes.when.resource",
            omitted,
          ),
          dev: value.when.dev,
          prod: value.when.prod,
        }
      : undefined,
  };
}

function placement(
  value: Placement | undefined,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (!value) return notApplicable();
  return value.kind === "vpc"
    ? {
        availability: "available",
        kind: value.kind,
        networkId: text(
          value.networkId,
          "focus.declared.placement.networkId",
          omitted,
        ),
        subnet: value.subnet,
        egress: { ipv4: value.egress.ipv4, ipv6: value.egress.ipv6 },
        dualStack: value.dualStack,
      }
    : { availability: "available", kind: value.kind };
}

function compute(
  value: Compute | undefined,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (!value) return notApplicable();
  switch (value.kind) {
    case "lambda":
      return {
        availability: "available",
        kind: value.kind,
        implementation: value.implementation,
        packaging: value.packaging,
        runtime: value.runtime,
        architecture: value.architecture,
        memorySize: value.memorySize,
        timeoutSeconds: value.timeoutSeconds,
        logRetentionDays: value.logRetentionDays,
        reservedConcurrentExecutions: value.reservedConcurrentExecutions,
        provisionedConcurrentExecutions: value.provisionedConcurrentExecutions,
        subnet: value.subnet,
        localReplay: value.localReplay,
        bundling: value.bundling
          ? {
              minify: value.bundling.minify,
              sourceMap: value.bundling.sourceMap,
            }
          : undefined,
      };
    case "container":
      return {
        availability: "available",
        kind: value.kind,
        cpu: value.cpu,
        memoryMiB: value.memoryMiB,
        subnet: value.subnet,
        architecture: value.architecture,
        desiredCount: value.desiredCount,
        publicLoadBalancer: value.publicLoadBalancer,
        port: value.port,
      };
    case "workflow":
      return {
        availability: "available",
        kind: value.kind,
        type: value.type,
        timeoutSeconds: value.timeoutSeconds,
        steps: value.steps,
      };
    case "agent":
      if (value.tools.length)
        omit(
          omitted,
          "focus.declared.compute.tools",
          "relevance",
          value.tools.length,
        );
      return {
        availability: "available",
        kind: value.kind,
        auth: value.auth,
        route: value.route
          ? text(value.route, "focus.declared.compute.route", omitted)
          : undefined,
      };
  }
}

function input(
  resource: ModelResource,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (
    resource.authoredValue !== undefined ||
    resource.default !== undefined ||
    resource.values ||
    resource.modes ||
    resource.inputChoices
  )
    omit(omitted, "focus.declared.input.values", "privacy");
  const requirement = resource.inputRequirement;
  return {
    id: text(resource.id, "focus.declared.members.id", omitted),
    kind: resource.kind,
    name: text(
      resource.path.at(-1) ?? resource.id,
      "focus.declared.members.name",
      omitted,
    ),
    fromEnv: resource.fromEnv
      ? text(resource.fromEnv, "focus.declared.input.fromEnv", omitted)
      : undefined,
    absent: resource.absent,
    required: resource.required,
    inputState: resource.inputState ?? "unknown",
    requirement: requirement
      ? {
          name: text(
            requirement.name,
            "focus.declared.input.requirement.name",
            omitted,
          ),
          required: requirement.required,
          status: requirement.status,
          file: relativePath(
            requirement.file,
            "focus.declared.input.requirement.file",
            omitted,
          ),
        }
      : { status: "unknown" },
  };
}

function connection(
  edge: ModelEdge,
  omitted: SightlineOmission[],
): SightlineRecord {
  if (edge.detail || edge.evidence?.some((item) => item.excerpt))
    omit(omitted, "focus.declared.connections.detail", "privacy");
  return {
    id: text(edge.id, "focus.declared.connections.id", omitted),
    relation: edge.relation,
    from: text(edge.from, "focus.declared.connections.from", omitted),
    to: text(edge.to, "focus.declared.connections.to", omitted),
    provenance: edge.provenance,
    source: sourceLocation(
      edge.source,
      "focus.declared.connections.source",
      omitted,
    ),
    requirement: edge.inputRequirement
      ? {
          name: text(
            edge.inputRequirement.name,
            "focus.declared.connections.requirement.name",
            omitted,
          ),
          status: edge.inputRequirement.status,
          required: edge.inputRequirement.required,
        }
      : undefined,
  };
}

function schemaType(
  value: string,
  omitted: SightlineOmission[],
): SightlineValue {
  // PSL-derived type text can include defaults, SQL or callback expressions. Only
  // type identifiers and numeric parameters cross this projection boundary.
  if (
    /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*(?:\(\d+(?:,\s*\d+)*\))?(?:\[\])?$/.test(
      value,
    )
  )
    return value;
  omit(omitted, "focus.declared.columns.typeExpression", "privacy");
  return { availability: "not-loaded" };
}

function target(
  target: ModelTarget,
  model: ModeModel,
  omitted: SightlineOmission[],
  repositoryRoot: string,
): SightlineRecord {
  if (target.environment.some((entry) => entry.value.kind === "literal"))
    omit(omitted, "focus.declared.environment.literalValues", "privacy");
  if (
    target.access.length ||
    target.authorizations?.length ||
    target.permissionSources?.length
  )
    omit(omitted, "focus.declared.permissionDetails", "relevance");
  if (target.implementation?.problems.length)
    omit(
      omitted,
      "focus.declared.implementation.problemText",
      "privacy",
      target.implementation.problems.length,
    );
  return {
    kind: target.kind,
    role: target.role,
    targetId: text(target.id, "focus.declared.targetId", omitted),
    constructId: text(
      target.constructId,
      "focus.declared.constructId",
      omitted,
    ),
    constructIdPinned: target.constructIdPinned,
    directory: relativePath(
      target.directory,
      "focus.declared.directory",
      omitted,
      repositoryRoot,
    ),
    compute: compute(target.compute, omitted),
    placement: placement(target.placement, omitted),
    lanes: lanes(target.lanes, omitted),
    fields: fields(model.fields[target.ref] ?? [], omitted),
    auth: target.auth,
    userPool: target.userPool,
    environment: bounded(
      target.environment,
      16,
      "focus.declared.environment",
      omitted,
    ).map((entry) => ({
      name: text(entry.name, "focus.declared.environment.name", omitted),
      kind: entry.value.kind,
      resource:
        entry.value.kind === "reference"
          ? text(
              entry.value.resource,
              "focus.declared.environment.resource",
              omitted,
            )
          : undefined,
    })),
    secrets: bounded(target.secrets, 12, "focus.declared.secrets", omitted).map(
      (entry) => ({
        name: text(entry.name, "focus.declared.secrets.name", omitted),
        resource: text(
          entry.resource,
          "focus.declared.secrets.resource",
          omitted,
        ),
      }),
    ),
    implementation: target.implementation
      ? {
          ready: target.implementation.ready,
          problemCount: target.implementation.problems.length,
        }
      : { availability: "not-loaded" },
  };
}

type Resolved = {
  kind: SightlineFocus["kind"];
  name: string;
  present: boolean;
  declared: SightlineRecord;
  edges?: readonly ModelEdge[];
  descriptionId?: string;
};

function resolve(
  id: string,
  model: ModeModel,
  index: ModelIndex,
  inputs: SightlineInputs,
  omitted: SightlineOmission[],
): Resolved | undefined {
  const snapshot = inputs.snapshot;
  const gateway = index.gateways.get(id);
  if (gateway)
    return {
      kind: "gateway",
      name: titleOf(index, id),
      present: true,
      declared: {
        protocol: gateway.protocol,
        lanes: lanes(gateway.lanes, omitted),
        routes: bounded(
          gateway.routes,
          20,
          "focus.declared.routes",
          omitted,
        ).map((id) => text(id, "focus.declared.routes", omitted)),
        authorizer: gateway.authorizer,
        stackResource: gateway.stackResource,
      },
    };
  const workload = index.targets.get(id);
  if (workload)
    return {
      kind: "target",
      name: titleOf(index, id),
      present: true,
      declared: target(workload, model, omitted, snapshot.repositoryRoot),
    };
  const route = index.routes.get(id);
  if (route) {
    const destination = index.targets.get(route.target);
    return {
      kind: "route",
      name: titleOf(index, id),
      present: true,
      declared: {
        kind: route.kind,
        path: text(route.path, "focus.declared.path", omitted),
        browserPath: route.browserPath
          ? text(route.browserPath, "focus.declared.browserPath", omitted)
          : undefined,
        methods:
          route.methods === "*"
            ? "*"
            : route.methods
              ? bounded(
                  route.methods,
                  12,
                  "focus.declared.methods",
                  omitted,
                ).map((value) => text(value, "focus.declared.methods", omitted))
              : undefined,
        target: text(route.target, "focus.declared.target", omitted),
        auth: route.auth,
        authorizer: route.authorizer,
        lanes: lanes(destination?.lanes, omitted),
        compute: compute(destination?.compute, omitted),
        placement: placement(destination?.placement, omitted),
      },
    };
  }
  const resource = index.resources.get(id);
  if (resource) {
    const members =
      resource.kind === "group"
        ? groupEntries(resource, model.resources)
        : model.resources.filter((item) => item.parent === id);
    const ids = new Set([id, ...members.map((item) => item.id)]);
    if (
      resource.deploymentFile ||
      resource.inputSources ||
      resource.clientEnvironment
    )
      omit(omitted, "focus.declared.privateInputDetails", "privacy");
    const declared: Record<string, SightlineValue | undefined> = {
      kind: resource.kind,
      catalogPath: resource.path.map((part) =>
        text(part, "focus.declared.catalogPath", omitted),
      ),
      parent: resource.parent,
      absent: resource.absent,
      type: resource.typeText
        ? text(resource.typeText, "focus.declared.type", omitted)
        : undefined,
      memberSource: resource.memberSource,
      stackClass: resource.stackClass,
      stackUsage: resource.stackUsage
        ? {
            status: resource.stackUsage.status,
            sites: bounded(
              resource.stackUsage.sites,
              4,
              "focus.declared.stackUsage.sites",
              omitted,
            ).map((site) =>
              sourceLocation(site, "focus.declared.stackUsage.sites", omitted),
            ),
          }
        : undefined,
      input:
        resource.kind === "input" || resource.kind === "secret"
          ? input(resource, omitted)
          : undefined,
      bindingPath: resource.bindingPath?.map((part) =>
        text(part, "focus.declared.bindingPath", omitted),
      ),
      placement: resource.networkId
        ? {
            availability: "available",
            kind: "vpc",
            networkId: resource.networkId,
            subnet: resource.networkPlacement,
          }
        : notApplicable(),
      members: bounded(members, 16, "focus.declared.members", omitted).map(
        (item) => input(item, omitted),
      ),
    };
    if (resource.deploymentFile)
      declared.file = {
        path: relativePath(
          resource.deploymentFile.path,
          "focus.declared.file.path",
          omitted,
        ),
        exists: resource.deploymentFile.exists,
        entries: bounded(
          resource.deploymentFile.entries,
          20,
          "focus.declared.file.entries",
          omitted,
        ).map((entry) => ({
          name: text(entry.name, "focus.declared.file.entries.name", omitted),
          status: entry.status,
          sensitive: entry.sensitive,
        })),
      };
    if (resource.deploymentFiles)
      declared.files = {
        dev: resource.deploymentFiles.dev,
        prod: resource.deploymentFiles.prod,
      };
    if (resource.clientEnvironment)
      declared.file = {
        path: relativePath(
          resource.clientEnvironment.path,
          "focus.declared.file.path",
          omitted,
        ),
        entries: bounded(
          resource.clientEnvironment.entries,
          20,
          "focus.declared.file.entries",
          omitted,
        ).map((entry) => ({
          name: text(entry.name, "focus.declared.file.entries.name", omitted),
          required: entry.required,
          status: entry.status,
        })),
      };
    return {
      kind: "resource",
      name: titleOf(index, id),
      present: !resource.absent,
      declared,
      edges: model.edges.filter(
        (edge) => ids.has(edge.from) || ids.has(edge.to),
      ),
    };
  }
  const local = index.localServices.get(id);
  if (local)
    return {
      kind: "local-service",
      name: titleOf(index, id),
      present: local.enabled,
      declared: {
        service: text(local.service, "focus.declared.service", omitted),
        image: text(local.image, "focus.declared.image", omitted),
        enabled: local.enabled,
        source: sourceLocation(local.source, "focus.declared.source", omitted),
        running: { availability: "not-loaded" },
        databaseNetworkId: model.databaseNetworkId,
      },
    };
  const defaults = index.defaults.get(id);
  if (defaults)
    return {
      kind: "defaults",
      name: titleOf(index, id),
      present: true,
      declared: {
        group: defaults.group,
        fields: fields(model.fields[id] ?? [], omitted),
        targetCount: defaults.targets.length,
        targets: bounded(
          defaults.targets,
          12,
          "focus.declared.targets",
          omitted,
        ).map((value) => text(value, "focus.declared.targets", omitted)),
      },
    };
  const network = model.networks?.find((network) =>
    networkFixtureIds(network).includes(id),
  );
  if (network && !id.startsWith("island:"))
    return {
      kind: "network",
      name: id.slice(`prop:vpc:${network.id}:`.length),
      present: true,
      declared: networkFacts(network, omitted),
    };
  if (
    id.startsWith("island:") &&
    (network || (ISLAND_IDS as readonly string[]).includes(id))
  ) {
    const island = inputs.workspace.map?.islands.find((item) => item.id === id);
    return {
      kind: "island",
      name: island?.title ?? network?.name ?? id,
      present: true,
      declared: network
        ? networkFacts(network, omitted)
        : { availability: "not-applicable" },
      edges: island
        ? model.edges.filter((edge) =>
            island.members.some(
              (member) => member.id === edge.from || member.id === edge.to,
            ),
          )
        : [],
    };
  }
  const edge = model.edges.find((edge) => edge.id === id);
  if (edge)
    return {
      kind: "connection",
      name: edge.relation,
      present: true,
      declared: connection(edge, omitted),
      descriptionId: connectionDescriptionId(edge),
    };
  const bundle = aggregateConnections(
    model,
    Object.values(snapshot.models),
  ).find((group) => group.id === id);
  if (bundle)
    return {
      kind: "connection",
      name: bundle.edge.relation,
      present: !bundle.otherLens,
      declared: {
        from: bundle.from,
        to: bundle.to,
        memberCount: bundle.members.length,
        members: bounded(
          bundle.members,
          12,
          "focus.declared.members",
          omitted,
        ).map((member) => connection(member.edge, omitted)),
      },
    };
  const table = snapshot.schema.tables.find((item) => item.id === id);
  if (table) {
    omit(omitted, "focus.declared.schema.defaultsAndExpressions", "privacy");
    return {
      kind: "schema",
      name: table.model,
      present: true,
      declared: {
        model: table.model,
        namespace: table.namespace,
        table: table.table,
        source: sourceLocation(table.source, "focus.declared.source", omitted),
        columns: bounded(
          table.columns,
          20,
          "focus.declared.columns",
          omitted,
        ).map((column) => ({
          name: column.name,
          column: column.column,
          type: schemaType(column.type, omitted),
          nullable: column.nullable,
          primaryKey: column.primaryKey,
          unique: column.unique,
        })),
        relations: bounded(
          snapshot.schema.relations.filter(
            (item) => item.from === id || item.to === id,
          ),
          12,
          "focus.declared.relations",
          omitted,
        ).map((item) => ({
          id: item.id,
          from: item.from,
          to: item.to,
          cardinality: item.cardinality,
        })),
      },
    };
  }
  const relation = snapshot.schema.relations.find((item) => item.id === id);
  if (relation)
    return {
      kind: "schema",
      name: relation.name,
      present: true,
      declared: {
        from: relation.from,
        to: relation.to,
        fields: relation.fields.map((value) =>
          text(value, "focus.declared.fields", omitted),
        ),
        references: relation.references.map((value) =>
          text(value, "focus.declared.references", omitted),
        ),
        cardinality: relation.cardinality,
        nullable: relation.nullable,
        onDelete: relation.onDelete,
        onUpdate: relation.onUpdate,
        source: sourceLocation(
          relation.source,
          "focus.declared.source",
          omitted,
        ),
      },
    };
  return undefined;
}

export function networkFacts(
  network: NonNullable<ModeModel["networks"]>[number],
  omitted: SightlineOmission[],
): SightlineRecord {
  return {
    id: text(network.id, "networks.id", omitted),
    name: network.name
      ? text(network.name, "networks.name", omitted)
      : undefined,
    constructId: text(network.constructId, "networks.constructId", omitted),
    cidr: network.cidr,
    zones: network.zones,
    builtInProd: network.builtInProd,
    natGateway: network.natGateway,
    egressOnlyInternetGateway: network.egressOnlyInternetGateway,
    gatewayEndpoints: bounded(
      network.gatewayEndpoints,
      12,
      "networks.gatewayEndpoints",
      omitted,
    ).map((name) => text(name, "networks.gatewayEndpoints", omitted)),
    interfaceEndpoints: bounded(
      network.interfaceEndpoints,
      12,
      "networks.interfaceEndpoints",
      omitted,
    ).map((name) => text(name, "networks.interfaceEndpoints", omitted)),
    subnets: network.subnets.map((subnet) => ({
      name: subnet.name,
      egress: { ipv4: subnet.egress.ipv4, ipv6: subnet.egress.ipv6 },
    })),
  };
}

/** Compare only already allow-listed metadata. No private input or source expression is read. */
function differences(
  dev: SightlineRecord | undefined,
  prod: SightlineRecord | undefined,
  omitted: SightlineOmission[],
): readonly SightlineRecord[] {
  if (!dev || !prod) return [];
  const values: SightlineRecord[] = [];
  const walk = (
    left: SightlineValue | undefined,
    right: SightlineValue | undefined,
    path: string,
  ): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      Array.isArray(left) === Array.isArray(right)
    ) {
      const record = (
        value: SightlineValue,
      ): Record<string, SightlineValue | undefined> => {
        if (!Array.isArray(value))
          return value as Record<string, SightlineValue | undefined>;
        return Object.fromEntries(
          value.map((item, index) => [
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.id === "string"
              ? item.id
              : String(index),
            item,
          ]),
        );
      };
      const a = record(left),
        b = record(right);
      for (const key of [
        ...new Set([...Object.keys(a), ...Object.keys(b)]),
      ].sort())
        walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else if (
      (left === undefined || left === null || typeof left !== "object") &&
      (right === undefined || right === null || typeof right !== "object")
    ) {
      values.push({
        path,
        dev: left === undefined ? { availability: "not-applicable" } : left,
        prod: right === undefined ? { availability: "not-applicable" } : right,
      });
    } else
      values.push({
        path,
        dev: left === undefined ? "not-applicable" : "present",
        prod: right === undefined ? "not-applicable" : "present",
      });
  };
  walk(dev, prod, "");
  return bounded(values, 12, "focus.comparison.differences", omitted);
}

function connectionDifferences(
  dev: readonly ModelEdge[],
  prod: readonly ModelEdge[],
  omitted: SightlineOmission[],
): SightlineRecord {
  const signature = (edge: ModelEdge): SightlineRecord => ({
    id: edge.id,
    relation: edge.relation,
    from: edge.from,
    to: edge.to,
    provenance: edge.provenance,
  });
  const a = new Map(dev.map((edge) => [edge.id, signature(edge)])),
    b = new Map(prod.map((edge) => [edge.id, signature(edge)]));
  const only = (
    left: ReadonlyMap<string, SightlineRecord>,
    right: ReadonlyMap<string, SightlineRecord>,
    path: string,
  ) =>
    bounded(
      [...left]
        .filter(([id]) => !right.has(id))
        .sort(([a], [b]) => lexical(a, b)),
      6,
      path,
      omitted,
    ).map(([, edge]) => edge);
  const changed = [...a]
    .filter(
      ([id, edge]) =>
        b.has(id) && JSON.stringify(edge) !== JSON.stringify(b.get(id)),
    )
    .sort(([a], [b]) => lexical(a, b));
  return {
    devOnly: only(a, b, "focus.comparison.connections.devOnly"),
    prodOnly: only(b, a, "focus.comparison.connections.prodOnly"),
    changed: bounded(
      changed,
      6,
      "focus.comparison.connections.changed",
      omitted,
    ).map(([id, edge]) => ({ id, dev: edge, prod: b.get(id) })),
  };
}

export function buildFocus(
  inputs: SightlineInputs,
  omitted: SightlineOmission[],
): SightlineFocus | null {
  const id = inputs.selected;
  if (!id) return null;
  const model = inputs.snapshot.models[inputs.mode];
  const versions = Object.fromEntries(
    (["dev", "prod"] as const).map((mode) => [
      mode,
      resolve(
        id,
        inputs.snapshot.models[mode],
        indexModel(inputs.snapshot.models[mode]),
        inputs,
        omitted,
      ),
    ]),
  ) as Record<Mode, Resolved | undefined>;
  const current = versions[inputs.mode],
    other = versions[inputs.mode === "dev" ? "prod" : "dev"];
  const resolved = current ?? other;
  const renamedFrom = bounded(
    Object.entries(inputs.aliases)
      .filter(
        ([before, after]) =>
          before !== id && (after === id || id.startsWith(`${after}.`)),
      )
      .map(([before, after]) => before + id.slice(after.length))
      .sort(),
    4,
    "focus.renamedFrom",
    omitted,
  ).map((value) => text(value, "focus.renamedFrom", omitted));
  const otherOnly = !current?.present && !!other?.present;
  const status: SightlineFocus["status"] = !resolved
    ? "not-found"
    : otherOnly
      ? "other-mode-only"
      : model.stale
        ? "stale-model"
        : renamedFrom.length
          ? "renamed"
          : "found";
  const tags = model.tagging?.[id];
  const changed =
    current && other
      ? [
          ...new Set([
            ...Object.keys(current.declared),
            ...Object.keys(other.declared),
          ]),
        ]
          .filter(
            (key) =>
              JSON.stringify(current.declared[key]) !==
              JSON.stringify(other.declared[key]),
          )
          .sort()
      : [];
  const edgesFor = (mode: Mode) =>
    versions[mode]?.edges ??
    indexModel(inputs.snapshot.models[mode]).edges.get(id) ??
    [];
  const connectionChanges = connectionDifferences(
    edgesFor("dev"),
    edgesFor("prod"),
    omitted,
  );
  if (
    Object.values(connectionChanges).some(
      (value) => Array.isArray(value) && value.length,
    )
  )
    changed.push("connections");
  const connections =
    resolved?.edges ??
    (resolved ? (indexModel(model).edges.get(id) ?? []) : []);
  const description =
    inputs.snapshot.descriptions.values[resolved?.descriptionId ?? id];
  const island =
    resolved?.kind === "island"
      ? inputs.workspace.map?.islands.find((item) => item.id === id)
      : undefined;
  const declared = resolved
    ? Object.assign({}, resolved.declared, {
        evidence: "declared",
        source:
          resolved.declared.source ??
          (resolved.kind === "island" && !id.startsWith("island:vpc:")
            ? notApplicable()
            : sourceLocation(
                inputs.snapshot.source.entities[id]?.key ??
                  inputs.snapshot.source.catalog[id]?.stackLocation,
                "focus.declared.source",
                omitted,
              )),
        compute: resolved.declared.compute ?? notApplicable(),
        placement: resolved.declared.placement ?? notApplicable(),
        lanes: resolved.declared.lanes ?? notApplicable(),
        fields: resolved.declared.fields ?? notApplicable(),
        connections: bounded(
          connections,
          12,
          "focus.declared.connections",
          omitted,
        ).map((edge) => connection(edge, omitted)),
      })
    : undefined;
  if (declared && resolved?.kind === "island")
    Object.assign(declared, {
      localView: inputs.workspace.map
        ? {
            evidence: "local-view",
            availability: "available",
            memberCount: island?.members.length ?? 0,
            members: bounded(
              island?.members ?? [],
              20,
              "focus.declared.localView.members",
              omitted,
            ).map((member) => ({
              id: text(
                member.id,
                "focus.declared.localView.members.id",
                omitted,
              ),
              name: text(
                member.name,
                "focus.declared.localView.members.name",
                omitted,
              ),
            })),
          }
        : { evidence: "local-view", availability: "not-loaded" },
    });
  return {
    status,
    kind: resolved?.kind ?? "unknown",
    id: text(id, "focus.id", omitted, 480),
    name: text(resolved?.name ?? id, "focus.name", omitted),
    stale: !!model.stale,
    renamedFrom,
    description: description
      ? text(description, "focus.description", omitted, 900)
      : null,
    tags: tags
      ? bounded(
          Object.entries(tags.effective).sort(([a], [b]) => lexical(a, b)),
          12,
          "focus.tags",
          omitted,
        ).map(([key, value]) => ({
          key: text(key, "focus.tags.key", omitted, 80),
          value: text(value, "focus.tags.value", omitted, 160),
          provenance: tags.provenance[key]
            ? {
                entity: text(
                  tags.provenance[key]!.entity,
                  "focus.tags.provenance.entity",
                  omitted,
                ),
                kind: tags.provenance[key]!.kind,
              }
            : { kind: "unknown" },
        }))
      : [],
    declared,
    comparison: {
      dev: {
        presence: versions.dev
          ? versions.dev.present
            ? "present"
            : "absent"
          : "not-found",
      },
      prod: {
        presence: versions.prod
          ? versions.prod.present
            ? "present"
            : "absent"
          : "not-found",
      },
      changed,
      differences: differences(
        versions.dev?.declared,
        versions.prod?.declared,
        omitted,
      ),
      connections: connectionChanges,
    },
  };
}

/** Unscoped issues affect the source as a whole. Group members are relevant to group focus. */
export function relevantDiagnostics(
  snapshot: Snapshot,
  mode: Mode,
  selected?: string,
) {
  return snapshot.models[mode].diagnostics.filter(
    (item) =>
      !selected ||
      !item.entity ||
      item.entity === selected ||
      withinGroup(selected, item.entity),
  );
}
