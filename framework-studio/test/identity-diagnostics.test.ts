import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { IdentityService } from "../server/identity/service";
import type { DeployService } from "../server/deploy/service";
import type { CommandSpec, Runner } from "../server/deploy/process";
import { certificateCovers, domainSettingsProblems } from "../shared/domain-settings";
import { DeploymentInputService } from "../server/deployment-input-edits";
import type { ModeModel } from "../shared/model";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/identity-tests");
mkdirSync(cache, { recursive: true });
function fixture() {
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "cdk-app/lib/app"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "cdk-app/lib/app/cognito-stack.ts"), "new cognito.UserPoolIdentityProviderGoogle();");
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "RETAIN_STATEFUL_RESOURCES=false\nGOOGLE_CLIENT_ID=fake-public-client\nGOOGLE_CLIENT_SECRET=secret-sentinel-never-return\nOTHER_TOKEN=other-sentinel\n");
  return root;
}
function remove(root: string) { assert.ok(path.resolve(root).startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
const selection = { profile: "dev", deployment: "campaign-dev", region: "us-east-1" };
function deploy(owned = true) { return { targets: () => [{ name: selection.deployment, mode: "dev", account: "111122223333" }], observer: { status: async () => ({ ok: true, value: { context: { account: "111122223333" }, detail: { stacks: [{ name: "campaign-dev-CognitoStack", ...(owned ? { identity: { deployment: selection.deployment, mode: "dev" } } : {}) }] } } }) } } as unknown as Pick<DeployService, "targets" | "observer">; }

test("source diagnostics return public allowlist and secret presence, without secret/client-ID contents", () => {
  const root = fixture();
  try {
    const service = new IdentityService(root, deploy(), async () => { throw new Error("No AWS reads on source load"); });
    const result = service.source("dev");
    assert.deepEqual(result.providers, ["Google"]);
    assert.deepEqual(result.google, { clientIdPresent: true, authoredSecretPresent: true });
    assert.deepEqual(result.inputs, { RETAIN_STATEFUL_RESOURCES: "false" });
    assert.equal(result.identityPools, "not-declared");
    assert.doesNotMatch(JSON.stringify(result), /secret-sentinel|other-sentinel|fake-public-client/);
  } finally { remove(root); }
});

test("unknown deployment or unowned stacks refuse before any Cognito/AWS command", async () => {
  const root = fixture();
  try {
    let calls = 0;
    const service = new IdentityService(root, deploy(false), async () => { calls++; throw new Error("unexpected AWS"); });
    await assert.rejects(service.cognito(selection), /No verified owned stacks/);
    await assert.rejects(service.cognito({ ...selection, deployment: "unknown" }), /declared by this repository/);
    assert.equal(calls, 0);
  } finally { remove(root); }
});

test("Cognito reads page/search and multi-type provider metadata without asking for secret values or treating metadata as sign-in proof", async () => {
  const root = fixture();
  try {
    const calls: CommandSpec[] = [];
    const run: Runner = async spec => {
      calls.push(spec); const operation = spec.args[1]; const query = spec.args[spec.args.indexOf("--query") + 1] ?? "";
      const values: Record<string, unknown> = {
        "list-stack-resources": ["us-east-1_owned"],
        "describe-user-pool": { name: "Campaign", deletionProtection: "ACTIVE", estimatedUsers: 1 },
        "list-user-pool-clients": ["client"], "list-identity-providers": ["Google", "EnterpriseOIDC"],
        "list-groups": [{ name: "reader", precedence: 10, roleArn: "arn:aws:iam::111122223333:role/Reader" }],
        "list-users": { users: [{ username: "fake-user", status: "CONFIRMED", enabled: true }], nextToken: "page-2" },
        "describe-user-pool-client": { id: "client", callbacks: ["http://localhost:3000/auth/callback"], logout: ["http://localhost:3000/"], providers: ["COGNITO", "Google"] },
        "describe-identity-provider": { name: spec.args[spec.args.indexOf("--provider-name") + 1], type: "OIDC", settings: { issuer: "https://idp.example.com", client_id: "public-client", scopes: null }, mappedAttributes: ["email", "email_verified"] },
      };
      assert.ok(operation && Object.hasOwn(values, operation), `Read-only operation ${operation}`);
      assert.doesNotMatch(query, /client_secret|ClientSecret|MetadataFile|GetSecretValue/i);
      return { code: 0, stdout: JSON.stringify(values[operation]), stderr: "" };
    };
    const result = await new IdentityService(root, deploy(), run).cognito(selection, "page-1", 'fake"name');
    assert.equal(result.users[0]?.username, "fake-user"); assert.equal(result.nextToken, "page-2");
    assert.equal(result.providers.length, 2); assert.equal(result.providers[1]?.signIn, "unverified"); assert.equal(result.providers[1]?.providerSide, "unverified");
    assert.deepEqual(result.providers[1]?.settings, { issuer: "https://idp.example.com", client_id: "public-client" });
    const users = calls.find(spec => spec.args[1] === "list-users")!;
    assert.equal(users.args[users.args.indexOf("--filter") + 1], 'username ^= "fake\\"name"');
    assert.ok(users.args.includes("--no-paginate")); assert.ok(users.args.includes("page-1"));
    assert.ok(calls.every(spec => spec.env.AWS_PROFILE === "dev"));
  } finally { remove(root); }
});

test("denied AWS reads return safe actionable operation names without raw AWS error contents", async () => {
  const root = fixture();
  try {
    const service = new IdentityService(root, deploy(), async () => ({ code: 1, stdout: "", stderr: "AccessDenied secret-sentinel-never-return" }));
    await assert.rejects(service.identityPools(selection), error => error instanceof Error && /Access denied: cloudformation list-stack-resources/.test(error.message) && !error.message.includes("sentinel"));
  } finally { remove(root); }
});

test("domain validation rejects wrong region, invalid host and URLs; wildcard certificates cover a single DNS label", () => {
  const values = { USE_COGNITO_CUSTOM_DOMAIN: "true", COGNITO_DOMAIN_NAME: "https://auth.example.com", COGNITO_DOMAIN_CERTIFICATE_ARN: "arn:aws:acm:eu-west-1:111122223333:certificate/abcd" };
  assert.match(domainSettingsProblems("prod", values).join(" "), /DNS hostname/);
  assert.match(domainSettingsProblems("prod", values).join(" "), /us-east-1/);
  assert.deepEqual(domainSettingsProblems("dev", values), []);
  assert.ok(certificateCovers("auth.example.com", ["*.example.com"]));
  assert.equal(certificateCovers("auth.team.example.com", ["*.example.com"]), false);
  assert.match(domainSettingsProblems("prod", { FRONTEND_URL: "https://app.example.com/path", FRONTEND_CLOUDFRONT_CERTIFICATE_ARN: "invalid" }).join(" "), /without a path/);
});

test("protected env review refuses invalid domain/retention edits with zero writes and preserves unrelated source", () => {
  const root = fixture();
  try {
    const before = "# human comment\nUSE_COGNITO_CUSTOM_DOMAIN=false\nCOGNITO_DOMAIN_NAME=auth.example.com\nCOGNITO_DOMAIN_CERTIFICATE_ARN=arn:aws:acm:eu-west-1:111122223333:certificate/abcd\nRETAIN_STATEFUL_RESOURCES=false\n";
    writeFileSync(path.join(root, "cdk-app/.env.prod"), before);
    const model = { resources: [] } as unknown as ModeModel;
    const builder = { current: { snapshot: { revision: "r1", models: { dev: model, prod: model } } }, refresh: async () => ({ snapshot: { revision: "r2" } }) };
    const service = new DeploymentInputService(root, builder); const details = service.details("prod");
    assert.throws(() => service.plan("prod", [{ name: "USE_COGNITO_CUSTOM_DOMAIN", value: "true" }], details.hash, "r1"), /us-east-1/);
    assert.throws(() => service.plan("prod", [{ name: "RETAIN_STATEFUL_RESOURCES", value: "maybe" }], details.hash, "r1"), /choose true or false/);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8"), before);
  } finally { remove(root); }
});

test("identity-pool inspection distinguishes role mapping and guests from unverified effective IAM", async () => {
  const root = fixture();
  try {
    const service = new IdentityService(root, deploy(), async spec => {
      const result = spec.args[1] === "list-stack-resources" ? ["us-east-1:owned-pool"] : spec.args[1] === "describe-identity-pool" ? { name: "Campaign", guests: false, providers: [{ name: "cognito-idp.us-east-1.amazonaws.com/user-pool", clientId: "client" }] } : { roles: { authenticated: "arn:aws:iam::111122223333:role/Reader" }, mappings: { provider: { Type: "Token", AmbiguousRoleResolution: "Deny" } } };
      return { code: 0, stdout: JSON.stringify(result), stderr: "" };
    });
    const result = await service.identityPools(selection);
    assert.equal(result.pools[0]?.guests, false);
    assert.equal(result.pools[0]?.roles.authenticated, "arn:aws:iam::111122223333:role/Reader");
    assert.match(result.warnings.join(" "), /actual API authorization have not been tested/);
  } finally { remove(root); }
});

test("domain inspection reports pending/mismatched certificate, missing parent DNS, exact deployed target, and unknown application health separately", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "USE_COGNITO_CUSTOM_DOMAIN=true\nCOGNITO_DOMAIN_NAME=auth.example.com\nCOGNITO_DOMAIN_CERTIFICATE_ARN=arn:aws:acm:us-east-1:111122223333:certificate/abcd\nUSE_FRONTEND_CUSTOM_DOMAIN=false\n");
    const prod = { targets: () => [{ name: "campaign-prod", mode: "prod", account: "111122223333" }], observer: { status: async () => ({ ok: true, value: { context: { account: "111122223333" }, detail: { stacks: [{ name: "campaign-prod-CognitoStack", identity: { deployment: "campaign-prod", mode: "prod" } }] } } }) } } as unknown as Pick<DeployService, "targets" | "observer">;
    const service = new IdentityService(root, prod, async spec => {
      const result = spec.args[1] === "describe-stacks" ? [{ key: "UserPoolDomainCloudFrontEndpoint", value: "owned.cloudfront.net" }] : { status: "PENDING_VALIDATION", names: ["other.example.com"], expires: "2030-01-01T00:00:00Z", validation: [{ domain: "other.example.com", status: "PENDING_VALIDATION", name: "_proof.example.com", type: "CNAME", value: "_proof.acm-validations.aws" }] };
      return { code: 0, stdout: JSON.stringify(result), stderr: "" };
    }, {}, async hostname => { if (hostname === "example.com") throw new Error("no DNS"); return ["203.0.113.1"]; });
    const result = await service.domains({ ...selection, deployment: "campaign-prod" });
    assert.match(result.certificates[0]!.problems.join(" "), /PENDING_VALIDATION/);
    assert.match(result.certificates[0]!.problems.join(" "), /do not cover/);
    assert.equal(result.records[0]?.target, "owned.cloudfront.net");
    assert.match(result.dns.find(record => record.hostname === "example.com")!.problem!, /immediate parent/);
    assert.ok(result.health.every(check => check.status === "unverified"));
    assert.equal(result.certificates[0]?.validation[0]?.type, "CNAME");
  } finally { remove(root); }
});
