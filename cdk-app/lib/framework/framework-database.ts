import path from "node:path";
import * as cdk from "aws-cdk-lib";
import type * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, type IConstruct } from "constructs";
import { DATABASE_LOGIN, type ConnectsToBinding, type NormalizedTarget } from "@repo/framework/config";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { linkedConstruct } from "./framework-resources";
import { databaseClientPlacement, presentConnections } from "./framework-network";

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
}
const states = new WeakMap<IConstruct, DatabaseState>();
function state(scope: IConstruct): DatabaseState {
  const root = scope.node.root;
  let value = states.get(root);
  if (!value) {
    value = { logins: new Map(), users: [] };
    states.set(root, value);
  }
  return value;
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

/** The custom resource that creates the IAM login, built once per database. */
function databaseLogin(scope: IConstruct, binding: ConnectsToBinding, instance: rds.DatabaseInstance, databaseName: string): void {
  const logins = state(scope).logins;
  if (logins.has(instance)) return;
  const owner = new Construct(cdk.Stack.of(instance), "FrameworkDatabaseLogin");
  const handler = new nodejs.NodejsFunction(owner, "Handler", {
    entry: LOGIN_HANDLER,
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.minutes(1),
    bundling: { externalModules: [], target: "node24" },
    // It reaches the database the way a workload does, and Secrets Manager
    // over IPv6 from the private subnets.
    ...databaseClientPlacement(scope, binding, "The database's IAM login"),
    environment: { AWS_USE_DUALSTACK_ENDPOINT: "true" },
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
    },
  });
  login.node.addDependency(instance);
  logins.set(instance, login);
}

/**
 * Grants a workload the database it declared and returns the environment it
 * reads: the URL, which carries no password, and "iam". Empty when the target
 * uses no database this deployment builds.
 */
export function connectDatabase(scope: IConstruct, grantee: iam.IGrantable, target: NormalizedTarget): Record<string, string> {
  const [binding] = presentConnections(target);
  if (!binding) return {};
  const { instance, databaseName } = linkedDatabase(scope, binding);
  databaseLogin(scope, binding, instance, databaseName);
  instance.grantConnect(grantee, DATABASE_LOGIN);
  state(scope).users.push(target.reference);
  return {
    PRIMARY_DATABASE_URL: cdk.Fn.join("", [
      "postgresql://", DATABASE_LOGIN, "@",
      instance.dbInstanceEndpointAddress, ":", instance.dbInstanceEndpointPort, "/", databaseName,
    ]),
    PRIMARY_DATABASE_AUTH: "iam",
  };
}

/** One line for the synth output, or undefined when nothing uses a database. */
export function describeFrameworkDatabase(scope: IConstruct): string | undefined {
  const { users } = state(scope);
  if (users.length === 0) return undefined;
  return `Database: ${users.join(", ")} log in as ${DATABASE_LOGIN} with IAM. No workload reads a database password.`;
}
