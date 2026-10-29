import type { SnapshotResponse, BatchPlanResponse } from "../../../shared/api";
import type { DatabaseWorkbench } from "../../../shared/database-workbench";
import type { DeclaredSchema } from "../../../shared/database";
import type { DeployOverview, DiscoveryView, PlanView } from "../../../shared/deploy";
import type { IdentitySource } from "../../../shared/identity";
import type { StatefulSource } from "../../../shared/stateful-resources";
import { graphFixture } from "../../../scripts/support/graph-fixture";

export const NOW = "2026-10-28T12:00:00.000Z";
export const location = { file: "framework-config/workloads/http.ts", line: 1, column: 1, start: 0, end: 10 };
export const schema: DeclaredSchema = {
  file: "packages/database/prisma/contract.prisma", hash: "browser-schema", problems: [], enums: [], relations: [],
  tables: [{ id: "schema:public.Note", model: "Note", namespace: "public", table: "Note", source: location,
    columns: [{ name: "id", column: "id", type: "String", nullable: false, primaryKey: true, unique: true, source: location },
      { name: "title", column: "title", type: "String", nullable: false, primaryKey: false, unique: false, source: location }], indexes: [] }],
};
export function snapshot(): SnapshotResponse {
  const dev = graphFixture(12, "dev"), prod = graphFixture(12, "prod");
  for (const model of [dev, prod]) {
    Object.assign(model, { fields: { "lambda:fixture-0": [{ field: "lambda.memorySize", label: "Memory", path: ["memorySize"], domain: { kind: "number", min: 128, max: 10240, unit: "MB" }, effective: 256, authored: 256, provenance: "Declaration" }] } });
  }
  return { evaluating: false, commands: {}, busy: null, sourceRecovery: [], sourceWatch: { status: "watching", checkedAt: NOW, pollIntervalMs: 1000, problems: [] }, snapshot: {
    revision: "browser-revision", generatedAt: NOW, repositoryRoot: "/studio-fixture", descriptions: { values: { "lambda:fixture-0": "A deterministic fixture for Studio browser checks." } },
    schema, databaseProblems: [], models: { dev, prod }, files: {}, source: {
      cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, links: {}, catalog: {}, problems: [],
      entities: { "lambda:fixture-0": { origin: 'http["/fixture/0"]', key: location, value: location } },
      editability: { "lambda:fixture-0": { "lambda.memorySize": { kind: "literal", text: "256" }, description: { kind: "literal", text: "256" }, tags: { kind: "absent" } } },
    },
  } };
}
export function overview(): DeployOverview {
  return {
    targets: [{ name: "browser-dev", mode: "dev", origin: "personal", inputs: "cdk-app/.env.dev" }, { name: "browser-prod", mode: "prod", origin: "declared", account: "123456789012", region: "us-east-1" }],
    prerequisites: [{ id: "docker", label: "Docker", status: "ok", summary: "Fixture engine ready" }],
    local: { project: "browser-fixture", docker: { engine: "running", desktop: true }, services: [], watch: { running: false }, client: { running: false }, exported: { client: false }, startedBy: "none", restartNeeded: [] },
    jobs: [], preferences: { profiles: {}, profile: "browser", deployment: "browser-dev" }, profiles: [{ name: "browser", kind: "sso", region: "us-east-1" }],
  };
}
export function discovery(): DiscoveryView {
  return { context: { arn: "arn:aws:iam::123456789012:role/browser-fixture", profile: "browser", account: "123456789012", region: "us-east-1" }, deployments: [], unrecognized: [], records: {}, unreadable: [], observedAt: NOW,
    targets: [{ name: "browser-dev", mode: "dev", origin: "personal", status: "absent" }, { name: "browser-prod", mode: "prod", origin: "declared", status: "absent" }] };
}
export function identity(mode: "dev" | "prod"): IdentitySource {
  return { mode, file: `cdk-app/.env.${mode}`, hash: `identity-${mode}`, exists: true, inputs: {}, google: { clientIdPresent: false, authoredSecretPresent: false }, providers: [], declaredProviders: [], identityPools: "not-declared", problems: [] };
}
export function workbench(): DatabaseWorkbench {
  return { file: schema.file, source: 'model Note {\n  id String @id\n  title String\n}\n', revision: "db-browser", configRevision: "browser-config", targets: [],
    validation: { sourceHash: "browser-schema", valid: true, diagnostics: [], schema, validatedAt: NOW },
    capabilities: { dialect: "PostgreSQL", semanticValidation: true, formatting: true, languageServer: false, notes: [] } };
}
export function batchPlan(): BatchPlanResponse {
  return { planId: "fixture-plan", summaries: ["Change fixture memory"], changes: [], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, ok: true, impact: [] };
}
export function stateful(mode: "dev" | "prod"): StatefulSource {
  return { file: "framework-config/resources.ts", hash: "browser-stateful", mode, resources: { database: {}, cognito: {} }, legacy: { file: `cdk-app/.env.${mode}`, retain: false, configured: false }, problems: [] };
}
export function deploymentPlan(): PlanView {
  return { key: "browser-plan", planId: "browser-plan-id", expired: false, profile: "browser", createdAt: NOW, expiresAt: "2026-10-29T12:00:00.000Z", status: "ready", review: "template",
    identity: { deployment: "browser-dev", mode: "dev", account: "123456789012", region: "us-east-1" }, guard: "absent", stacks: [], secrets: [], dockerImages: [], iamBroadening: false,
    confirmation: { level: "name", reasons: ["Fixture typed confirmation"] }, uncertainties: ["Application health is verified separately."] };
}
