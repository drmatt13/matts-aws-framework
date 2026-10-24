import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { databaseReference } from "./support/database-reference";

const root = path.resolve(__dirname, "../.."), cache = path.join(root, ".cache");
const account = "111122223333", region = "us-east-1";
const reference = { account, region, originalDeployment: "original-app", userPoolId: "us-east-1_Original123", userPoolClientId: "originalpublicclient", userPoolDomainUrl: "https://original-app.auth.us-east-1.amazoncognito.com" };

test("actual composition reuses Cognito in both modes and retained PostgreSQL/network in prod through workload environments and IAM", () => {
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "cognito-reference-composition-"));
  try {
    const project = JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.json"), "utf8")).context;
    const cached = existsSync(path.join(root, "cdk-app/cdk.context.json")) ? JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.context.json"), "utf8")) : {};
    for (const mode of ["dev", "prod"] as const) {
      const inputs = path.join(directory, `${mode}.env`), shim = path.join(directory, `${mode}.cjs`), outdir = path.join(directory, `${mode}-out`);
      writeFileSync(inputs, "CDK_APP_NAME=reference-fixture\nLOCAL_DEV_URL=http://localhost:3000\nUSE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
      // Process-local mutation only: the application imports the same export,
      // while source and every other test worker retain their authored bytes.
      const policies = { cognito: { reference }, ...(mode === "prod" ? { database: { reference: databaseReference } } : {}) };
      writeFileSync(shim, `const source = require(${JSON.stringify(path.join(root, "framework-config/stateful-resources.ts"))});\nObject.assign(source.statefulResources[${JSON.stringify(mode)}], ${JSON.stringify(policies)});\nrequire(${JSON.stringify(path.join(root, "cdk-app/bin/main.ts"))});\n`);
      const inherited = { ...process.env };
      for (const key of Object.keys(inherited)) if (/^(CDK_|FRAMEWORK_|AWS_|PROD_DEPLOYMENT$|DEPLOY_PROD_WEBSOCKET_API$|DATABASE_)/.test(key)) delete inherited[key];
      const result = spawnSync(process.execPath, ["--import", "tsx", shim], { cwd: root, encoding: "utf8", timeout: 120_000, env: {
        ...inherited, CDK_OUTDIR: outdir, CDK_DEFAULT_ACCOUNT: account, CDK_DEFAULT_REGION: region, AWS_EC2_METADATA_DISABLED: "true", FRAMEWORK_INPUTS_FILE: inputs,
        CDK_CONTEXT_JSON: JSON.stringify({ ...project, ...cached, "framework:targets": { "reference-fixture-prod": { mode: "prod", account, region, inputs: "cdk-app/.env.prod" } }, "aws:cdk:bundling-stacks": [], prodDeployment: String(mode === "prod") }),
      } });
      assert.equal(result.status, 0, `${mode} reference composition: ${result.stdout}\n${result.stderr}`);
      const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8"));
      const templates: any[] = Object.values<any>(manifest.artifacts).filter(artifact => artifact.type === "aws:cloudformation:stack").map(artifact => JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), "utf8")));
      const cognito = templates.find(template => template.Outputs?.UserPoolManagement?.Value === "external-reference");
      assert.ok(cognito, `${mode} emits explicit external reference outputs`);
      assert.equal(cognito.Outputs.UserPoolId.Value, reference.userPoolId);
      assert.equal(cognito.Outputs.UserPoolClientId.Value, reference.userPoolClientId);
      assert.deepEqual(cognito.Metadata?.["framework:stateful-reference"]?.reference, reference);
      const resources = templates.flatMap(template => Object.values<any>(template.Resources ?? {}));
      assert.equal(resources.filter(resource => ["AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolDomain", "AWS::Cognito::UserPoolIdentityProvider", "AWS::Cognito::UserPoolGroup"].includes(resource.Type)).length, 0, `${mode} cannot synthesize replacement Cognito resources`);
      const consumers = resources.filter(resource => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Environment?.Variables?.USER_POOL_ID);
      assert.ok(consumers.length > 0, `${mode} has real framework consumers`);
      for (const consumer of consumers) {
        assert.equal(consumer.Properties.Environment.Variables.USER_POOL_ID, reference.userPoolId);
        assert.equal(consumer.Properties.Environment.Variables.USER_POOL_CLIENT_ID, reference.userPoolClientId);
      }
      assert.ok(Object.keys(cognito.Resources).length > 0, "Reference shell is a valid nonempty CloudFormation stack.");
      if (mode === "prod") {
        const database = templates.find(template => template.Metadata?.["framework:stateful-reference"]?.kind === "database");
        assert.ok(database, "Production publishes its inspected database reference metadata.");
        assert.equal(database.Outputs.RdsDatabaseEndpoint.Value, databaseReference.endpoint);
        const excluded = new Set(["AWS::RDS::DBInstance", "AWS::RDS::DBCluster", "AWS::RDS::DBProxy", "AWS::RDS::DBSubnetGroup", "AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::VPCEndpoint", "AWS::EC2::InternetGateway", "AWS::SecretsManager::Secret", "Custom::DatabaseLogin"]);
        assert.deepEqual(resources.filter(resource => excluded.has(resource.Type)).map(resource => resource.Type), [], "Referencing must not recreate the retained database/network, generate a new secret or bootstrap SQL identities.");
        const databaseConsumers = resources.filter(resource => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Environment?.Variables?.PRIMARY_DATABASE_URL);
        assert.ok(databaseConsumers.length > 0, "Production has real declared database consumers.");
        for (const consumer of databaseConsumers) {
          assert.equal(consumer.Properties.Environment.Variables.PRIMARY_DATABASE_URL, `postgresql://app_user@${databaseReference.endpoint}:5432/${databaseReference.databaseName}`);
          assert.equal(consumer.Properties.Environment.Variables.PRIMARY_DATABASE_AUTH, "iam");
        }
        const policies = JSON.stringify(resources.filter(resource => ["AWS::IAM::Policy", "AWS::IAM::Role"].includes(resource.Type)));
        assert.match(policies, /rds-db:connect/);
        assert.ok(policies.includes(databaseReference.instanceResourceId), "Database IAM connects use the immutable retained resource ID.");
        const ingress = Object.values<any>(database.Resources ?? {}).filter(resource => resource.Type === "AWS::EC2::SecurityGroupIngress");
        assert.ok(ingress.length > 0, "Reference stack owns reviewed ingress for the new declared workload security groups.");
        assert.ok(ingress.every(resource => databaseReference.securityGroupIds.includes(resource.Properties.GroupId)), "Every reference ingress targets only the selected existing database security groups.");
      }
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(cache + path.sep));
    rmSync(directory, { recursive: true });
  }
});
