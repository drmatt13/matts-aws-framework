import type { SourceLocation } from "./model";

/** A Compose service, kept separate from the AWS resource catalog. No connection values. */
export interface LocalDatabase {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly image: string;
  readonly volumes: readonly string[];
  readonly source: SourceLocation;
  readonly enabled: boolean;
}

export interface SchemaColumn {
  readonly name: string;
  readonly column: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly default?: string;
  readonly source: SourceLocation;
}

export interface SchemaIndex {
  readonly name?: string;
  readonly kind: "primary" | "unique" | "index";
  readonly fields: readonly string[];
  readonly predicate?: string;
  readonly declaration: string;
  readonly source: SourceLocation;
}

export interface SchemaTable {
  readonly id: string;
  readonly model: string;
  readonly namespace: string;
  readonly table: string;
  readonly columns: readonly SchemaColumn[];
  readonly indexes: readonly SchemaIndex[];
  readonly source: SourceLocation;
}

export interface SchemaRelation {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly fields: readonly string[];
  readonly references: readonly string[];
  readonly cardinality: "1:1" | "N:1";
  readonly nullable: boolean;
  readonly onDelete: string;
  readonly onUpdate: string;
  readonly source: SourceLocation;
}

export interface DeclaredSchema {
  readonly file: string;
  readonly hash: string;
  readonly tables: readonly SchemaTable[];
  readonly relations: readonly SchemaRelation[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly problems: readonly string[];
}
