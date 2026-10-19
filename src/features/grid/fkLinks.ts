// Foreign key links of a loaded row: which referenced table a cell opens, filtered on the
// referenced columns. Pure (no store, no IPC).
import type { CellValue, Dialect, Filter, ForeignKeyInfo, ObjectRef, TableInfo } from "../../lib/types";

export interface FkLink {
  fk: ForeignKeyInfo;
  /** The referenced table. */
  object: ObjectRef;
  /** `ref_columns[i] = value[i]`, one `eq` filter per key column. */
  filters: Filter[];
}

/**
 * The text an `eq` filter binds for a loaded value (the backend casts it to the column's
 * type), or null when the value cannot be matched: NULL, a truncated preview, or bytes
 * (filters bind text, which never equals a binary key).
 */
export function fkFilterValue(d: Dialect, v: CellValue): string | null {
  switch (v.t) {
    case "null":
    case "longText":
    case "bytes":
      return null;
    case "bool":
      // MySQL booleans are TINYINT(1); SQLite stores them as integers.
      return d === "postgres" ? String(v.v) : v.v ? "1" : "0";
    case "int":
    case "float":
      return String(v.v);
    default:
      return v.v;
  }
}

/**
 * The links of `column` in a loaded row (`columns` names its values), one per foreign key
 * holding the column, in key order. A key with a column missing from the page or a value
 * that cannot be matched (see fkFilterValue) gives no link.
 */
export function fkLinksAt(
  info: TableInfo,
  dialect: Dialect,
  columns: string[],
  row: CellValue[],
  column: string,
): FkLink[] {
  const links: FkLink[] = [];
  for (const fk of info.foreignKeys) {
    if (!fk.columns.includes(column)) continue;
    const filters: Filter[] = [];
    for (const [i, name] of fk.columns.entries()) {
      const at = columns.indexOf(name);
      const value = at < 0 || !row[at] ? null : fkFilterValue(dialect, row[at]);
      const ref = fk.refColumns[i];
      if (value === null || ref === undefined) break;
      filters.push({ column: ref, op: "eq", values: [value] });
    }
    if (filters.length !== fk.columns.length) continue;
    links.push({ fk, object: { schema: fk.refSchema ?? info.object.schema, name: fk.refTable }, filters });
  }
  return links;
}
