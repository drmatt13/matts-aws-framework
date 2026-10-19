import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig, defineResources, type FrameworkConfig } from "../src/config";
import {
  assertLocalServiceContainers,
  composeServicesFile,
  parseCompose,
  type ComposeModel,
} from "../scripts/compose-services";
import { defaults } from "../../../framework-config/defaults";

interface ServiceSource {
  readonly dev?: false;
  readonly dockerfile?: string;
}

/** A repository with one directory per service, each a workspace with a dev script unless told otherwise. */
function repository(
  sources: Record<string, ServiceSource>,
  workspaces: readonly string[] = ["cdk-app/ecs_containers/services/*"],
): { readonly repositoryRoot: string; readonly dispose: () => void } {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "compose-services-"));
  mkdirSync(path.join(repositoryRoot, "cdk-app", "lambda_functions"), { recursive: true });
  writeFileSync(path.join(repositoryRoot, "framework.config.ts"), "export default {};\n");
  writeFileSync(path.join(repositoryRoot, "package.json"), JSON.stringify({ workspaces }));
  for (const [id, source] of Object.entries(sources)) {
    const directory = path.join(repositoryRoot, "cdk-app", "ecs_containers", "services", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `@repo/${id}`, scripts: source.dev === false ? { start: "node dist/index.js" } : { dev: "node --watch src/index.ts" } }),
    );
    if (source.dockerfile) writeFileSync(path.join(directory, "Dockerfile"), source.dockerfile);
  }
  return { repositoryRoot, dispose: () => rmSync(repositoryRoot, { recursive: true, force: true }) };
}

/** Four services, one per deploy setting; two of them run locally. */
function config(services: Record<string, Record<string, unknown>> = {}): FrameworkConfig {
  return defineFrameworkConfig({
    resources: defineResources({}),
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [{
      "/orders/*": { directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000, healthCheckPath: "/health", deploy: "local-only" },
      "/billing/*": { directory: "/ecs_containers/services/billing", methods: "*", deploy: "both" },
      "/reports/*": { directory: "/ecs_containers/services/reports", methods: ["GET"], port: 8100, deploy: "cloud-only" },
      "/archive/*": { directory: "/ecs_containers/services/archive", methods: ["GET"], port: 8200, deploy: "none" },
      ...services,
    }],
  } as never);
}

const SOURCES = { orders: {}, billing: { dockerfile: "FROM node:24\nEXPOSE 7000\n" }, reports: {}, archive: {} };

const TEMPLATE = `
x-mounts: &mounts
  - { type: bind, source: ./.framework/local, target: /workspace/.framework/local, read_only: true }
  - { type: bind, source: ./cdk-app/.env.dev, target: /workspace/cdk-app/.env.dev, read_only: true }
x-framework-service:
  build: { context: ., dockerfile: Dockerfile.dev }
  init: true
  environment: [AWS_REGION=us-east-1, AWS_PROFILE]
  volumes: *mounts
  depends_on: { postgres: { condition: service_healthy } }
  healthcheck: { interval: 30s, start_interval: 1s }
`;
const authored = (yaml: string): ComposeModel => parseCompose(yaml);
const INCLUDED = `include:\n  - docker-compose.services.yml\n${TEMPLATE}services:\n  postgres: { image: "postgres:16" }\n`;
const LAUNCH = ["node", "--import", "tsx", "packages/framework/scripts/run-service.ts"];

test("each service that runs locally gets a container: x-framework-service plus what its declaration decides", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const compose = authored(INCLUDED);
    const text = composeServicesFile(config(), compose, { repositoryRoot })!;
    const services = parseCompose(text).services!;
    // Neither the cloud-only nor the undeployed service runs here.
    assert.deepEqual(Object.keys(services), ["orders", "billing"]);

    const orders = services.orders!;
    assert.deepEqual(orders.command, [...LAUNCH, "orders", "--", "npm", "--workspace", "@repo/orders", "run", "dev"]);
    // The template as written, its environment in either spelling, plus PORT.
    assert.deepEqual(orders.build, { context: ".", dockerfile: "Dockerfile.dev" });
    assert.deepEqual(orders.depends_on, { postgres: { condition: "service_healthy" } });
    assert.deepEqual(orders.environment, { AWS_REGION: "us-east-1", AWS_PROFILE: null, PORT: "8000" });
    assert.deepEqual(orders.healthcheck, {
      test: ["CMD", "node", "-e", "require('node:http').get('http://127.0.0.1:8000/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"],
      interval: "30s",
      start_interval: "1s",
    });

    // No port declared: the Dockerfile's one EXPOSE, and the file says so.
    // No healthCheckPath: the template's timing alone is not a probe.
    assert.equal((services.billing!.environment as Record<string, string>).PORT, "7000");
    assert.equal(services.billing!.healthcheck, undefined);
    assert.match(text, /# services\["\/billing\/\*"\]: listens on 7000 \(its EXPOSE in cdk-app\/ecs_containers\/services\/billing\/Dockerfile\),/);
    assert.match(text, /# services\["\/orders\/\*"\]: listens on 8000 \(its port\),\n    # runs the dev script of @repo\/orders, probed at its healthCheckPath \/health\./);

    // The same inputs give the same bytes, and they satisfy the container check.
    assert.equal(composeServicesFile(config(), compose, { repositoryRoot }), text);
    assertLocalServiceContainers(config(), compose, text, { repositoryRoot });
  } finally {
    dispose();
  }
});

test("a probe the template defines applies to a service that names no healthCheckPath", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const compose = authored(INCLUDED.replace(
      "healthcheck: { interval: 30s, start_interval: 1s }",
      'healthcheck: { test: [CMD, "true"], interval: 10s }',
    ));
    const services = parseCompose(composeServicesFile(config(), compose, { repositoryRoot })!).services!;
    assert.deepEqual(services.billing!.healthcheck, { test: ["CMD", "true"], interval: "10s" });
    // A declared path still replaces the template's test, keeping its timing.
    assert.match(String((services.orders!.healthcheck as { test: string[] }).test[3]), /127\.0\.0\.1:8000\/health/);
    assert.equal((services.orders!.healthcheck as { interval: string }).interval, "10s");
  } finally {
    dispose();
  }
});

test("a service docker-compose.yml declares under its id is the developer's, and generation leaves it out", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const owned = (environment: string, volumes = "*mounts", command = `[${[...LAUNCH, "orders", "--", "python", "app.py"].join(", ")}]`) =>
      authored(`${INCLUDED}  orders:\n    build: ./orders\n    command: ${command}\n    environment: ${environment}\n    volumes: ${volumes}\n`);
    const compose = owned("{ PORT: '8000' }");
    const text = composeServicesFile(config(), compose, { repositoryRoot })!;
    assert.deepEqual(Object.keys(parseCompose(text).services!), ["billing"]);
    assertLocalServiceContainers(config(), compose, text, { repositoryRoot });
    // Without PORT, run-service gives it the declared one.
    assertLocalServiceContainers(config(), owned("{}"), text, { repositoryRoot });

    // A PORT the declaration disagrees with is a service the dev server never reaches...
    assert.throws(
      () => assertLocalServiceContainers(config(), owned("{ PORT: '9000' }"), text, { repositoryRoot }),
      /docker-compose\.yml gives service:orders PORT 9000, but it declares port 8000, where the local API dev server sends its requests\. Remove PORT \(run-service sets it from the declaration\) or set it to 8000\./,
    );
    // ...unless the dev server is sent somewhere else on purpose.
    const redirected = authored(`${INCLUDED}  local-api-dev-server:\n    image: dev\n    environment: { ORDERS_SERVICE_URL: "http://orders:9000" }\n  orders:\n    command: [${[...LAUNCH, "orders"].join(", ")}]\n    environment: { PORT: "9000" }\n    volumes: *mounts\n`);
    assertLocalServiceContainers(config(), redirected, composeServicesFile(config(), redirected, { repositoryRoot }), { repositoryRoot });

    // What run-service needs still holds for a container written by hand.
    assert.throws(
      () => assertLocalServiceContainers(config(), owned("{}", "[./data:/data]"), text, { repositoryRoot }),
      /service:orders needs a read-only mount of \/workspace\/\.framework\/local\./,
    );
    assert.throws(
      () => assertLocalServiceContainers(config(), owned("{}", "*mounts", "[python, app.py]"), text, { repositoryRoot }),
      /service:orders must start through packages\/framework\/scripts\/run-service\.ts <id> -- <command>\./,
    );
  } finally {
    dispose();
  }
});

test("a service whose container cannot be derived says why, before anything starts", () => {
  const { repositoryRoot, dispose } = repository({ ...SOURCES, billing: { ...SOURCES.billing, dev: false } });
  try {
    const compose = authored(INCLUDED);
    const text = composeServicesFile(config(), compose, { repositoryRoot });
    assert.deepEqual(Object.keys(parseCompose(text!).services!), ["orders"]);
    assert.throws(
      () => assertLocalServiceContainers(config(), compose, text, { repositoryRoot }),
      /service:billing runs locally, and its container cannot be generated: cdk-app\/ecs_containers\/services\/billing\/package\.json has no "dev" script, the command its container runs and Watch restarts\. Fix that, or declare a service named "billing" in docker-compose\.yml\./,
    );
  } finally {
    dispose();
  }
  const outside = repository(SOURCES, ["packages/*"]);
  try {
    const compose = authored(INCLUDED);
    assert.throws(
      () => assertLocalServiceContainers(config(), compose, composeServicesFile(config(), compose, outside), outside),
      /cdk-app\/ecs_containers\/services\/orders is not among the root package\.json workspaces, so the development image does not install it/,
    );
  } finally {
    outside.dispose();
  }
});

test("without x-framework-service nothing is generated, and each local service needs a container of its own", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const compose = authored("services:\n  postgres: { image: postgres }\n");
    assert.equal(composeServicesFile(config(), compose, { repositoryRoot }), undefined);
    assert.throws(
      () => assertLocalServiceContainers(config(), compose, undefined, { repositoryRoot }),
      /service:orders runs locally and has no container\. Declare a service named "orders" in docker-compose\.yml, or define x-framework-service there and include docker-compose\.services\.yml/,
    );
  } finally {
    dispose();
  }
});

test("a generated container docker-compose.yml does not include is refused, since it would never start", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const compose = authored(`${TEMPLATE}services:\n  postgres: { image: postgres }\n`);
    const text = composeServicesFile(config(), compose, { repositoryRoot });
    assert.throws(
      () => assertLocalServiceContainers(config(), compose, text, { repositoryRoot }),
      /docker-compose\.yml does not include docker-compose\.services\.yml, so service:orders's generated container never starts\. Add to docker-compose\.yml:\n  include:\n    - docker-compose\.services\.yml/,
    );
    // Either spelling of an include entry counts.
    const long = authored(`include:\n  - path: ./docker-compose.services.yml\n${TEMPLATE}services: {}\n`);
    assertLocalServiceContainers(config(), long, composeServicesFile(config(), long, { repositoryRoot }), { repositoryRoot });
  } finally {
    dispose();
  }
});

test("a declared value reaches the probe intact, whatever it contains", () => {
  const { repositoryRoot, dispose } = repository(SOURCES);
  try {
    const odd = config({ "/orders/*": { directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000, healthCheckPath: "/it's \\ \"ok\"", deploy: "local-only" } });
    const services = parseCompose(composeServicesFile(odd, authored(INCLUDED), { repositoryRoot })!).services!;
    const script = (services.orders!.healthcheck as { test: string[] }).test[3]!;
    // Valid JavaScript, requesting exactly the declared path.
    let requested: string | undefined;
    new Function("require", "process", script)(
      () => ({ get: (url: string) => { requested = url; return { on: () => undefined }; } }),
      { exit: () => undefined },
    );
    assert.equal(requested, "http://127.0.0.1:8000/it's \\ \"ok\"");
  } finally {
    dispose();
  }
});
