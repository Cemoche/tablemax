import { beforeEach, expect, test } from "vitest";
import { strings } from "../../lib/strings";
import type { CellValue, ResultSet, RowKey } from "../../lib/types";
import { rowKeyId, usePendingChanges } from "../../stores/pendingChanges";
import { tableInfo } from "../../test/tableInfo";
import { buildGridModel, menuActions } from "./editModel";

const T = "tab1";
const obj = { schema: "public", name: "order_lines" };
const int = (v: number): CellValue => ({ t: "int", v });
const names = ["id", "order_id", "line", "note", "total", "data"];
const rs = (rows: CellValue[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: "x" })),
  rows,
  truncated: false,
});
const row = (line: number, note: CellValue = { t: "text", v: "n" }): CellValue[] => [
  int(line),
  int(42),
  int(line),
  note,
  { t: "decimal", v: "1.50" },
  { t: "null" },
];
const key = (line: number): RowKey => [
  ["order_id", int(42)],
  ["line", int(line)],
];
const s = () => usePendingChanges.getState();
const model = (data: ResultSet, info = tableInfo(), locked = false) =>
  buildGridModel(data, info, s().tabs[T], locked);

beforeEach(() => {
  usePendingChanges.setState({
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    applied: {},
    editorOpen: {},
    awaitingReload: {},
    epoch: {},
  });
});

test("inserts come first, then the page rows with their pending state", () => {
  const data = rs([row(1), row(2), row(3)]);
  s().setCell(T, obj, key(1), "note", { t: "null" }, row(1), names);
  s().toggleDelete(T, obj, key(2));
  const a = s().addInsert(T, obj, { note: { t: "text", v: "fresh" } });
  const m = model(data);
  expect(m.rows.length).toBe(4);
  expect(m.rowState(0)).toBe("insert");
  expect(m.cell(0, 3)).toMatchObject({ value: { t: "text", v: "fresh" }, editable: true, edited: true });
  expect(m.cell(0, 0)).toMatchObject({ value: "default", editable: true });
  expect(m.cell(0, 4)).toMatchObject({ value: "default", editable: false, reason: strings.grid.generatedColumn });
  expect(m.cell(1, 3)).toMatchObject({ value: { t: "null" }, edited: true, editable: true });
  expect(m.cell(1, 1)).toMatchObject({ value: int(42), edited: false });
  expect(m.rowState(1)).toBeNull();
  expect(m.rowState(2)).toBe("delete");
  expect(m.cell(2, 3).editable).toBe(false);
  expect(m.rowKeyAt(3)).toEqual(key(3));
  expect(m.rows[0]).toMatchObject({ kind: "insert", tempId: a });
});

test("a failed change marks its row", () => {
  const data = rs([row(1)]);
  s().toggleDelete(T, obj, key(1));
  usePendingChanges.setState((st) => ({
    tabs: { ...st.tabs, [T]: { ...st.tabs[T], errors: { [`delete:${rowKeyId(key(1))}`]: "stale" } } },
  }));
  expect(model(data).rowState(0)).toBe("failed");
  expect(model(data).rowError(0)).toBe("stale");
});

test("read-only tables, locked grids and rows without a usable key", () => {
  const nullKey = row(5);
  nullKey[2] = { t: "null" };
  const long: CellValue = { t: "longText", v: { preview: "p", len: 20000 } };
  const data = rs([row(1, long), nullKey]);
  const m = model(data);
  expect(m.cell(0, 3)).toMatchObject({ editable: true, truncated: true });
  expect(m.cell(1, 3)).toMatchObject({ editable: false, reason: strings.grid.nullKey });
  expect(m.rowKeyAt(1)).toBeNull();
  expect(model(data, tableInfo(), true).cell(0, 3).editable).toBe(false);
  const view = model(data, tableInfo({ kind: "view", rowKey: null }));
  expect(view.cell(0, 3)).toMatchObject({ editable: false, reason: strings.grid.readOnlyView });
  expect(buildGridModel(data, null, undefined, false).cell(0, 3).editable).toBe(false);
});

test("menu actions depend on the row and the cell", () => {
  const data = rs([row(1), row(2)]);
  s().setCell(T, obj, key(1), "note", { t: "null" }, row(1), names);
  s().toggleDelete(T, obj, key(2));
  s().addInsert(T, obj, { note: { t: "text", v: "x" } });
  const m = model(data);
  // Insert row, nullable cell that was set.
  expect(menuActions(m, 0, 3)).toEqual([
    "setNull",
    "setEmpty",
    "setDefault",
    "revertCell",
    "duplicateRow",
    "deleteRow",
  ]);
  // Edited cell of a loaded row: no DEFAULT outside an insert.
  expect(menuActions(m, 1, 3)).toEqual(["setNull", "setEmpty", "revertCell", "duplicateRow", "deleteRow"]);
  // NOT NULL, unedited integer cell: no empty string either (not a text column).
  expect(menuActions(m, 1, 1)).toEqual(["duplicateRow", "deleteRow"]);
  const varchar = tableInfo({
    columns: tableInfo().columns.map((c) =>
      c.name === "order_id" ? { ...c, typeName: "varchar(10)", baseType: "character varying" } : c,
    ),
  });
  expect(menuActions(model(data, varchar), 1, 1)).toEqual(["setEmpty", "duplicateRow", "deleteRow"]);
  // Deleted row, row marker.
  expect(menuActions(m, 2, 3)).toEqual(["duplicateRow", "restoreRow"]);
  expect(menuActions(m, 2, null)).toEqual(["duplicateRow", "restoreRow"]);
  // A commit is running: nothing.
  expect(menuActions(model(data, tableInfo(), true), 1, 3)).toEqual([]);
  // Read-only table: nothing.
  expect(menuActions(model(data, tableInfo({ rowKey: null })), 1, 3)).toEqual([]);
});
