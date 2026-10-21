import path from "node:path";
import * as cdk from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, type IConstruct } from "constructs";
import { DATABASE_LOGIN, hasEndpoint, resolveNetwork, subnetEgress, isResourceAbsent, type ConnectsToBinding, type NormalizedTarget, type CdkResourceSpec, DEFAULT_DATABASE_POOL } from "@repo/framework/config";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { linkedConstruct, deferResourceAttachment, frameworkResourceOptions } from "./framework-resources";
import { databaseClientPlacement, dualStackEnvironment, frameworkVpc, presentConnections } from "./framework-network";

const LOGIN_HANDLER = path.join(
  findRepositoryRoot(__dirname),
  "packages",
  "framework",
  "src",
  "runtime",
  "database-login-handler.ts",
);

/**
 * What `database: true` builds in a production deployment, beyond the network
 * placement framework-network.ts gives it.
 *
 * Workloads log in with IAM as {@link DATABASE_LOGIN}: each is granted
 * `rds-db:connect` for that one login and handed a URL with no password, and
 * signs a short-lived token per connection. The login itself is created on
 * deploy, once per database, by a custom resource in the database's stack —
 * the only thing that ever reads the master password RDS requires.
 */

interface DatabaseState {
  readonly logins: Map<rds.DatabaseInstance, cdk.CustomResource>;
  readonly users: string[];
  readonly targets: Map<string, DatabaseConnectionTarget>;
}
const states = new WeakMap<IConstruct, DatabaseState>();
function state(scope: IConstruct): DatabaseState {
  const root = scope.node.root;
  let value = states.get(root);
  if (!value) {
    value = { logins: new Map(), users: [], targets: new Map() };
    states.set(root, value);
  }
  return value;
}

/** Check the native writer even when no deployed workload requests database access. */
export function validateDatabaseNetwork(scope: IConstruct): void {
  const database = frameworkResourceOptions(scope)?.config.database;
  if (!database || isResourceAbsent(database.resource)) return;
  const linked = linkedConstruct(scope, database.resource);
  if (!linked || !(linked.construct instanceof rds.DatabaseInstance)) return;
  const expected = frameworkVpc(linked.construct, database.vpc);
  if (linked.construct.vpc !== expected) throw new Error(`The database is built in another VPC. Build resources.${database.resource.path.join(".")} with vpc: frameworkVpc(this, the configured database VPC).`);
}

/** The config's database, checked to be one a workload can log in to with IAM. */
function linkedDatabase(scope: IConstruct, binding: ConnectsToBinding): { readonly instance: rds.DatabaseInstance; readonly databaseName: string } {
  const name = `resources.${binding.resource.path.join(".")}`;
  const linked = linkedConstruct(scope, binding.resource);
  if (!linked) {
    throw new Error(`The config's database, ${name}, is linked by nothing. End its stack's constructor with linkResources(this, resources.${binding.resource.path[0]}).`);
  }
  const instance = linked.construct;
  if (!(instance instanceof rds.DatabaseInstance)) {
    throw new Error(`The config's database, ${name}, is not an rds.DatabaseInstance, which is what database: true logs in to.`);
  }
  if (!instance.secret) {
    throw new Error(
      `The config's database, ${name}, has no master secret. Build it with credentials: rds.Credentials.fromGeneratedSecret("postgres"): the framework reads it once, on deploy, to create the IAM login.`,
    );
  }
  const resource = instance.node.defaultChild as rds.CfnDBInstance;
  if (typeof resource.dbName !== "string" || cdk.Token.isUnresolved(resource.dbName)) {
    throw new Error(`The config's database, ${name}, names no database. Give it databaseName, such as databaseName: "app_db".`);
  }
  if (resource.masterUsername === DATABASE_LOGIN) {
    throw new Error(
      `The config's database, ${name}, has the master user "${DATABASE_LOGIN}", which is the IAM login the framework creates. Name the master something else, such as "postgres".`,
    );
  }
  return { instance, databaseName: resource.dbName };
}

/** A CDK-only endpoint with native network and IAM attachment hooks. */
export interface DatabaseEndpoint {
  readonly hostname: string;
  readonly port: string | number;
  readonly connections: ec2.Connections;
  readonly vpc: ec2.IVpc;
  readonly kind: "direct" | "proxy" | "reader";
  grantConnect(grantee: iam.IGrantable, login: string): unknown;
}
export interface DatabaseConnectionTarget {
  readonly directWriter: DatabaseEndpoint;
  readonly applicationWriter: DatabaseEndpoint;
  readonly readers: readonly DatabaseEndpoint[];
  readonly databaseName: string;
  readonly login: string;
  bootstrap(binding: ConnectsToBinding): cdk.CustomResource;
}

/** Attach a connection adapter beside an application construct, before finalization. */
export function bindDatabaseConnectionTarget(scope: IConstruct, reference: CdkResourceSpec, target: DatabaseConnectionTarget): void {
  const targets = state(scope).targets;
  const key = JSON.stringify(reference.path);
  if (targets.has(key)) throw new Error(`Database connections for resources.${reference.path.join(".")} were bound twice.`);
  for (const endpoint of [target.directWriter, target.applicationWriter, ...target.readers]) {
    if (endpoint.vpc !== target.directWriter.vpc) throw new Error("Database connection endpoints must share the writer's VPC.");
  }
  targets.set(key, target);
}

/** PostgreSQL provisioning is kept behind the connection adapter. */
export function bindPostgresDatabase(scope: IConstruct, reference: CdkResourceSpec, options: {
  readonly instance: rds.DatabaseInstance;
  readonly proxy?: rds.DatabaseProxy;
  readonly readReplicas?: readonly rds.DatabaseInstanceReadReplica[];
}): void {
  const { instance, proxy, readReplicas = [] } = options;
  const resource = instance.node.defaultChild as rds.CfnDBInstance;
  const endpoint = (database: rds.DatabaseInstance | rds.DatabaseInstanceReadReplica, kind: "direct" | "reader"): DatabaseEndpoint => ({
    hostname: database.dbInstanceEndpointAddress, port: database.dbInstanceEndpointPort,
    connections: database.connections, vpc: database.vpc, kind,
    grantConnect: (grantee, login) => database.grantConnect(grantee, login),
  });
  const directWriter = endpoint(instance, "direct");
  const target: DatabaseConnectionTarget = {
    directWriter,
    applicationWriter: proxy ? {
      hostname: proxy.endpoint, port: 5432, connections: proxy.connections, vpc: instance.vpc, kind: "proxy",
      grantConnect: (grantee, login) => proxy.grantConnect(grantee, login),
    } : directWriter,
    readers: readReplicas.map(replica => endpoint(replica, "reader")),
    databaseName: resource.dbName!, login: DATABASE_LOGIN,
    bootstrap: binding => {
      const linked = linkedDatabase(scope, binding);
      if (linked.instance !== instance) throw new Error("The bound PostgreSQL instance differs from the linked database resource.");
      const login = databaseLogin(scope, binding, instance, linked.databaseName);
      if (proxy) proxy.node.findChild("ProxyTargetGroup").node.addDependency(login);
      return login;
    },
  };
  bindDatabaseConnectionTarget(scope, reference, target);
  if (proxy) deferResourceAttachment(scope, () => target.bootstrap({ capability: "connectsTo", resource: reference, connection: "direct" }));
}

/** Existing directly linked PostgreSQL instances receive the default adapter. */
export function databaseConnectionTarget(scope: IConstruct, binding: ConnectsToBinding): DatabaseConnectionTarget {
  const key = JSON.stringify(binding.resource.path);
  let target = state(scope).targets.get(key);
  if (!target) {
    const { instance } = linkedDatabase(scope, binding);
    bindPostgresDatabase(scope, binding.resource, { instance });
    target = state(scope).targets.get(key)!;
  }
  return target;
}

/** The custom resource that creates the IAM login, built once per database. */
function databaseLogin(scope: IConstruct, binding: ConnectsToBinding, instance: rds.DatabaseInstance, databaseName: string): cdk.CustomResource {
  const logins = state(scope).logins;
  if (logins.has(instance)) return logins.get(instance)!;
  const options = frameworkResourceOptions(scope);
  const database = options?.config.database;
  if (!options || !database) throw new Error("Configure an explicit application database declaration before creating its IAM login.");
  const network = resolveNetwork(options.config, database.vpc);
  const egress = subnetEgress(network, "private");
  if (!egress.ipv4 && !egress.ipv6 && !hasEndpoint(network, "secretsmanager")) {
    throw new Error(`The database's IAM login bootstrap runs in VPC "${network.id}" private subnets and must read its master secret from Secrets Manager. Turn on egressOnlyInternetGateway or natGateway, or add "secretsmanager" to interfaceEndpoints in that VPC declaration. Endpoints in another VPC cannot provide this route.`);
  }
  const owner = new Construct(cdk.Stack.of(instance), "FrameworkDatabaseLogin");
  const handler = new nodejs.NodejsFunction(owner, "Handler", {
    entry: LOGIN_HANDLER,
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.minutes(1),
    bundling: { externalModules: [], target: "node24" },
    // It reaches the database the way a workload does, and Secrets Manager
    // the way the private subnets allow: over IPv6, through the NAT gateway,
    // or through a "secretsmanager" interface endpoint.
    ...databaseClientPlacement(scope, { ...binding, connection: "direct", readers: undefined }, "The database's IAM login"),
    environment: dualStackEnvironment(scope, "private", frameworkResourceOptions(scope)!.config.database!.vpc),
  });
  instance.secret!.grantRead(handler);
  const provider = new cr.Provider(owner, "Provider", { onEventHandler: handler });
  const login = new cdk.CustomResource(owner, "Login", {
    serviceToken: provider.serviceToken,
    resourceType: "Custom::DatabaseLogin",
    properties: {
      SecretArn: instance.secret!.secretArn,
      Host: instance.dbInstanceEndpointAddress,
      Port: instance.dbInstanceEndpointPort,
      Database: databaseName,
      Login: DATABASE_LOGIN,
      // A replaced instance is a new database, and needs the login again.
      ResourceId: instance.instanceResourceId,
      // Bump when bootstrap grants change: replacing Lambda code alone does
      // not send an Update event to an existing custom resource.
      PermissionsVersion: 2,
    },
  });
  login.node.addDependency(instance);
  logins.set(instance, login);
  return login;
}

/**
 * Grants a workload the database it declared and returns the environment it
 * reads: the URL, which carries no password, and "iam". Empty when the target
 * uses no database this deployment builds.
 */
export function connectDatabase(scope: IConstruct, grantee: iam.IGrantable, target: NormalizedTarget): Record<string, string> {
  const [binding] = presentConnections(target);
  if (!binding) return {};
  const connection = databaseConnectionTarget(scope, binding);
  connection.bootstrap(binding);
  const writer = binding.connection === "direct" ? connection.directWriter : connection.applicationWriter;
  writer.grantConnect(grantee, connection.login);
  state(scope).users.push(target.reference);
  const url = (endpoint: DatabaseEndpoint): string => cdk.Fn.join("", [
    "postgresql://", connection.login, "@", endpoint.hostname, ":", String(endpoint.port), "/", connection.databaseName,
  ]);
  const environment: Record<string, string> = {
    PRIMARY_DATABASE_URL: url(writer), PRIMARY_DATABASE_AUTH: "iam",
    PRIMARY_DATABASE_POOL_OPTIONS: JSON.stringify(binding.pool ?? DEFAULT_DATABASE_POOL),
  };
  if (binding.readers) {
    for (const reader of connection.readers) reader.grantConnect(grantee, connection.login);
    environment.PRIMARY_DATABASE_READ_URLS = cdk.Stack.of(scope).toJsonString(connection.readers.map(url));
  }
  return environment;
}

/** One line for the synth output, or undefined when nothing uses a database. */
export function describeFrameworkDatabase(scope: IConstruct): string | undefined {
  const { users } = state(scope);
  if (users.length === 0) return undefined;
  return `Database: ${users.join(", ")} log in as ${DATABASE_LOGIN} with IAM. No workload reads a database password.`;
}
