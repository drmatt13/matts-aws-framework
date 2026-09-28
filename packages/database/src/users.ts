import { or } from "@prisma/orm-postgres/orm-client";
import type { DatabaseClient } from "./client.js";
import type { UserRepository } from "./contracts.js";

/**
 * Rows are returned as-is: the driver already hands back ISO-8601 strings for
 * `timestamptz`, and Prisma's branded scalars widen to the plain types
 * `UserRecord` promises. No per-table mapper needed.
 */
export function createUserRepository(client: DatabaseClient): UserRepository {
  const users = client.orm.public.User;

  return {
    findById: async (id) => users.first({ id }),
    findByCognitoSub: async (cognitoSub) => users.first({ cognitoSub }),
    findByEmail: async (email) => users.first({ email }),
    findByCognitoSubOrEmail: async (cognitoSub, email) =>
      users.first((candidate) =>
        or(candidate.cognitoSub.eq(cognitoSub), candidate.email.eq(email)),
      ),
    create: async (input) => users.create(input),
    updateById: async (id, input) =>
      users.where({ id }).update(input),
    updateByCognitoSub: async (cognitoSub, input) =>
      users.where({ cognitoSub }).update(input),
  };
}
