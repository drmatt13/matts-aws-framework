import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { RDS_CA_BUNDLE } from "./rds-ca-bundle";

/**
 * Constructed on first use and kept for the life of the execution environment.
 *
 * Keep the client lazy so a caller using a direct database URL never creates
 * a Secrets Manager client. Warm invocations that do read secrets reuse it.
 */
let secretsManagerClient: SecretsManagerClient | undefined;

function secretsManager(): SecretsManagerClient {
  secretsManagerClient ??= new SecretsManagerClient({});
  return secretsManagerClient;
}

/**
 * One resolution per secret per execution environment.
 *
 * A warm Lambda would otherwise call Secrets Manager on every request, and the
 * answer does not change between them. A failed read is not cached, so the
 * next request tries again.
 */
const resolvedSecretUrls = new Map<string, Promise<string>>();

let trustStoreFile: string | undefined;

/**
 * The CAs a deployed connection is verified against, as a file `pg` can read.
 *
 * The RDS bundle signs instance endpoints; RDS Proxy presents an ACM
 * certificate that chains to a public root instead. `sslrootcert` replaces
 * Node's default trust store rather than adding to it, so both go in.
 */
function databaseTrustStore(): string {
  if (trustStoreFile) return trustStoreFile;
  const file = path.join(tmpdir(), "framework-database-ca.pem");
  writeFileSync(file, [RDS_CA_BUNDLE, ...rootCertificates].join("\n"));
  trustStoreFile = file;
  return file;
}

interface DatabaseSecretShape {
  username?: string;
  password?: string;
  engine?: string;
  host?: string;
  port?: number | string;
  dbname?: string;
}

export type GetDatabaseUrlConfig = {
  /** Defaults to `process.env.PRIMARY_DATABASE_SECRET_ARN`. */
  primaryDatabaseSecretArn?: string;
  /** Defaults to `process.env.PRIMARY_DATABASE_URL`. */
  primaryDatabaseUrl?: string;
  /**
   * Defaults to `process.env.PRIMARY_DATABASE_SSLMODE`, then `verify-full`
   * against the RDS certificate authorities. Only applies to a secret.
   */
  primaryDatabaseSslmode?: string;
  /**
   * Read the secret again instead of using this environment's cached answer,
   * for example after a credential rotation. Pair it with
   * `disconnectDatabase()` so the pool reconnects with the new password.
   */
  refresh?: boolean;
};

/**
 * The connection URL for the primary database.
 *
 * Deployed, the workload is handed `PRIMARY_DATABASE_SECRET_ARN` and the URL
 * is built from that secret, once per execution environment. Locally, the
 * framework hands it `PRIMARY_DATABASE_URL` for the Compose Postgres instead.
 * A handler calls it with no arguments and never branches on which it got.
 */
export async function getDatabaseUrl(
  config: GetDatabaseUrlConfig = {},
): Promise<string> {
  const secretArn =
    config.primaryDatabaseSecretArn ?? process.env.PRIMARY_DATABASE_SECRET_ARN;
  const directUrl = config.primaryDatabaseUrl ?? process.env.PRIMARY_DATABASE_URL;
  const sslmode =
    config.primaryDatabaseSslmode ?? process.env.PRIMARY_DATABASE_SSLMODE;

  if (secretArn) {
    if (config.refresh) resolvedSecretUrls.delete(secretArn);
    let pending = resolvedSecretUrls.get(secretArn);
    if (!pending) {
      pending = readSecretUrl(secretArn, sslmode);
      resolvedSecretUrls.set(secretArn, pending);
      pending.catch(() => resolvedSecretUrls.delete(secretArn));
    }
    return pending;
  }

  if (directUrl) {
    return directUrl;
  }

  throw new Error(
    "In local mode, PRIMARY_DATABASE_URL must be set to connect to the database. In cloud mode, PRIMARY_DATABASE_SECRET_ARN must be set to fetch database credentials from Secrets Manager.",
  );
}

async function readSecretUrl(
  secretArn: string,
  sslmode: string | undefined,
): Promise<string> {
  const secretResponse = await secretsManager().send(
    new GetSecretValueCommand({
      SecretId: secretArn,
    }),
  );

  if (!secretResponse.SecretString) {
    throw new Error(
      "PRIMARY_DATABASE_SECRET_ARN resolved, but Secrets Manager returned an empty SecretString.",
    );
  }

  let secret: DatabaseSecretShape;

  try {
    secret = JSON.parse(secretResponse.SecretString) as DatabaseSecretShape;
  } catch (error) {
    throw new Error(
      `Unable to parse database secret JSON from Secrets Manager: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const { username, password, host, dbname, engine } = secret;
  const port = String(secret.port ?? "5432");

  if (!username || !password || !host || !dbname) {
    throw new Error(
      "Database secret is missing one or more required fields: username, password, host, dbname.",
    );
  }

  if (engine && engine !== "postgres" && engine !== "postgresql") {
    throw new Error(
      `Unsupported database engine "${engine}" in the primary database secret; only PostgreSQL is supported.`,
    );
  }

  const connectionUrl = new URL(
    `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${dbname}`,
  );
  const mode = sslmode ?? "verify-full";
  connectionUrl.searchParams.set("sslmode", mode);
  if (mode === "verify-full") {
    connectionUrl.searchParams.set("sslrootcert", databaseTrustStore());
  }

  console.log("Resolved the primary database URL from Secrets Manager.", {
    secretArn,
    host,
    port,
    dbname,
    sslmode: mode,
  });

  return connectionUrl.toString();
}
