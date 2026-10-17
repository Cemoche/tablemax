import { expect, test } from "vitest";
import type { CellValue, ForeignKeyInfo } from "../../lib/types";
import { col, tableInfo } from "../../test/tableInfo";
import { fkFilterValue, fkLinksAt } from "./fkLinks";

const fk = (over: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo => ({
  name: "fk",
  columns: ["order_id"],
  refSchema: "sales",
  refTable: "orders",
  refColumns: ["id"],
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
  ...over,
});

const columns = ["order_id", "line", "note"];
const info = (...foreignKeys: ForeignKeyInfo[]) =>
  tableInfo({ columns: columns.map((c) => col(c)), foreignKeys });
const row = (...v: CellValue[]) => v;

test("filter values: numbers, strings and temporal text as is; bool per dialect", () => {
  expect(fkFilterValue("postgres", { t: "int", v: 42 })).toBe("42");
  expect(fkFilterValue("postgres", { t: "bigInt", v: "9007199254740993" })).toBe("9007199254740993");
  expect(fkFilterValue("mySql", { t: "decimal", v: "1.50" })).toBe("1.50");
  expect(fkFilterValue("sqlite", { t: "text", v: "O'Brien" })).toBe("O'Brien");
  expect(fkFilterValue("postgres", { t: "temporal", v: "2026-10-17 10:00:00+02" })).toBe(
    "2026-10-17 10:00:00+02",
  );
  expect(fkFilterValue("postgres", { t: "bool", v: true })).toBe("true");
  expect(fkFilterValue("mySql", { t: "bool", v: false })).toBe("0");
  expect(fkFilterValue("sqlite", { t: "bool", v: true })).toBe("1");
});

test("NULL, truncated and binary values cannot be a filter value", () => {
  expect(fkFilterValue("postgres", { t: "null" })).toBeNull();
  expect(fkFilterValue("postgres", { t: "longText", v: { preview: "ab", len: 9000 } })).toBeNull();
  expect(fkFilterValue("postgres", { t: "bytes", v: { len: 1, hexPreview: "ff" } })).toBeNull();
});

test("a single-column key links to the referenced table filtered by its column", () => {
  const links = fkLinksAt(info(fk()), "postgres", columns, row({ t: "int", v: 42 }, { t: "int", v: 1 }), "order_id");
  expect(links).toEqual([
    {
      fk: fk(),
      object: { schema: "sales", name: "orders" },
      filters: [{ column: "id", op: "eq", values: ["42"] }],
    },
  ]);
  expect(fkLinksAt(info(fk()), "postgres", columns, row({ t: "int", v: 42 }), "line")).toEqual([]);
});

test("a composite key uses every column; a NULL in any of them gives no link", () => {
  const composite = fk({ columns: ["order_id", "line"], refColumns: ["order_ref", "line_no"] });
  const r = row({ t: "int", v: 42 }, { t: "int", v: 3 });
  expect(fkLinksAt(info(composite), "postgres", columns, r, "line")[0].filters).toEqual([
    { column: "order_ref", op: "eq", values: ["42"] },
    { column: "line_no", op: "eq", values: ["3"] },
  ]);
  expect(fkLinksAt(info(composite), "postgres", columns, row({ t: "int", v: 42 }, { t: "null" }), "order_id")).toEqual([]);
});

test("a key column missing from the page gives no link", () => {
  const composite = fk({ columns: ["order_id", "missing"], refColumns: ["a", "b"] });
  expect(fkLinksAt(info(composite), "postgres", columns, row({ t: "int", v: 1 }), "order_id")).toEqual([]);
});

test("a referenced table without a schema stays in the table's schema", () => {
  const links = fkLinksAt(info(fk({ refSchema: null })), "sqlite", columns, row({ t: "int", v: 1 }), "order_id");
  expect(links[0].object).toEqual({ schema: "public", name: "orders" });
});

test("a column in two keys offers both links, in key order", () => {
  const a = fk({ name: "a", refTable: "orders" });
  const b = fk({ name: "b", refTable: "archive" });
  const links = fkLinksAt(info(a, b), "postgres", columns, row({ t: "int", v: 1 }), "order_id");
  expect(links.map((l) => l.object.name)).toEqual(["orders", "archive"]);
});
