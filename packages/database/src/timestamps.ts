import type { TimestamptzString } from "@prisma/orm-postgres/target/codec-types";

/**
 * Records hand out timestamps as plain ISO strings; the ORM's write side wants
 * its branded form. Narrow at the repository boundary, and only there.
 */
export function toTimestamptz(value: string): TimestamptzString<6> {
  return value as TimestamptzString<6>;
}
