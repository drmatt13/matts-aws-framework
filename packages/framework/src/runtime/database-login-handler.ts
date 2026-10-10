/**
 * Creates the database's IAM login, once per database, as a custom resource.
 *
 * RDS creates every instance with a master user and a password, and nothing can
 * log in with IAM until a role holding `rds_iam` exists. So on deploy this
 * handler connects as the master, the one time anything reads that password,
 * and makes the login every workload uses: no password, `rds_iam`, and enough
 * to create and own the application's tables in `public`. It is not a
 * superuser. Every statement is idempotent, so an update, or a rerun after a
 * failure, changes nothing that is already right.
 *
 * Deleting does nothing: the login goes with the database.
 */
import { rootCertificates } from "node:tls";
import pg from "pg";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { RDS_CA_BUNDLE } from "./rds-ca-bundle";

interface LoginProperties {
  readonly SecretArn: string;
  readonly Host: string;
  readonly Port: string;
  readonly Database: string;
  readonly Login: string;
}

interface LoginEvent {
  readonly RequestType: "Create" | "Update" | "Delete";
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: LoginProperties;
}

export async function handler(event: LoginEvent): Promise<{ PhysicalResourceId: string }> {
  const { SecretArn, Host, Port, Database, Login } = event.ResourceProperties;
  const physicalResourceId = `${Login}@${Database}`;
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId ?? physicalResourceId };

  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: SecretArn }));
  const master = JSON.parse(secret.SecretString ?? "{}") as { username?: string; password?: string };
  if (!master.username || !master.password) {
    throw new Error("The database's master secret has no username or password.");
  }
  const client = new pg.Client({
    host: Host,
    port: Number(Port),
    database: Database,
    user: master.username,
    password: master.password,
    ssl: { ca: [RDS_CA_BUNDLE, ...rootCertificates].join("\n"), rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const login = client.escapeIdentifier(Login);
    await client.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${client.escapeLiteral(Login)}) THEN CREATE ROLE ${login} LOGIN; END IF; END $$`,
    );
    await client.query(`GRANT rds_iam TO ${login}`);
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(Database)} TO ${login}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${login}`);
  } finally {
    await client.end();
  }
  console.log(`The IAM login ${Login} is ready on ${Database}.`);
  return { PhysicalResourceId: physicalResourceId };
}
