import assert from "./support/assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { ModelResource } from "../shared/model";
import {
  snapshot as browserSnapshot,
  location,
  NOW,
} from "./browser/support/scenarios";
import { aggregateConnections } from "../src/connections";
import {
  buildSightline,
  SIGHTLINE_CHARACTER_BUDGET,
} from "../src/sightline/build";
import type { SightlineInputs } from "../src/sightline/types";
import {
  sightlineContributorKinds,
  sightlineWorkspacePaths,
} from "../src/sightline/workspace";
import { omit } from "../src/sightline/safe";

const paths = [
  "/",
  "/database",
  "/deploy",
  "/cognito",
  "/cognito/user-pools",
  "/cognito/identity-pools",
  "/cognito/providers",
  "/cognito/permissions",
  "/domains",
  "/websockets",
  "/graphql",
  "/test",
];

function fixture() {
  const markers: string[] = [];
  const privateValue = (field: string) => {
    const value = `SIGHTLINE_PRIVATE_${markers.length}_${field}`;
    markers.push(value);
    return value;
  };
  const snapshot = structuredClone(browserSnapshot().snapshot);
  Object.assign(snapshot, {
    repositoryRoot: `/Users/${privateValue("home")}/repo`,
    databaseProblems: [privateValue("databaseProblem")],
    credentials: privateValue("unknownSnapshotField"),
  });
  Object.assign(snapshot.source, {
    problems: [privateValue("sourceProblem")],
    editability: {
      "lambda:fixture-0": {
        secret: { kind: "literal", text: privateValue("sourceLiteral") },
      },
    },
  });
  Object.assign(snapshot.source.cdkLinks, {
    notes: [privateValue("indexNotes")],
    manualWiring: [
      {
        resource: "resource:langgraph",
        source: location,
        reason: privateValue("manualWiring"),
      },
    ],
  });
  Object.assign(snapshot.schema.tables[0]!.columns[0]!, {
    default: privateValue("schemaDefault"),
  });
  Object.assign(snapshot.schema.tables[0]!.columns[1]!, {
    type: `temporal.timestamp(onCreate: sql("${privateValue("schemaTypeSql")}"))`,
  });
  Object.assign(snapshot.schema.tables[0]!, {
    indexes: [
      {
        kind: "index",
        fields: ["id"],
        declaration: privateValue("schemaDeclaration"),
        predicate: privateValue("schemaPredicate"),
        source: location,
      },
    ],
  });
  Object.assign(snapshot.schema, {
    relations: [
      {
        id: "schema-relation:Note",
        name: "notes",
        from: "schema:public.Note",
        to: "schema:public.Note",
        fields: ["id"],
        references: ["id"],
        cardinality: "N:1",
        nullable: false,
        onDelete: "Cascade",
        onUpdate: "Cascade",
        source: location,
      },
    ],
  });
  Object.assign(snapshot.descriptions.values, {
    "resource:langgraph": "Language model settings used by the example agent.",
    "lambda:fixture-0": "Runs the fixture handler.",
  });
  for (const mode of ["dev", "prod"] as const) {
    const model = snapshot.models[mode];
    const target = model.targets[0]!;
    Object.assign(target, {
      directory: "cdk-app/lambda_functions/http_functions/fixture",
      environment: [
        {
          name: "INLINE",
          value: {
            kind: "literal",
            value: privateValue(`${mode}LiteralEnvironment`),
          },
        },
        {
          name: "MODEL",
          value: {
            kind: "reference",
            resource: "langgraph.model",
            display: privateValue(`${mode}EnvironmentDisplay`),
          },
        },
      ],
      secrets: [
        {
          name: "KEY",
          resource: "openaiApiKey",
          display: privateValue(`${mode}SecretDisplay`),
        },
      ],
      access: [
        {
          actions: [privateValue(`${mode}IamActions`)],
          resources: [privateValue(`${mode}Arn`)],
        },
      ],
      implementation: {
        ready: false,
        problems: [privateValue(`${mode}ImplementationProblem`)],
      },
      lanes: {
        deploy: "both",
        origin: "declared",
        local: true,
        cloud: true,
        dev: true,
        prod: true,
        when: {
          resource: "enableFeature",
          equals: privateValue(`${mode}Comparison`),
          dev: "holds",
          prod: "fails",
        },
      },
      credential: privateValue(`${mode}FutureTargetField`),
    });
    Object.assign(model, {
      defaults: [
        {
          ref: "defaults:lambda",
          title: "Lambdas",
          group: "lambda",
          origin: "defaults",
          targets: [target.ref],
        },
      ],
      localServices: [
        {
          id: "local:postgres",
          service: "postgres",
          title: "Local PostgreSQL",
          image: "postgres:17",
          volumes: [privateValue(`${mode}HostVolume`)],
          enabled: mode === "dev",
          source: location,
        },
      ],
      networks: [
        {
          id: "app",
          name: "Application",
          constructId: "AppVpc",
          cidr: "10.0.0.0/16",
          zones: 2,
          egressOnlyInternetGateway: true,
          natGateway: false,
          gatewayEndpoints: ["s3"],
          interfaceEndpoints: [],
          builtInProd: true,
          monthlyCost: { natGateway: 0, interfaceEndpoints: 0 },
          subnets: [{ name: "private", egress: { ipv4: false, ipv6: true } }],
        },
      ],
      tagging: {
        [target.ref]: {
          authored: { team: "example" },
          effective: { team: "example" },
          provenance: { team: { entity: target.ref, kind: "declared" } },
          aws: { kind: "owned", note: privateValue(`${mode}TagNote`) },
        },
      },
      diagnostics: [
        {
          severity: "error",
          stage: "validate",
          entity: target.ref,
          message: privateValue(`${mode}Diagnostic`),
        },
      ],
    });
    Object.assign(model.fields, {
      "defaults:lambda": [
        {
          field: "defaults.lambda.memorySize",
          label: "Memory",
          path: ["lambda", "memorySize"],
          domain: { kind: "number", min: 128, max: 10240, unit: "MB" },
          effective: 256,
          provenance: "defaults.lambda.memorySize",
          usage: { inherited: 3, overridden: 1 },
        },
      ],
    });
    (model.fields[target.ref] as unknown[]).push({
      field: "environment.API_KEY",
      effective: privateValue(`${mode}UnknownEffectiveField`),
      authored: privateValue(`${mode}UnknownAuthoredField`),
      inherited: { value: privateValue(`${mode}UnknownInheritedField`) },
    });
    const group: ModelResource = {
      id: "resource:langgraph",
      kind: "group",
      path: ["langgraph"],
      absent: false,
    };
    const input: ModelResource = {
      id: "resource:langgraph.model",
      kind: "input",
      path: ["langgraph", "model"],
      parent: group.id,
      absent: false,
      fromEnv: "MODEL_ID",
      required: true,
      inputState: "missing",
      inputRequirement: {
        name: "MODEL_ID",
        mode,
        file: `cdk-app/.env.${mode}`,
        required: true,
        status: "missing",
        resource: "resource:langgraph.model",
        reasons: [privateValue(`${mode}PrivateRequirement`)],
      },
      authoredValue: privateValue(`${mode}AuthoredInput`),
      default: privateValue(`${mode}InputDefault`),
      values: [privateValue(`${mode}Choices`)],
      modes: {
        dev: {
          present: true,
          required: true,
          value: privateValue(`${mode}DevInputValue`),
          default: privateValue(`${mode}DevInputDefault`),
        },
        prod: {
          present: true,
          required: true,
          value: privateValue(`${mode}ProdInputValue`),
          default: privateValue(`${mode}ProdInputDefault`),
        },
      },
      inputChoices: {
        source: location,
        defaults: [privateValue(`${mode}InputChoices`)],
      },
    };
    const secret: ModelResource = {
      id: "resource:key",
      kind: "secret",
      path: ["key"],
      fromEnv: "API_KEY",
      absent: false,
      bindingPath: ["key"],
    };
    const file = {
      id: "envfile:dev",
      kind: "envFile",
      path: ["env", "dev"],
      absent: false,
      deploymentFile: {
        mode,
        path: `cdk-app/.env.${mode}`,
        template: `cdk-app/.env.${mode}.template`,
        exists: true,
        problem: privateValue(`${mode}FileProblem`),
        setupProblem: privateValue(`${mode}SetupProblem`),
        entries: [
          {
            name: "API_KEY",
            status: "configured",
            counterpart: "configured",
            sensitive: true,
            defaulted: false,
            targets: [secret.id],
            default: privateValue(`${mode}EntryDefault`),
            choices: [privateValue(`${mode}EntryChoices`)],
            note: privateValue(`${mode}EntryNote`),
            value: privateValue(`${mode}SecretValue`),
          },
        ],
      },
      inputSources: [
        {
          file: "cdk-app/.env.dev",
          entry: {
            name: "API_KEY",
            value: privateValue(`${mode}PrivateInputDetails`),
          },
        },
      ],
    } as unknown as ModelResource;
    const client = {
      id: "client-envfile",
      kind: "envFile",
      path: ["client"],
      absent: false,
      clientEnvironment: {
        mode,
        path: "client-app/.env.development.local",
        inputs: privateValue(`${mode}ClientInputs`),
        mappings: { TOKEN: privateValue(`${mode}ClientMappings`) },
        options: [{ value: privateValue(`${mode}ClientOptions`) }],
        entries: [
          {
            name: "PUBLIC_URL",
            required: true,
            status: "mapped",
            expression: privateValue(`${mode}ClientExpression`),
            note: privateValue(`${mode}ClientNote`),
            sources: [{ label: privateValue(`${mode}ClientSourceLabel`) }],
          },
        ],
      },
    } as unknown as ModelResource;
    (model.resources as ModelResource[]).push(
      group,
      input,
      secret,
      file,
      client,
      {
        id: "resource:prodOnly",
        kind: "input",
        path: ["prodOnly"],
        absent: mode === "dev",
      },
    );
    (model.edges as unknown[]).push({
      id: "env:group-reader",
      relation: "env",
      from: target.ref,
      to: input.id,
      label: "MODEL_ID",
      provenance: "declared",
      detail: privateValue(`${mode}EdgeDetail`),
      evidence: [
        {
          role: "wired",
          location,
          excerpt: privateValue(`${mode}SourceExcerpt`),
        },
      ],
    });
    (model.edges as unknown[]).push({
      id: "env:group-reader-2",
      relation: "env",
      from: target.ref,
      to: input.id,
      label: "MODEL_ID_2",
      provenance: "declared",
    });
  }
  const inputs: SightlineInputs = {
    capturedAt: NOW,
    pathname: "/",
    snapshot,
    mode: "dev",
    selected: undefined,
    source: {
      latestRevision: snapshot.revision,
      evaluating: false,
      dirty: false,
      conflicted: false,
      connected: true,
    },
    aliases: {},
    workspace: {
      map: {
        search: "example",
        resourceKind: "all",
        categories: ["routes", "interactions"],
        errorsShown: true,
        tagFilter: { key: "", value: null },
        view: "resources",
        islands: [
          {
            id: "island:lambda",
            title: "Serverless compute",
            members: [{ id: "lambda:fixture-0", name: "Fixture handler 0" }],
          },
        ],
      },
      database: {
        availability: "available",
        tab: "schema",
        editorMode: "split",
        selection: { table: "schema:public.Note" },
        dirty: true,
        conflicted: false,
        validation: {
          availability: "available",
          current: true,
          valid: false,
          diagnostics: [{ code: "parse", severity: "error", from: 0, to: 1 }],
        },
        diagramRetained: true,
        revision: "schema-revision",
        file: snapshot.schema.file,
      },
      databaseHistory: {
        availability: "available",
        selectedId: "001",
        selected: {
          id: "001",
          name: "Add notes",
          from: null,
          to: "notes",
          integrity: "valid",
        },
      },
      databaseTarget: {
        availability: "available",
        targetId: "local",
        inspecting: false,
        reviewing: false,
        applying: false,
      },
      databaseSql: { targetId: "local", busy: false, reviewOpen: false },
      deploy: {
        availability: "available",
        target: { name: "example-dev", mode: "dev", region: "us-east-1" },
        reviewKey: "plan-1",
        findings: {
          availability: "available",
          entries: [
            { code: "unverified", severity: "warning", scope: "deployment" },
          ],
        },
        running: [{ id: "job-1", kind: "framework-check", status: "running" }],
      },
      cognito: {
        subsection: "providers",
        destination: { deployment: "example-dev", region: "us-east-1" },
        source: {
          availability: "available",
          declaredPoolIds: ["resource:cognito.pool"],
          providers: [
            { id: "google", name: "Google", type: "OIDC", scope: "declared" },
          ],
        },
        observed: { availability: "not-loaded", stale: false },
      },
      domains: {
        destination: { deployment: "example-prod", region: "us-east-1" },
        source: {
          mode: "prod",
          availability: "available",
          inputs: [{ name: "FRONTEND_DOMAIN", present: true, modified: false }],
          diagnostics: [{ code: "missing-certificate", severity: "warning" }],
        },
        observed: { availability: "not-loaded", stale: false },
      },
      websockets: { availability: "available" },
      websocketLocal: {
        connection: "connected",
        configured: true,
        valid: true,
      },
      websocketAws: {
        connection: "disconnected",
        configured: false,
        valid: false,
      },
    },
    deployments: {
      dev: {
        availability: "available",
        target: { name: "example-dev", mode: "dev", region: "us-east-1" },
        observed: {
          availability: "available",
          observedAt: NOW,
          updatedAt: NOW,
          stale: true,
          state: "ready",
          stackCount: 4,
        },
      },
      prod: {
        availability: "missing-profile",
        observed: { availability: "not-loaded" },
      },
    },
    activity: {
      availability: "available",
      updatedAt: NOW,
      jobs: [
        {
          id: "job-1",
          kind: "framework-check",
          title: privateValue("jobTitle"),
          params: { token: privateValue("jobParams") },
          status: "running",
          startedAt: NOW,
          lastSeq: 1,
          summary: privateValue("jobSummary"),
          recovery: privateValue("jobRecovery"),
          observationProblem: privateValue("jobProblem"),
        },
      ],
    },
  };
  Object.assign(inputs, {
    studioToken: privateValue("studioToken"),
    awsCredentials: privateValue("credentials"),
  });
  for (const [key, fragment] of Object.entries(inputs.workspace))
    if (fragment)
      Object.assign(fragment, {
        queryResults: privateValue(`${key}QueryResults`),
        sql: privateValue(`${key}Sql`),
        userRecords: privateValue(`${key}Users`),
        payload: privateValue(`${key}Payload`),
        sessionToken: privateValue(`${key}SessionToken`),
        secretValues: privateValue(`${key}SecretValues`),
        logText: privateValue(`${key}Logs`),
      });
  Object.assign(inputs.workspace.database!, {
    source: privateValue("prismaSource"),
    error: privateValue("databaseError"),
  });
  Object.assign(inputs.workspace.domains!.source.inputs![0]!, {
    value: privateValue("domainEnvValue"),
  });
  Object.assign(inputs.workspace.websocketLocal!, {
    wsUrl: privateValue("socketUrl"),
    messages: [privateValue("socketMessage")],
  });
  Object.assign(inputs.deployments.dev, {
    account: privateValue("awsAccount"),
    arn: privateValue("deploymentArn"),
    credentials: privateValue("deploymentCredentials"),
    error: privateValue("deploymentError"),
  });
  return { inputs, markers };
}

const selectionIds = [
  undefined,
  "gateway:http",
  "lambda:fixture-0",
  "route:http:/fixture/0",
  "resource:fixture0",
  "resource:langgraph",
  "resource:langgraph.model",
  "resource:key",
  "resource:prodOnly",
  "envfile:dev",
  "client-envfile",
  "local:postgres",
  "island:lambda",
  "island:vpc:app",
  "prop:vpc:app:internet-gateway",
  "defaults:lambda",
  "env:group-reader",
  "schema:public.Note",
  "schema-relation:Note",
  "unknown:entity",
];

test("Sightline covers every workspace with an exhaustive contributor and the actual route list", () => {
  assert.deepEqual(
    [...sightlineContributorKinds].sort(),
    [...new Set(Object.values(sightlineWorkspacePaths))].sort(),
  );
  const main = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8",
  );
  const authoredPaths = [...main.matchAll(/path:\s*["'](\/[^"']*)["']/g)]
    .map((match) => match[1]!)
    .filter(
      (path) => !["/isometric", "/identity", "/identity-pools"].includes(path),
    );
  for (const path of authoredPaths)
    assert.ok(
      path in sightlineWorkspacePaths || path.startsWith("/cognito/"),
      `Missing contributor for ${path}`,
    );
  for (const pathname of paths) {
    const { inputs } = fixture();
    const result = buildSightline({ ...inputs, pathname });
    assert.equal(result.location.pathname, pathname);
    assert.equal(result.workspace.kind, result.location.workspace);
    assert.ok(
      result.deployments.dev && result.deployments.prod && result.activity,
    );
    if (pathname === "/graphql")
      assert.equal(
        (result.workspace as { status: string }).status,
        "placeholder",
      );
  }
});

test("Sightline resolves every selectable kind, bounded group consumers, schema metadata and connection bundles", () => {
  const { inputs } = fixture();
  for (const selected of selectionIds.filter(
    (id) => id && !id.startsWith("unknown:"),
  )) {
    const result = buildSightline({ ...inputs, selected });
    assert.notEqual(result.focus?.status, "not-found", selected);
    assert.notEqual(result.focus?.kind, "unknown", selected);
  }
  const group = buildSightline({
    ...inputs,
    selected: "resource:langgraph",
  }).focus!;
  assert.equal(group.kind, "resource");
  assert.match(JSON.stringify(group.declared), /MODEL_ID/);
  assert.match(JSON.stringify(group.declared), /env:group-reader/);
  assert.match(JSON.stringify(group.declared), /lambda:fixture-0/);
  const bundle = aggregateConnections(
    inputs.snapshot.models.dev,
    Object.values(inputs.snapshot.models),
  ).find((item) => item.members.length > 1)!;
  assert.ok(bundle);
  assert.equal(
    buildSightline({ ...inputs, selected: bundle.id }).focus?.kind,
    "connection",
  );
  const schema = buildSightline({
    ...inputs,
    selected: "schema:public.Note",
  }).focus!;
  assert.match(JSON.stringify(schema), /primaryKey/);
  assert.match(JSON.stringify(schema), /schema-relation:Note/);
});

test("Sightline preserves explicit no-selection, missing, other-mode, stale and renamed focus states", () => {
  const { inputs } = fixture();
  assert.equal(buildSightline(inputs).focus, null);
  assert.equal(
    buildSightline({ ...inputs, selected: "unknown:entity" }).focus?.status,
    "not-found",
  );
  assert.equal(
    buildSightline({ ...inputs, selected: "resource:prodOnly" }).focus?.status,
    "other-mode-only",
  );
  const renamed = buildSightline({
    ...inputs,
    selected: "resource:langgraph",
    aliases: { "resource:old": "resource:langgraph" },
  }).focus!;
  assert.equal(renamed.status, "renamed");
  assert.deepEqual(renamed.renamedFrom, ["resource:old"]);
  Object.assign(inputs.snapshot.models.dev, { stale: true });
  const stale = buildSightline({
    ...inputs,
    selected: "resource:langgraph",
    aliases: { "resource:old": "resource:langgraph" },
    source: {
      ...inputs.source,
      dirty: true,
      conflicted: true,
      latestRevision: "new-source",
    },
  });
  assert.equal(stale.focus?.status, "stale-model");
  assert.deepEqual(stale.focus?.renamedFrom, ["resource:old"]);
  assert.equal(stale.source.revision, "browser-revision");
  assert.equal(stale.source.latestRevision, "new-source");
  assert.deepEqual(stale.source.draft, { dirty: true, conflicted: true });
});

test("Sightline is deterministic and does not mutate frozen caller data", () => {
  const { inputs } = fixture();
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  };
  freeze(inputs);
  for (const selected of selectionIds)
    assert.deepEqual(
      buildSightline({ ...inputs, selected }),
      buildSightline({ ...inputs, selected }),
    );
});

test("Sightline canaries never escape any workspace or selection, including nested private fields and future response fields", () => {
  const { inputs, markers } = fixture();
  assert.ok(
    markers.length > 150,
    "The fixture must cover all sensitive surfaces, not a single representative secret.",
  );
  for (const pathname of paths)
    for (const selected of selectionIds)
      for (const mode of ["dev", "prod"] as const) {
        const result = buildSightline({ ...inputs, pathname, selected, mode });
        const json = JSON.stringify(result);
        for (const marker of markers)
          assert.equal(
            json.includes(marker),
            false,
            `${pathname} ${selected ?? "overview"} ${mode}: ${marker}`,
          );
        assert.ok(json.length <= SIGHTLINE_CHARACTER_BUDGET);
        assert.ok(result.omitted.some((item) => item.reason === "privacy"));
      }
});

test("Sightline keeps cache loading, errors, unavailable observations and known empty activity distinct", () => {
  const { inputs } = fixture();
  for (const availability of [
    "not-loaded",
    "loading",
    "error",
    "available",
  ] as const) {
    const result = buildSightline({
      ...inputs,
      activity: { availability },
      deployments: {
        dev: { availability: "catalog-error", observed: { availability } },
        prod: inputs.deployments.prod,
      },
    });
    assert.equal(result.activity.availability, availability);
    assert.equal(result.activity.running, null);
    assert.equal(
      (result.deployments.dev.observed as { availability: string })
        .availability,
      availability,
    );
  }
  assert.deepEqual(
    buildSightline({
      ...inputs,
      activity: { availability: "available", jobs: [] },
    }).activity.running,
    [],
  );
  const island = buildSightline({
    ...inputs,
    pathname: "/deploy",
    selected: "island:lambda",
    workspace: {},
  }).focus!;
  assert.equal(
    (island.declared!.localView as { availability: string }).availability,
    "not-loaded",
  );
});

test("Sightline enforces the exact compact character budget and records deliberate cuts", () => {
  const { inputs } = fixture();
  const long = "repository-data-".repeat(150);
  const target = inputs.snapshot.models.dev.targets[0]!;
  Object.assign(target, {
    environment: Array.from({ length: 80 }, (_, index) => ({
      name: `NAME_${index}_${long}`,
      value: {
        kind: "reference",
        resource: `catalog.${index}.${long}`,
        display: "unused",
      },
    })),
  });
  Object.assign(inputs.snapshot.descriptions.values, {
    [target.ref]: long.repeat(5),
  });
  Object.assign(
    inputs.snapshot.models.dev.tagging![target.ref]!.effective,
    Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`tag${index}`, long]),
    ),
  );
  const result = buildSightline({ ...inputs, selected: target.ref });
  const json = JSON.stringify(result);
  assert.ok(
    json.length <= SIGHTLINE_CHARACTER_BUDGET,
    `${json.length} characters`,
  );
  assert.equal(result.focus?.id, target.ref);
  assert.ok(
    result.source &&
      result.deployments.dev &&
      result.deployments.prod &&
      result.activity &&
      result.issues,
  );
  assert.ok(
    result.omitted.some(
      (item) =>
        item.reason === "budget" && item.path === "focus.declared.environment",
    ),
  );
});

test("Sightline strips home paths and account/ARN identifiers even in nominal display metadata", () => {
  const { inputs } = fixture();
  Object.assign(inputs.snapshot.descriptions.values, {
    "lambda:fixture-0":
      "Read /Users/alice/private.txt or /home/bob/secret.txt; arn:aws:iam::123456789012:role/private and account 123456789012",
  });
  Object.assign(inputs.snapshot.source.entities["lambda:fixture-0"]!.key, {
    file: "/Users/alice/repo/secret.ts",
  });
  const result = buildSightline({ ...inputs, selected: "lambda:fixture-0" });
  const json = JSON.stringify(result);
  for (const forbidden of ["/Users/", "/home/", "123456789012", "arn:aws:"])
    assert.equal(json.includes(forbidden), false);
  assert.ok(
    result.omitted.some(
      (item) =>
        item.path === "focus.declared.source.file" && item.reason === "privacy",
    ),
  );
});

test("Sightline explains safe Dev/Prod differences and normalizes implementation paths inside the repository", () => {
  const { inputs } = fixture();
  const dev = inputs.snapshot.models.dev.targets[0]!,
    prod = inputs.snapshot.models.prod.targets[0]!;
  Object.assign(dev, {
    directory: `${inputs.snapshot.repositoryRoot}/handlers/example`,
  });
  Object.assign(prod.compute, { memorySize: 1024 });
  const result = buildSightline({ ...inputs, selected: dev.ref });
  assert.equal(result.focus!.declared!.directory, "handlers/example");
  const differences = (
    result.focus!.comparison as {
      differences: { path: string; dev: unknown; prod: unknown }[];
    }
  ).differences;
  assert.ok(
    differences.some(
      (item) =>
        item.path === "compute.memorySize" &&
        item.dev === 256 &&
        item.prod === 1024,
    ),
  );
  assert.equal(
    JSON.stringify(result).includes(inputs.snapshot.repositoryRoot),
    false,
  );
  const resource = buildSightline({
    ...inputs,
    selected: "resource:langgraph",
  });
  assert.deepEqual(resource.focus!.declared!.compute, {
    availability: "not-applicable",
  });
  assert.deepEqual(resource.focus!.declared!.lanes, {
    availability: "not-applicable",
  });
});

test("Sightline retains supplied observation freshness without substituting capture time", () => {
  const { inputs } = fixture();
  const observedAt = "2026-10-27T12:00:00.000Z",
    freshUntil = "2026-10-28T12:00:20.000Z";
  Object.assign(inputs.deployments.dev.observed, { observedAt, freshUntil });
  const result = buildSightline(inputs);
  assert.equal(
    (result.deployments.dev.observed as { observedAt: string }).observedAt,
    observedAt,
  );
  assert.equal(
    (result.deployments.dev.observed as { freshUntil: string }).freshUntil,
    freshUntil,
  );
  assert.notEqual(result.capturedAt, observedAt);
});

test("Sightline omission counts aggregate partial cuts and collection wildcard paths", () => {
  const omitted: Parameters<typeof omit>[0] = [];
  omit(omitted, "focus.members[0].name", "budget", 4);
  omit(omitted, "focus.members[1].name", "budget", 5);
  omit(omitted, "focus.members.2.name", "budget", 6);
  assert.deepEqual(omitted, [
    { path: "focus.members[].name", reason: "budget", count: 15 },
  ]);
});

test("Sightline compares relationship peers across modes and excludes schema type expressions", () => {
  const { inputs } = fixture();
  const prod = inputs.snapshot.models.prod;
  Object.assign(prod, {
    edges: [
      ...prod.edges,
      {
        id: "database:prod",
        relation: "database",
        from: "lambda:fixture-0",
        to: "resource:rds.database",
        provenance: "derived",
        label: "Database",
      },
    ],
  });
  const target = buildSightline({
    ...inputs,
    selected: "lambda:fixture-0",
  }).focus!;
  const comparison = target.comparison as {
    changed: string[];
    connections: {
      prodOnly: { to: string; relation: string; provenance: string }[];
    };
  };
  assert.ok(comparison.changed.includes("connections"));
  assert.ok(
    comparison.connections.prodOnly.some(
      (edge) =>
        edge.to === "resource:rds.database" &&
        edge.relation === "database" &&
        edge.provenance === "derived",
    ),
  );
  const schema = buildSightline({ ...inputs, selected: "schema:public.Note" });
  const columns = schema.focus!.declared!.columns as { type: unknown }[];
  assert.equal(columns[0]!.type, "String");
  assert.deepEqual(columns[1]!.type, { availability: "not-loaded" });
  assert.ok(
    schema.omitted.some(
      (item) =>
        item.path === "focus.declared.columns.typeExpression" &&
        item.reason === "privacy",
    ),
  );
});
