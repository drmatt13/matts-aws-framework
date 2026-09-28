import type { TimestamptzString } from "@prisma/orm-postgres/target/codec-types";
import type { ContractRow, PlainRow } from "../src/contract-types.js";
import type { FieldOutputTypes } from "../src/generated/contract.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Row = PlainRow<{
  readonly timestamp: TimestamptzString<6>;
  readonly optionalTimestamp: TimestamptzString<6> | null;
  readonly status: "draft" | "published";
  readonly optionalStatus: "draft" | "published" | null;
  readonly name: string;
  readonly count: number;
  readonly addedColumn: boolean;
}>;

export type ProjectionChecks = [
  Assert<Equal<Row["timestamp"], string>>,
  Assert<Equal<Row["optionalTimestamp"], string | null>>,
  Assert<Equal<Row["status"], "draft" | "published">>,
  Assert<Equal<Row["optionalStatus"], "draft" | "published" | null>>,
  Assert<Equal<Row["name"], string>>,
  Assert<Equal<Row["count"], number>>,
  Assert<Equal<Row["addedColumn"], boolean>>,
  Assert<
    Equal<
      keyof ContractRow<"Project">,
      keyof FieldOutputTypes["public"]["Project"]
    >
  >,
];
