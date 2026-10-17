// What the table grid shows once pending changes are laid over the loaded page: inserted
// rows first, then the page rows with their edits and deletes. Pure (no store, no IPC);
// DataGrid draws it, TableDataTab acts on it.
import type { CellValue, EditValue, ResultSet, RowKey, TableInfo } from "../../lib/types";
import { type PendingEdit, type PendingTab, rowKeyId } from "../../stores/pendingChanges";
import { cellEditability, isTruncated, readOnlyReason, rowKeyIssue, rowKeyOf } from "./editing";

export type DisplayRow =
  | { kind: "insert"; tempId: string; values: Record<string, EditValue> }
  | {
      kind: "row";
      /** Index in the loaded page. */
      index: number;
      key: RowKey | null;
      keyId: string | null;
      /** Why the row cannot be edited (NULL / truncated key), else null. */
      keyIssue: string | null;
      deleted: boolean;
      edit: PendingEdit | null;
    };

export interface EditCell {
  /** The pending value, else the loaded one; "default" = DEFAULT (insert). */
  value: CellValue | "default";
  editable: boolean;
  /** Why the cell is not editable (null when editable or locked by a commit). */
  reason: string | null;
  /** A pending value set on this cell. */
  edited: boolean;
  /** The loaded value is a preview: the editor loads the whole value first. */
  truncated: boolean;
}

export type RowState = "insert" | "delete" | "failed" | null;

export interface GridModel {
  info: TableInfo | null;
  /** A commit is running: nothing is editable and the menu offers nothing. */
  locked: boolean;
  columns: string[];
  rows: DisplayRow[];
  cell: (row: number, col: number) => EditCell;
  rowState: (row: number) => RowState;
  /** The apply error of the row's change. */
  rowError: (row: number) => string | null;
  /** Row key of a loaded row (null for inserts and unusable keys). */
  rowKeyAt: (row: number) => RowKey | null;
  /** The table and the row accept edits (inserts always do when the table does). */
  rowEditable: (row: number) => boolean;
}

const toCell = (v: EditValue): CellValue | "default" =>
  v.t === "default" ? "default" : v.t === "null" ? { t: "null" } : { t: "text", v: v.v };

const NONE: EditCell = { value: { t: "null" }, editable: false, reason: null, edited: false, truncated: false };

/** The change ids a display row can carry. */
function changeIdOf(r: DisplayRow): string[] {
  if (r.kind === "insert") return [`insert:${r.tempId}`];
  return r.keyId ? [`update:${r.keyId}`, `delete:${r.keyId}`] : [];
}

/**
 * `locked`: a commit is running (nothing editable). `info` null: not loaded (read-only).
 */
export function buildGridModel(
  data: ResultSet,
  info: TableInfo | null,
  pending: PendingTab | undefined,
  locked: boolean,
): GridModel {
  const columns = data.columns.map((c) => c.name);
  const tableEditable = info !== null && readOnlyReason(info) === null;
  const rows: DisplayRow[] = [
    ...(tableEditable ? (pending?.inserts ?? []) : []).map(
      (i): DisplayRow => ({ kind: "insert", tempId: i.tempId, values: i.values }),
    ),
    ...data.rows.map((r, index): DisplayRow => {
      const key = info ? rowKeyOf(info, columns, r) : null;
      const keyId = key ? rowKeyId(key) : null;
      return {
        kind: "row",
        index,
        key,
        keyId,
        keyIssue: info && tableEditable ? rowKeyIssue(info, columns, r) : null,
        deleted: keyId !== null && pending?.deletes[keyId] !== undefined,
        edit: keyId !== null ? (pending?.edits[keyId] ?? null) : null,
      };
    }),
  ];

  const rowError = (row: number) => {
    const r = rows[row];
    if (!r || !pending) return null;
    for (const id of changeIdOf(r)) if (pending.errors[id]) return pending.errors[id];
    return null;
  };

  const rowEditable = (row: number) => {
    const r = rows[row];
    if (!r || !tableEditable || locked) return false;
    return r.kind === "insert" || (r.key !== null && !r.deleted);
  };

  const cell = (row: number, col: number): EditCell => {
    const r = rows[row];
    const name = columns[col];
    if (!r || name === undefined) return NONE;
    if (r.kind === "insert") {
      const v = r.values[name];
      const e = info ? cellEditability(info, name, null) : { editable: false };
      return {
        value: v ? toCell(v) : "default",
        editable: e.editable && !locked,
        reason: e.reason ?? null,
        edited: v !== undefined,
        truncated: false,
      };
    }
    const loaded = data.rows[r.index][col] ?? { t: "null" };
    const pendingValue = r.edit?.set[name];
    const value = pendingValue ? toCell(pendingValue) : loaded;
    let editable = false;
    let reason: string | null = null;
    if (!info) reason = null;
    else if (!tableEditable) reason = readOnlyReason(info);
    else if (r.keyIssue) reason = r.keyIssue;
    else if (!r.deleted) {
      const e = cellEditability(info, name, loaded);
      editable = e.editable && !locked;
      reason = e.reason ?? null;
    }
    return {
      value,
      editable,
      reason,
      edited: pendingValue !== undefined,
      truncated: pendingValue === undefined && isTruncated(loaded),
    };
  };

  return {
    info,
    locked,
    columns,
    rows,
    cell,
    rowState: (row) => {
      const r = rows[row];
      if (!r) return null;
      if (rowError(row) !== null) return "failed";
      if (r.kind === "insert") return "insert";
      return r.deleted ? "delete" : null;
    },
    rowError,
    rowKeyAt: (row) => {
      const r = rows[row];
      return r?.kind === "row" ? r.key : null;
    },
    rowEditable,
  };
}

export type MenuAction =
  | "setNull"
  | "setEmpty"
  | "setDefault"
  | "revertCell"
  | "duplicateRow"
  | "deleteRow"
  | "restoreRow";

/**
 * The context menu of a cell (`col` null: the row marker). Cell actions only on editable
 * cells (Set NULL on nullable columns, Set DEFAULT in inserts), then the row actions.
 */
export function menuActions(model: GridModel, row: number, col: number | null): MenuAction[] {
  const { info } = model;
  const r = model.rows[row];
  if (!r || !info || model.locked || readOnlyReason(info) !== null) return [];
  const out: MenuAction[] = [];
  if (col !== null) {
    const c = model.cell(row, col);
    if (c.editable) {
      const column = info.columns.find((x) => x.name === model.columns[col]);
      if (column?.nullable) out.push("setNull");
      out.push("setEmpty");
      if (r.kind === "insert") out.push("setDefault");
      if (c.edited) out.push("revertCell");
    }
  }
  out.push("duplicateRow");
  if (r.kind === "insert") out.push("deleteRow");
  else if (r.key) out.push(r.deleted ? "restoreRow" : "deleteRow");
  return out;
}
