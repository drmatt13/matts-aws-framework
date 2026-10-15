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
  settings: string;
  close(): Promise<void>;
  database: Database;
};

declare global {
  // Reuse one database-owned pool across warm Lambda invocations.
  var __repoDatabaseCaches: Map<string, DatabaseCache> | undefined;
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
  if (connection.connectionString) {
    const url = new URL(connection.connectionString);
    return `${url.username}@${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`;
  }
  return `${encodeURIComponent(connection.user ?? "")}@${connection.host}:${connection.port ?? 5432}/${connection.database}`;
}

/** Repositories over one pool per connection identity in each execution environment. */
export function getDatabase(connection: DatabaseConnection): Database {
  const caches = globalThis.__repoDatabaseCaches ??= new Map();
  const identity = connectionIdentity(connection);
  const cached = caches.get(identity);
  // Credentials rotate independently of connection and pool settings.
  const { password: _password, connectionString: _url, ...options } = connection;
  const settings = JSON.stringify({
    ...options,
    max: connection.max ?? 10,
    connectionTimeoutMillis: connection.connectionTimeoutMillis ?? 20_000,
    idleTimeoutMillis: connection.idleTimeoutMillis ?? 30_000,
    ...(connection.connectionString ? { parameters: new URL(connection.connectionString).search } : {}),
  }, (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
  if (cached) {
    if (cached.settings !== settings) {
      throw new Error("Database pool settings changed while a shared connection is active. Call disconnectDatabase() before reconnecting.");
    }
    return cached.database;
  }
  const { client, close } = createClient(connection);
  const database = createDatabase(client);
  caches.set(identity, { settings, close, database });
  return database;
}

export async function disconnectDatabase(): Promise<void> {
  const caches = globalThis.__repoDatabaseCaches;
  if (!caches) return;
  globalThis.__repoDatabaseCaches = undefined;
  const results = await Promise.allSettled([...caches.values()].map(cached => cached.close()));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (errors.length) throw Object.assign(new Error("Failed to close database pools."), { errors: errors.map(result => result.reason) });
}
