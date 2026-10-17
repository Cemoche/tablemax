// Editing rules of the table grid: which cells can be edited, the row key of a loaded
// row, and how typed text becomes an EditValue. Pure functions (no store, no IPC).
import { strings } from "../../lib/strings";
import type { CellValue, ColumnInfo, EditValue, RowKey, TableInfo } from "../../lib/types";
import { cellContent } from "./cellContent";

/** The loaded value is a preview: long text / JSON cut, or bytes beyond the preview. */
export function isTruncated(v: CellValue): boolean {
  if (v.t === "longText") return true;
  if (v.t === "bytes") return v.v.len * 2 > v.v.hexPreview.length;
  return false;
}

/** Binary column types (bytes are read-only in v1), whatever the cell holds. */
export function isBinaryColumn(c: ColumnInfo): boolean {
  return /bytea|blob|binary/i.test(c.typeName);
}

/** The text an editor starts from (what Ctrl+C copies); "" for NULL. */
export function cellText(v: CellValue): string {
  return cellContent(v).copyText;
}

/** Why the whole table is read-only, or null when it can be edited. */
export function readOnlyReason(info: TableInfo): string | null {
  if (info.kind === "view") return strings.grid.readOnlyView;
  if (!info.rowKey) return strings.grid.readOnlyNoKey;
  return null;
}

const indexOf = (columns: string[], name: string) => columns.indexOf(name);

/**
 * Why the row key of a loaded row cannot identify it (a NULL or truncated key value, a
 * key column missing from the result), or null when it can.
 */
export function rowKeyIssue(info: TableInfo, columns: string[], row: CellValue[]): string | null {
  if (!info.rowKey) return readOnlyReason(info);
  for (const name of info.rowKey) {
    const v = row[indexOf(columns, name)];
    if (!v) return strings.grid.readOnlyNoKey;
    if (v.t === "null") return strings.grid.nullKey;
    if (isTruncated(v)) return strings.grid.truncatedKey;
  }
  return null;
}

/** The row key of a loaded row in row-key order, or null when it cannot identify the row. */
export function rowKeyOf(info: TableInfo, columns: string[], row: CellValue[]): RowKey | null {
  if (!info.rowKey || rowKeyIssue(info, columns, row) !== null) return null;
  return info.rowKey.map((name) => [name, row[indexOf(columns, name)]]);
}

export interface Editability {
  editable: boolean;
  reason?: string;
}

/** Whether a cell of `column` holding `value` may be edited (the row key aside). */
export function cellEditability(info: TableInfo, column: string, value: CellValue | null): Editability {
  const table = readOnlyReason(info);
  if (table) return { editable: false, reason: table };
  const c = info.columns.find((x) => x.name === column);
  if (!c) return { editable: false, reason: strings.grid.readOnlyNoKey };
  if (c.generated) return { editable: false, reason: strings.grid.generatedColumn };
  if (isBinaryColumn(c) || value?.t === "bytes") {
    return { editable: false, reason: strings.grid.binaryReadOnly };
  }
  return { editable: true };
}

/** What the editor writes: NULL and DEFAULT are explicit choices, never parsed from text. */
export function parseEditorInput(
  text: string,
  opts: { setNull?: boolean; setDefault?: boolean },
): EditValue {
  if (opts.setNull) return { t: "null" };
  if (opts.setDefault) return { t: "default" };
  return { t: "text", v: text };
}

/** The value typed equals the loaded one (a truncated value never matches). */
export function matchesOriginal(value: EditValue, original: CellValue): boolean {
  if (value.t === "null") return original.t === "null";
  if (value.t === "default") return false;
  if (original.t === "null" || isTruncated(original)) return false;
  return cellText(original) === value.v;
}

/**
 * The values of a duplicated row: every column but auto-increment, generated and binary
 * ones (they get their default). Truncated values are listed in `truncated` instead: the
 * caller loads them in full (cell_value) before inserting.
 */
export function insertValuesOf(
  info: TableInfo,
  columns: string[],
  row: CellValue[],
): { values: Record<string, EditValue>; truncated: string[] } {
  const values: Record<string, EditValue> = {};
  const truncated: string[] = [];
  for (const c of info.columns) {
    if (c.autoIncrement || c.generated || isBinaryColumn(c)) continue;
    const v = row[indexOf(columns, c.name)];
    if (!v || v.t === "bytes") continue;
    if (v.t === "null") values[c.name] = { t: "null" };
    else if (isTruncated(v)) truncated.push(c.name);
    else values[c.name] = { t: "text", v: cellText(v) };
  }
  return { values, truncated };
}
