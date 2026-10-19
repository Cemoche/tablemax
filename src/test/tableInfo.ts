import type { ColumnInfo, TableInfo } from "../lib/types";

/** A ColumnInfo fixture: a nullable text column unless overridden. */
export const col = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  typeName: "text",
  baseType: "text",
  nullable: true,
  default: null,
  autoIncrement: false,
  generated: false,
  binary: false,
  comment: null,
  ...over,
});

/**
 * An editable table keyed by (order_id, line), with an identity `id`, a nullable `note`,
 * a generated `total` and a binary `data` column.
 */
export const tableInfo = (over: Partial<TableInfo> = {}): TableInfo => ({
  object: { schema: "public", name: "order_lines" },
  kind: "table",
  columns: [
    col("order_id", { typeName: "integer", baseType: "integer", nullable: false }),
    col("line", { typeName: "integer", baseType: "integer", nullable: false }),
    col("id", { typeName: "integer", baseType: "integer", autoIncrement: true, nullable: false }),
    col("note"),
    col("total", { typeName: "numeric", baseType: "numeric", generated: true }),
    col("data", { typeName: "bytea", baseType: "bytea", binary: true }),
  ],
  primaryKey: ["order_id", "line"],
  indexes: [],
  foreignKeys: [],
  rowKey: ["order_id", "line"],
  hasRowid: false,
  ...over,
});
