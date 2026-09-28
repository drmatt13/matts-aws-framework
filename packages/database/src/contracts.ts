import type { ContractRow } from "./contract-types.js";

/**
 * The public, ORM-neutral persistence contract.
 *
 * Record types are projected straight from `prisma/contract.prisma`, so the
 * schema is stated once: add a column there and it appears here. The import is
 * type-only and fully erased — no generated Prisma value or branded type
 * reaches a consumer of this package.
 *
 * Timestamps are ISO-8601 strings (`2026-01-01T00:00:00.000Z`), which is what
 * the driver returns and what GraphQL and the browser both want. Parse to a
 * `Date` at the point of use if you need date arithmetic.
 */

export type UserRecord = ContractRow<"User">;

/** The contract owns id creation and automatic timestamps. */
export type CreateUserInput = Omit<
  UserRecord,
  "id" | "createdAt" | "updatedAt"
>;

export type UpdateUserInput = Partial<CreateUserInput>;

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByCognitoSub(cognitoSub: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByCognitoSubOrEmail(
    cognitoSub: string,
    email: string,
  ): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  updateById(id: string, input: UpdateUserInput): Promise<UserRecord | null>;
  updateByCognitoSub(
    cognitoSub: string,
    input: UpdateUserInput,
  ): Promise<UserRecord | null>;
}

export type ProjectRecord = ContractRow<"Project">;

/** `archived` has a database default; `ownerId` is set from the caller's session. */
export type CreateProjectInput = Pick<ProjectRecord, "ownerId" | "name">;

export type UpdateProjectInput = Partial<
  Pick<ProjectRecord, "name" | "archived">
>;

/**
 * Every read and write is scoped by owner. A row that does not exist and a
 * row that belongs to someone else are the same answer — `null` — so the API
 * never reveals which, and the ownership check and the write are one statement
 * with nothing in between.
 */
export interface ProjectRepository {
  listByOwner(ownerId: string): Promise<ProjectRecord[]>;
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  updateOwnedById(
    id: string,
    ownerId: string,
    input: UpdateProjectInput,
  ): Promise<ProjectRecord | null>;
  deleteOwnedById(id: string, ownerId: string): Promise<ProjectRecord | null>;
}
