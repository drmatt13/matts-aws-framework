import assert from "./support/assert";
import { test } from "node:test";
import { defineDatabase, defineFrameworkConfig, defineNetwork, defineResources, resource, succeed, workflow } from "@repo/framework/config";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { IDatabaseInstance } from "aws-cdk-lib/aws-rds";
import { defaults } from "../../framework-config/defaults";
import { projectModel } from "../server/model/project";
import { withAbsentTagging } from "../server/model/tags";
import { buildScene } from "../src/scene/build";
import { landscapeFocus, searchScene, tagSceneMatches } from "../src/scene/focus";
import { filterSceneByTag } from "../src/scene/tag-filter";
import { entityTagValue, tagGroups, tagKeys, UNTAGGED_FILTER } from "../src/tag-groups";

function fixture() {
  const network = defineNetwork({ id: "group-test", tags: { Team: "platform" }, cidr: "10.13.0.0/16", zones: 2 });
  const catalog = defineResources({
    storage: resource.stack<{ queue: IQueue; label: string }>({ tags: { Team: "shared", Cost: "100" }, members: { queue: { tags: { Team: "orders" } } } }),
    databaseOwner: resource.stack<{ database: IDatabaseInstance }>({ tags: { Team: "shared", Cost: "100" } }),
    input: resource.fromEnv("GROUP_TEST_INPUT", { tags: { Team: "orders" } }),
    token: resource.secret("GROUP_TEST_TOKEN", { tags: { Team: "security" } }),
    imported: resource.cdk<IQueue>({ tags: { Team: "partner" } }),
  });
  const database = defineDatabase({ id: "group-db", tags: { Team: "data" }, resource: catalog.databaseOwner.database, vpc: network, subnet: "isolated", engine: "postgres", databaseName: "group_db" });
  return projectModel(defineFrameworkConfig({ defaults, resources: catalog, networks: [network], database,
    http: [{ "/orders": { directory: "/test/fixtures/workload-handler", tags: { Team: "orders", Cost: "100" }, methods: ["GET"], environment: { QUEUE_URL: catalog.storage.queue.queueUrl } } }],
    webSocket: [], services: [],
    events: [{ processor: { directory: "/test/fixtures/processor", tags: { Team: "orders" }, localReplay: true, vpc: network, subnet: "isolated" }, untagged: { directory: "/test/fixtures/untagged" } }],
    workflows: [{ ordering: workflow(() => succeed(), { timeoutSeconds: 30, tags: { Team: "orders" } }) }],
  }), { mode: "prod", });
}

test("tag model exposes authored values, member inheritance and producer capability without resolving inputs", () => {
  const model = fixture(), facts = model.tagging!;
  assert.deepEqual(facts["lambda:workload-handler"]!.authored, { Cost: "100", Team: "orders" });
  assert.deepEqual(facts["resource:storage.queue"]!.effective, { Team: "orders", Cost: "100" });
  assert.deepEqual(facts["resource:storage.queue"]!.provenance.Cost, { entity: "resource:storage", kind: "inherited" });
  assert.deepEqual(facts["resource:storage.queue"]!.provenance.Team, { entity: "resource:storage.queue", kind: "declared" });
  assert.equal(facts["resource:input"]!.aws.kind, "logical");
  assert.equal(facts["resource:imported"]!.aws.kind, "linked");
  assert.equal(facts["route:http:/orders"]!.aws.kind, "logical");
  assert.deepEqual(facts["route:http:/orders"]!.effective, facts["lambda:workload-handler"]!.effective);
  assert.equal(facts["resource:databaseOwner.database"]!.effective.Team, "data");
  assert.equal(facts["resource:databaseOwner.database"]!.effective.Cost, "100");
  assert.equal(facts["database:group-db"]!.inherited?.values.Team, "shared", "the underlying layer stays distinct from the database override");
  assert.equal(facts["database:group-db"]!.effective.Team, "data");
  assert.deepEqual(tagKeys(model), ["Cost", "Team"]);
});

test("tag filtering spans kinds without moving or duplicating identities, topology or connection evidence", () => {
  const model = fixture(), topology = buildScene(model), scene = filterSceneByTag(topology, model, "Team", "orders");
  assert.deepEqual(scene.nodes.map(node => node.id).sort(), topology.nodes.map(node => node.id).sort());
  assert.equal(new Set(scene.nodes.map(node => node.id)).size, scene.nodes.length);
  for (const id of ["lambda:workload-handler", "route:http:/orders", "workflow:ordering", "resource:input"]) assert.equal(scene.nodes.find(node => node.id === id)?.tagFiltered, undefined, id);
  assert.equal(scene.nodes.find(node => node.id === "lambda:processor")?.island, "island:vpc:group-test");
  assert.equal(scene.nodes.find(node => node.id === "lambda:processor")?.band, "band:vpc:group-test:isolated");
  assert.deepEqual(scene.edges.map(edge => [edge.id, edge.from, edge.to, edge.members.map(member => member.edge.id)]), topology.edges.map(edge => [edge.id, edge.from, edge.to, edge.members.map(member => member.edge.id)]));
  assert.deepEqual(scene.edges.map(edge => [edge.id, edge.style]), topology.edges.map(edge => [edge.id, edge.style]), "relationship styling describes semantics independently of grouping");
  const groups = tagGroups(model, "Team"), orders = groups.find(group => group.value === "orders")!;
  assert.ok(orders.members.some(member => member.id === "lambda:processor" && member.placement === "group-test · isolated"));
  assert.ok(orders.members.some(member => member.id === "resource:storage.queue"), "hidden public fields remain discoverable");
  assert.equal(new Set(groups.flatMap(group => group.members.map(member => member.id))).size, groups.reduce((sum, group) => sum + group.members.length, 0));
  assert.equal(groups.at(-1)?.value, null);
  assert.ok(scene.nodes.find(node => node.id === "lambda:untagged")?.tagFiltered);
  assert.deepEqual(scene.nodes.map(({ tagFiltered: _filter, ...node }) => node), topology.nodes);
  assert.equal(scene.layout, topology.layout);
  assert.equal(scene.routes, topology.routes);
  assert.equal(scene.islands, topology.islands);
});

test("tag filtering preserves source presence and lanes while search and selection stay available", () => {
  const model = fixture(), scene = filterSceneByTag(buildScene(model), model, "Team", "orders");
  const filter = tagSceneMatches(scene, model, "Team", "orders");
  assert.ok(filter.nodes.has("lambda:processor"));
  assert.ok(!filter.nodes.has("lambda:untagged"));
  const search = searchScene(scene, model, "workflow")!;
  assert.deepEqual([...search.nodes], ["workflow:ordering"]);
  assert.equal(landscapeFocus(scene, "lambda:untagged", search).kind, "selection");
  assert.ok(landscapeFocus(scene, "lambda:untagged", search).nodes.has("lambda:untagged"));
  assert.equal(scene.nodes.find(node => node.id === "lambda:untagged")?.presence, "built");
  assert.equal(entityTagValue(model, "lambda:untagged", "Team"), null);
});

test("absent catalog placeholders retain declaration metadata without changing presence or present-mode values", () => {
  const present = fixture(), parent = "resource:storage";
  const absent = { ...present, mode: "dev" as const, resources: present.resources.map(resource => resource.id === parent || resource.parent === parent ? { ...resource, absent: true } : resource), tagging: Object.fromEntries(Object.entries(present.tagging!).map(([id, facts]) => [id, id === parent || id.startsWith(`${parent}.`) ? { ...facts, authored: {}, effective: {}, provenance: {} } : facts])) };
  const enriched = withAbsentTagging(absent, present);
  assert.deepEqual(enriched.tagging?.[parent], present.tagging?.[parent]);
  assert.deepEqual(enriched.tagging?.[`${parent}.queue`], present.tagging?.[`${parent}.queue`]);
  assert.ok(enriched.resources.find(resource => resource.id === parent)?.absent);
  assert.deepEqual(withAbsentTagging(present, absent).tagging?.[parent], present.tagging?.[parent], "present declarations keep their own evaluated metadata");
});

test("empty values, missing tags and long values remain exact without changing map captions", () => {
  const source = fixture(), key = "OrganizationalDomain".repeat(6), value = "a".repeat(256);
  const tagging = { ...source.tagging };
  for (const [id, text] of [["lambda:workload-handler", value], ["workflow:ordering", ""], ["resource:input", "Untagged"]]) {
    const facts = tagging[id!]!;
    tagging[id!] = { ...facts, effective: { ...facts.effective, [key]: text! } };
  }
  const model = { ...source, tagging }, topology = buildScene(model), scene = filterSceneByTag(topology, model, key, value);
  assert.equal(scene.islands, topology.islands);
  assert.equal(scene.nodes.find(node => node.id === "lambda:workload-handler")?.tagFiltered, undefined);
  const values = tagGroups(model, key).map(group => group.value);
  assert.ok(values.includes("") && values.includes("Untagged") && values.includes(null));
  const empty = buildScene({ ...source, targets: [], routes: [], resources: [], networks: [], edges: [], tagging: {} });
  assert.deepEqual(empty.nodes.map(node => node.id), ["gateway:http"], "the framework still provisions its production HTTP API without routes");
  assert.ok(Object.values(empty.bounds).every(Number.isFinite));
});

test("generated stacks without declaration metadata are exempt from Untagged", () => {
  const source = fixture(), id = "framework-stack:GeneratedStack";
  const model = { ...source, resources: [...source.resources, { id, path: ["GeneratedStack"], kind: "stack" as const, absent: false, frameworkStack: true }] };
  assert.equal(model.tagging?.[id], undefined);
  const groups = tagGroups(model, "Team"), untagged = groups.find(group => group.value === null)!;
  assert.ok(!untagged.members.some(member => member.id === id));
  assert.equal(groups.flatMap(group => group.members).filter(member => member.id === id).length, 0);
  assert.ok(filterSceneByTag(buildScene(model), model, "Team", null).nodes.find(node => node.id === id)?.tagFiltered);
});

test("Untagged exempts parameters, environment metadata and managed stacks while retaining authored resources", () => {
  const source = fixture();
  const resources: typeof source.resources = [
    ...source.resources,
    { id: "resource:plainParameter", path: ["plainParameter"], kind: "input", absent: false },
    { id: "envfile:fixture", path: ["cdk-app/.env.dev"], kind: "envFile", absent: false },
    { id: "client-envfile", path: ["Client environment"], kind: "envFile", absent: false },
    { id: "framework-stack:Generated", path: ["Generated"], kind: "stack", frameworkStack: true, absent: false },
    { id: "resource:managed", path: ["managed"], kind: "stack", frameworkManaged: "outputs", absent: false },
    { id: "resource:managed.output", path: ["managed", "output"], kind: "member", parent: "resource:managed", absent: false },
    { id: "resource:bareSecret", path: ["bareSecret"], kind: "secret", absent: false },
    { id: "resource:bareStack", path: ["bareStack"], kind: "stack", absent: false },
  ];
  const model = { ...source, resources };
  const exempt = ["resource:plainParameter", "envfile:fixture", "client-envfile", "framework-stack:Generated", "resource:managed", "resource:managed.output"];
  for (const key of [UNTAGGED_FILTER, "Team"]) {
    const ids = new Set(tagGroups(model, key).find(group => group.value === null)!.members.map(member => member.id));
    for (const id of exempt) assert.ok(!ids.has(id), `${key}: ${id} needs no application tags`);
    assert.ok(ids.has("resource:bareSecret"));
    assert.ok(ids.has("resource:bareStack"));
    assert.ok(ids.has("lambda:untagged"));
    const matches = tagSceneMatches(buildScene(model), model, key, null);
    for (const id of exempt) assert.ok(!matches.nodes.has(id), `${id} is not an untagged match`);
  }
  assert.ok(tagGroups(model, "Team").find(group => group.value === "orders")!.members.some(member => member.id === "resource:input"), "tagged parameters still participate in explicit value filters");
});

test("Untagged across all keys excludes empty-valued and inherited tags but preserves topology", () => {
  const source = fixture();
  const id = "lambda:untagged";
  const facts = source.tagging![id]!;
  const tagged = { ...source, tagging: { ...source.tagging, [id]: { ...facts, effective: { Other: "" } } } };
  assert.ok(tagGroups(tagged, "Team").find(group => group.value === null)?.members.some(member => member.id === id), "missing one key is distinct from having no tags");
  assert.ok(!tagGroups(tagged, UNTAGGED_FILTER)[0]!.members.some(member => member.id === id), "an empty-valued tag is still metadata");
  const inheritedId = "resource:storage.queue";
  const inherited = { ...source, tagging: { ...source.tagging, [inheritedId]: { ...source.tagging![inheritedId]!, authored: {}, effective: { Team: "shared" }, provenance: { Team: { entity: "resource:storage", kind: "inherited" as const } } } } };
  assert.ok(tagGroups(inherited, "Team").some(group => group.members.some(member => member.id === inheritedId)), "the inherited member is in the counted inventory");
  assert.ok(!tagGroups(inherited, UNTAGGED_FILTER)[0]!.members.some(member => member.id === inheritedId), "inherited metadata counts even without authored tags");
  assert.ok(tagGroups(source, UNTAGGED_FILTER)[0]!.members.some(member => member.id === id));
  const topology = buildScene(source), filtered = filterSceneByTag(topology, source, UNTAGGED_FILTER, null);
  assert.equal(filtered.nodes.find(node => node.id === id)?.tagFiltered, undefined);
  assert.ok(filtered.nodes.find(node => node.id === "lambda:processor")?.tagFiltered);
  assert.equal(filtered.islands, topology.islands);
  assert.equal(filtered.routes, topology.routes);
});

test("tag keys and totals include only entities available in the selected mode", () => {
  const network = defineNetwork({ id: "counts", cidr: "10.21.0.0/16", zones: 2, tags: { NetworkOnly: "yes" } });
  for (const mode of ["dev", "prod"] as const) {
    const catalog = defineResources({
      shared: resource.fromEnv("COUNT_SHARED", { tags: { area: "shared" } }),
      conditional: mode === "prod" ? resource.fromEnv("COUNT_PROD", { tags: { ProdOnly: "yes", area: "production" } }) : undefined,
    });
    const model = projectModel(defineFrameworkConfig({ defaults, resources: catalog, networks: [network],
      http: [{
        "/dev": { directory: "/count/dev-handler", methods: ["GET"], deploy: "local-only", tags: { area: "development" } },
        "/prod": { directory: "/count/prod-handler", methods: ["GET"], deploy: "cloud-only", tags: { area: "production" }, vpc: network, subnet: "isolated" },
        "/off": { directory: "/count/off-handler", methods: ["GET"], deploy: "none", tags: { DisabledOnly: "yes", area: "disabled" } },
      }],
      webSocket: [], services: [], events: [],
    }), { mode, });
    // Absence enrichment retains tags for inspection, but must not add dropdown keys or counts.
    const conditionalFacts = { authored: { ProdOnly: "yes", area: "production" }, effective: { ProdOnly: "yes", area: "production" }, provenance: {}, aws: { kind: "logical" as const, note: "Input" } };
    const enriched = { ...model, tagging: { ...model.tagging, "resource:conditional": conditionalFacts } };
    const groups = tagGroups(enriched, "area");
    const ids = groups.flatMap(group => group.members.map(member => member.id));
    assert.ok(!ids.includes("lambda:off-handler"));
    assert.ok(!ids.includes("route:http:/off"));
    assert.equal(ids.includes("lambda:dev-handler"), mode === "dev");
    assert.equal(ids.includes("route:http:/dev"), mode === "dev");
    assert.equal(ids.includes("lambda:prod-handler"), mode === "prod");
    assert.equal(ids.includes("route:http:/prod"), mode === "prod");
    assert.equal(ids.includes("resource:conditional"), mode === "prod");
    assert.equal(ids.includes("island:vpc:counts"), mode === "prod");
    assert.equal(groups.find(group => group.value === "development")?.members.length ?? 0, mode === "dev" ? 2 : 0);
    assert.equal(groups.find(group => group.value === "production")?.members.length ?? 0, mode === "prod" ? 3 : 0);
    assert.deepEqual(tagKeys(enriched), mode === "dev" ? ["area"] : ["NetworkOnly", "ProdOnly", "area"]);
  }
});

test("enabled local services count with their database tags while unused VPCs do not", () => {
  const source = fixture();
  const local = { id: "local:postgres", title: "Local PostgreSQL", enabled: true, service: "postgres", image: "postgres:16", volumes: [], source: { file: "docker-compose.yml", line: 1, column: 1, start: 0, end: 1 } };
  const model = { ...source, mode: "dev" as const, localServices: [local], networks: source.networks?.map(network => ({ ...network, builtInProd: false })) };
  assert.ok(tagGroups(model, "Team").find(group => group.value === "data")?.members.some(member => member.id === local.id));
  assert.ok(!tagGroups(model, "Team").flatMap(group => group.members).some(member => member.kind === "VPC"));
  const production = { ...model, mode: "prod" as const, localServices: [{ ...local, enabled: false }] };
  assert.ok(!tagGroups(production, "Team").flatMap(group => group.members).some(member => member.id === local.id || member.kind === "VPC"));
});
