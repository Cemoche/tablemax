// Editing rules of the table grid: which cells can be edited, the row key of a loaded
// row, and how typed text becomes an EditValue. Pure functions (no store, no IPC).
import { dict, hasKey } from "../../lib/records";
import { strings } from "../../lib/strings";
import type { CellValue, ColumnInfo, EditValue, RowKey, TableInfo } from "../../lib/types";
import { cellContent } from "./cellContent";

/** The loaded value is a preview: long text / JSON cut, or bytes beyond the preview. */
export function isTruncated(v: CellValue): boolean {
  if (v.t === "longText") return true;
  if (v.t === "bytes") return v.v.len * 2 > v.v.hexPreview.length;
  return false;
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

/**
 * Why the row key of a loaded row cannot identify it (a NULL or truncated key value, a
 * key column missing from the result), or null when it can.
 */
export function rowKeyIssue(info: TableInfo, columns: string[], row: CellValue[]): string | null {
  if (!info.rowKey) return readOnlyReason(info);
  for (const name of info.rowKey) {
    const v = row[columns.indexOf(name)];
    if (!v) return strings.grid.readOnlyNoKey;
    if (v.t === "null") return strings.grid.nullKey;
    if (isTruncated(v)) return strings.grid.truncatedKey;
  }
  return null;
}

/** The row key of a loaded row in row-key order, or null when it cannot identify the row. */
export function rowKeyOf(info: TableInfo, columns: string[], row: CellValue[]): RowKey | null {
  if (!info.rowKey || rowKeyIssue(info, columns, row) !== null) return null;
  return info.rowKey.map((name) => [name, row[columns.indexOf(name)]]);
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
  if (c.binary || value?.t === "bytes") {
    return { editable: false, reason: strings.grid.binaryReadOnly };
  }
  return { editable: true };
}

/**
 * An empty string is a value of the column: character types (char, varchar, text…,
 * MySQL SET, SQLite TEXT affinity or no declared type), not numbers, booleans, dates,
 * JSON, UUIDs, enums, arrays or bytes. Read from the base type (domains resolved).
 */
export function acceptsEmptyString(c: ColumnInfo): boolean {
  if (c.binary) return false;
  const t = c.baseType.trim().toLowerCase();
  if (t === "") return true;
  if (t.endsWith("]")) return false;
  return /char|text|clob/.test(t) || t.startsWith("set(");
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
 * The values of a duplicated row, as the user sees it (`edits`, the row's pending values,
 * over the loaded ones): every column but auto-increment, generated and binary ones (they
 * get their default). Truncated values are listed in `truncated` instead: the caller loads
 * them in full (cell_value) before inserting. `values` has a null prototype.
 */
export function insertValuesOf(
  info: TableInfo,
  columns: string[],
  row: CellValue[],
  edits?: Readonly<Record<string, EditValue>>,
): { values: Record<string, EditValue>; truncated: string[] } {
  const values = dict<EditValue>();
  const truncated: string[] = [];
  for (const c of info.columns) {
    if (c.autoIncrement || c.generated || c.binary) continue;
    if (edits && hasKey(edits, c.name)) {
      values[c.name] = edits[c.name];
      continue;
    }
    const v = row[columns.indexOf(c.name)];
    if (!v || v.t === "bytes") continue;
    if (v.t === "null") values[c.name] = { t: "null" };
    else if (isTruncated(v)) truncated.push(c.name);
    else values[c.name] = { t: "text", v: cellText(v) };
  }
  return { values, truncated };
}
