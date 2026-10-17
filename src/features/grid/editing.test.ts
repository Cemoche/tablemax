import { expect, test } from "vitest";
import { strings } from "../../lib/strings";
import type { CellValue } from "../../lib/types";
import { col, tableInfo } from "../../test/tableInfo";
import {
  cellEditability,
  cellText,
  insertValuesOf,
  isTruncated,
  matchesOriginal,
  parseEditorInput,
  readOnlyReason,
  rowKeyIssue,
  rowKeyOf,
} from "./editing";

const columns = ["id", "order_id", "line", "note", "total", "data"];
const int = (v: number): CellValue => ({ t: "int", v });
const text = (v: string): CellValue => ({ t: "text", v });

test("rowKeyOf follows the row key order of a composite primary key", () => {
  const row = [int(9), int(42), int(3), text("x"), { t: "decimal", v: "1.50" } as CellValue, { t: "null" } as CellValue];
  expect(rowKeyOf(tableInfo(), columns, row)).toEqual([
    ["order_id", int(42)],
    ["line", int(3)],
  ]);
  expect(rowKeyIssue(tableInfo(), columns, row)).toBeNull();
});

test("rowKeyOf is null when a key value is truncated, NULL or missing", () => {
  const info = tableInfo({ rowKey: ["note"], primaryKey: [] });
  const long: CellValue = { t: "longText", v: { preview: "abc", len: 20000 } };
  expect(rowKeyOf(info, columns, [int(1), int(1), int(1), long, int(0), int(0)])).toBeNull();
  expect(rowKeyIssue(info, columns, [int(1), int(1), int(1), long, int(0), int(0)])).toBe(
    strings.grid.truncatedKey,
  );
  const nul: CellValue = { t: "null" };
  expect(rowKeyOf(info, columns, [int(1), int(1), int(1), nul, int(0), int(0)])).toBeNull();
  expect(rowKeyIssue(info, columns, [int(1), int(1), int(1), nul, int(0), int(0)])).toBe(
    strings.grid.nullKey,
  );
  const bytesKey = tableInfo({ rowKey: ["data"] });
  const cut: CellValue = { t: "bytes", v: { len: 65, hexPreview: "00".repeat(64) } };
  const whole: CellValue = { t: "bytes", v: { len: 2, hexPreview: "beef" } };
  expect(rowKeyOf(bytesKey, columns, [int(1), int(1), int(1), nul, nul, cut])).toBeNull();
  expect(rowKeyOf(bytesKey, columns, [int(1), int(1), int(1), nul, nul, whole])).toEqual([["data", whole]]);
  expect(rowKeyOf(tableInfo(), ["id"], [int(1)])).toBeNull();
  expect(rowKeyOf(tableInfo({ rowKey: null }), columns, [])).toBeNull();
});

test("cellEditability: generated, binary and read-only tables are not editable", () => {
  const info = tableInfo();
  expect(cellEditability(info, "note", text("x"))).toEqual({ editable: true });
  expect(cellEditability(info, "total", int(1))).toEqual({
    editable: false,
    reason: strings.grid.generatedColumn,
  });
  // A bytea column holding NULL is still binary.
  expect(cellEditability(info, "data", { t: "null" })).toEqual({
    editable: false,
    reason: strings.grid.binaryReadOnly,
  });
  expect(cellEditability(info, "note", { t: "bytes", v: { len: 1, hexPreview: "00" } }).editable).toBe(false);
  const view = tableInfo({ kind: "view", rowKey: null, primaryKey: [] });
  expect(cellEditability(view, "note", text("x"))).toEqual({
    editable: false,
    reason: strings.grid.readOnlyView,
  });
  const keyless = tableInfo({ rowKey: null, primaryKey: [] });
  expect(cellEditability(keyless, "note", text("x"))).toEqual({
    editable: false,
    reason: strings.grid.readOnlyNoKey,
  });
  expect(readOnlyReason(info)).toBeNull();
  expect(readOnlyReason(view)).toBe(strings.grid.readOnlyView);
});

test("parseEditorInput keeps NULL, DEFAULT and empty strings apart", () => {
  expect(parseEditorInput("", {})).toEqual({ t: "text", v: "" });
  expect(parseEditorInput("NULL", {})).toEqual({ t: "text", v: "NULL" });
  expect(parseEditorInput("x", { setNull: true })).toEqual({ t: "null" });
  expect(parseEditorInput("x", { setDefault: true })).toEqual({ t: "default" });
});

test("matchesOriginal compares a typed value with the loaded one", () => {
  expect(matchesOriginal({ t: "text", v: "5" }, int(5))).toBe(true);
  expect(matchesOriginal({ t: "text", v: "" }, { t: "null" })).toBe(false);
  expect(matchesOriginal({ t: "null" }, { t: "null" })).toBe(true);
  expect(matchesOriginal({ t: "text", v: "true" }, { t: "bool", v: true })).toBe(true);
  expect(matchesOriginal({ t: "text", v: "abc" }, { t: "longText", v: { preview: "abc", len: 20000 } })).toBe(false);
  expect(matchesOriginal({ t: "default" }, int(1))).toBe(false);
  expect(cellText({ t: "json", v: '{"a": 1}' })).toBe('{"a": 1}');
  expect(isTruncated({ t: "longText", v: { preview: "a", len: 2 } })).toBe(true);
  expect(isTruncated({ t: "bytes", v: { len: 2, hexPreview: "beef" } })).toBe(false);
});

test("insertValuesOf copies a row without auto, generated or binary columns", () => {
  const long: CellValue = { t: "longText", v: { preview: "abc", len: 20000 } };
  const row = [int(9), int(42), int(3), long, int(7), { t: "bytes", v: { len: 1, hexPreview: "00" } } as CellValue];
  expect(insertValuesOf(tableInfo(), columns, row)).toEqual({
    values: { order_id: { t: "text", v: "42" }, line: { t: "text", v: "3" } },
    truncated: ["note"],
  });
  const withNull = [int(9), int(42), int(4), { t: "null" } as CellValue, int(7), { t: "null" } as CellValue];
  expect(insertValuesOf(tableInfo(), columns, withNull).values.note).toEqual({ t: "null" });
});

test("binary comes from the backend flag, not the type name", () => {
  const info = tableInfo({
    columns: [...tableInfo().columns, col("raw", { typeName: "blob_like_text" }), col("bits", { typeName: "bit(8)", binary: true })],
  });
  expect(cellEditability(info, "raw", text("x"))).toEqual({ editable: true });
  expect(cellEditability(info, "bits", text("1")).editable).toBe(false);
});

test("insertValuesOf copies pending edits over the loaded values", () => {
  const row = [int(9), int(42), int(3), text("old"), int(7), { t: "null" } as CellValue];
  const edits = Object.assign(Object.create(null), {
    note: { t: "text", v: "edited" },
    total: { t: "text", v: "99" },
  });
  const { values, truncated } = insertValuesOf(tableInfo(), columns, row, edits);
  expect(values.note).toEqual({ t: "text", v: "edited" });
  expect(values.total).toBeUndefined();
  expect(truncated).toEqual([]);
  // A pending value replaces a truncated one: nothing left to load.
  const long: CellValue = { t: "longText", v: { preview: "abc", len: 20000 } };
  const r2 = [int(9), int(42), int(3), long, int(7), { t: "null" } as CellValue];
  expect(insertValuesOf(tableInfo(), columns, r2, edits).truncated).toEqual([]);
});

test("columns named __proto__ and constructor are plain keys", () => {
  const info = tableInfo({
    columns: [col("id", { nullable: false }), col("__proto__"), col("constructor")],
    rowKey: ["id"],
    primaryKey: ["id"],
  });
  const names = ["id", "__proto__", "constructor"];
  const { values } = insertValuesOf(info, names, [int(1), text("p"), text("c")]);
  expect(Object.getPrototypeOf(values)).toBeNull();
  expect(Object.keys(values)).toEqual(["id", "__proto__", "constructor"]);
  expect(values["__proto__"]).toEqual({ t: "text", v: "p" });
});
