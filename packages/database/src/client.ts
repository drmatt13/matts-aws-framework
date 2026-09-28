import postgres from "@prisma/orm-postgres/runtime";
import contractJson from "./generated/contract.json" with { type: "json" };
import type { Contract } from "./generated/contract.js";

/**
 * The only place the Prisma runtime is bound. Everything above this file speaks
 * the ORM-neutral contract in `contracts.ts`.
 */
export type DatabaseClient = ReturnType<typeof postgres<Contract>>;

export function createClient(databaseUrl: string): DatabaseClient {
  return postgres<Contract>({ url: databaseUrl, contractJson });
}
