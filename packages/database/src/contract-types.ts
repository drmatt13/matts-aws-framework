import type { FieldOutputTypes } from "./generated/contract.js";
import type {
  TimeString,
  TimestampString,
  TimestamptzString,
} from "@prisma/orm-postgres/target/codec-types";

/**
 * Plain, ORM-neutral projections of `prisma/contract.prisma`.
 *
 * This is the only file that touches generated artifacts, and it does so at the
 * type level only. Record types in `contracts.ts` are derived from
 * `ContractRow`, so a column added to the contract appears on the record with no
 * second edit — there is no hand-written copy that can drift from the schema.
 */

type Public = FieldOutputTypes["public"];

export type ContractModel = keyof Public;

/**
 * Prisma emits branded scalars (`TimestamptzString<6>` is a branded `string`).
 * The record layer promises plain TypeScript types, and branded -> plain is a
 * safe widening at zero runtime cost. Widening here is what keeps a record
 * usable as a Pothos backing type, where `t.exposeString` demands a real
 * `string`.
 */
type TextTimestamp =
  | TimeString<number | undefined>
  | TimestampString<number | undefined>
  | TimestamptzString<number | undefined>;

// Only erase codec brands. String literals (including enum members) are domain
// information, and must survive this projection along with nullable unions.
export type PlainRow<Row> = {
  -readonly [K in keyof Row]: Row[K] extends infer V
    ? V extends TextTimestamp
      ? string
      : V
    : never;
};

export type ContractRow<M extends ContractModel> = PlainRow<Public[M]>;
