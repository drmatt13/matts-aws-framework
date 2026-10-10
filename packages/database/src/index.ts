import { createClient, type DatabaseClient, type DatabaseConnection } from "./client.js";
import { createProjectRepository } from "./projects.js";
import { createUserRepository } from "./users.js";

export {
  CognitoIdentityConflictError,
  ensureCognitoUser,
  type CognitoUserIdentity,
} from "./cognito-users.js";

export type * from "./contracts.js";
export type { DatabaseConnection } from "./client.js";

/**
 * The repository registry, and the source `Database` is derived from.
 *
 * Adding a table is one line here. `Database` is computed from this object and
 * the instances are constructed from it, so there is no second list to keep in
 * step and no record type to re-export by hand.
 */
const repositories = {
  users: createUserRepository,
  projects: createProjectRepository,
} as const;

export type Database = {
  [K in keyof typeof repositories]: ReturnType<(typeof repositories)[K]>;
};

type DatabaseCache = {
  identity: string;
  close(): Promise<void>;
  database: Database;
};

declare global {
  // Reuse one database-owned pool across warm Lambda invocations.
  var __repoDatabaseCache: DatabaseCache | undefined;
}

function createDatabase(client: DatabaseClient): Database {
  // The cast is the price of building the registry generically: `fromEntries`
  // widens keys to `string`. It is contained here so that adding a table stays
  // a one-line edit rather than a second construction to forget.
  return Object.fromEntries(
    Object.entries(repositories).map(([key, create]) => [key, create(client)]),
  ) as Database;
}

/** What makes two connections the same database: never the password. */
function connectionIdentity(connection: DatabaseConnection): string {
  return connection.connectionString ?? `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

/**
 * The repositories, over one pool per execution environment.
 *
 * ```ts
 * const database = getDatabase(databaseConnection());
 * ```
 */
export function getDatabase(connection: DatabaseConnection): Database {
  const cached = globalThis.__repoDatabaseCache;
  const identity = connectionIdentity(connection);

  if (cached) {
    if (cached.identity !== identity) {
      throw new Error(
        "Database connection settings changed while a shared connection is active. Call disconnectDatabase() before reconnecting.",
      );
    }

    return cached.database;
  }

  const { client, close } = createClient(connection);
  const database = createDatabase(client);

  globalThis.__repoDatabaseCache = { identity, close, database };

  return database;
}

export async function disconnectDatabase(): Promise<void> {
  const cached = globalThis.__repoDatabaseCache;

  if (!cached) {
    return;
  }

  globalThis.__repoDatabaseCache = undefined;
  await cached.close();
}
