import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import { Template } from "aws-cdk-lib/assertions";
import {
  DATABASE_LOGIN, defineDatabase, defineFrameworkConfig, defineNetwork, defineResources,
  resource, resolveDatabaseSettings, type FrameworkNetwork,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { bindPostgresDatabase } from "../lib/framework/framework-database";
import { frameworkVpc } from "../lib/framework/framework-network";
import { finalizeFrameworkResources, initializeFrameworkResources, linkResource } from "../lib/framework/framework-resources";

const env = { account: "111122223333", region: "eu-west-2" };
const sealed = defineNetwork({ id: "sealed", cidr: "10.10.0.0/16", zones: 2, egressOnlyInternetGateway: false });
const sibling = defineNetwork({ id: "sibling", cidr: "10.11.0.0/16", zones: 2, egressOnlyInternetGateway: false, interfaceEndpoints: ["secretsmanager"] });

function nativeProxy(network: FrameworkNetwork, networks: readonly FrameworkNetwork[]) {
  const resources = defineResources({ data: resource.stack<{ database: rds.DatabaseInstance }>() });
  // The declaration disables Proxy; an explicit deployment override enables it.
  const database = defineDatabase({ id: "application", resource: resources.data.database, vpc: network, settings: { proxyEnabled: false } });
  const resolved = resolveDatabaseSettings({ defaults: database.settings, env: { DATABASE_PROXY_ENABLED: "true" }, getContext: () => undefined });
  const config = defineFrameworkConfig({ networks, resources, database, defaults, http: [], webSocket: [], events: [], services: [] });
  const app = new cdk.App();
  initializeFrameworkResources(app, { config, mode: "prod", deployment: "example", readers: { env: {} } });
  const stack = new cdk.Stack(app, "Data", { env });
  const vpc = frameworkVpc(stack, network);
  const instance = new rds.DatabaseInstance(stack, "Database", {
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
    vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    publiclyAccessible: false, storageEncrypted: true, iamAuthentication: true,
    databaseName: "app_db", credentials: rds.Credentials.fromGeneratedSecret("postgres"),
  });
  const role = new iam.Role(stack, "ProxyRole", { assumedBy: new iam.ServicePrincipal("rds.amazonaws.com") });
  instance.grantConnect(role, DATABASE_LOGIN);
  const proxy = resolved.proxyEnabled ? new rds.DatabaseProxy(stack, "Proxy", {
    proxyTarget: rds.ProxyTarget.fromInstance(instance), vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    role, defaultAuthScheme: rds.DefaultAuthScheme.IAM_AUTH, requireTLS: true,
  }) : undefined;
  linkResource(stack, resources.data.database, instance);
  bindPostgresDatabase(stack, resources.data.database, { instance, proxy });
  return { app, stack };
}

test("Proxy bootstrap without workload consumers rejects a sealed database VPC and cannot borrow sibling endpoints", () => {
  for (const networks of [[sealed], [sealed, sibling]]) {
    const { app, stack } = nativeProxy(sealed, networks);
    assert.throws(() => finalizeFrameworkResources(app), /IAM login bootstrap runs in VPC "sealed".*add "secretsmanager" to interfaceEndpoints/);
    assert.equal(stack.node.tryFindChild("FrameworkDatabaseLogin"), undefined, "reject before building an unusable bootstrap function");
    assert.equal(app.node.tryFindChild("example-SiblingNetworkStack"), undefined, "an unrelated endpoint VPC stays unused");
  }
});

test("Proxy bootstrap uses its database VPC's own endpoint or declared private egress", () => {
  const configurations = [
    { egressOnlyInternetGateway: false, interfaceEndpoints: ["secretsmanager"] as const },
    { egressOnlyInternetGateway: true },
    { egressOnlyInternetGateway: false, natGateway: true },
  ];
  for (const [index, settings] of configurations.entries()) {
    const network = defineNetwork({ id: `reachable-${index}`, cidr: `10.${20 + index}.0.0/16`, zones: 2, ...settings });
    const { app, stack } = nativeProxy(network, [network, sibling]);
    finalizeFrameworkResources(app);
    Template.fromStack(stack).resourceCountIs("Custom::DatabaseLogin", 1);
    assert.equal(app.node.tryFindChild("example-SiblingNetworkStack"), undefined);
  }
});
