import { expect, test } from "vitest";
import type { Filter } from "../../lib/types";
import {
  ANY_COLUMN,
  arityOf,
  draftsFromFilters,
  filtersFromDrafts,
  newDraft,
  opsFor,
  RAW_SQL,
  withColumn,
  withOp,
} from "./filterDrafts";

test("ILIKE is offered on PostgreSQL only", () => {
  expect(opsFor("postgres", "name")).toContain("ilike");
  expect(opsFor("mySql", "name")).not.toContain("ilike");
  expect(opsFor("sqlite", "name")).not.toContain("ilike");
  expect(opsFor("mySql", "name")).toContain("like");
});

test("any column is limited to =, contains, not contains and LIKE", () => {
  expect(opsFor("postgres", ANY_COLUMN)).toEqual(["eq", "contains", "notContains", "like"]);
  expect(opsFor("postgres", "name")).not.toContain("raw");
});

test("arity per operator", () => {
  expect(arityOf("isNull")).toBe(0);
  expect(arityOf("isNotNull")).toBe(0);
  expect(arityOf("eq")).toBe(1);
  expect(arityOf("raw")).toBe(1);
  expect(arityOf("between")).toBe(2);
  expect(arityOf("notBetween")).toBe(2);
  expect(arityOf("in")).toBe("list");
  expect(arityOf("notIn")).toBe("list");
});

test("switching to any column resets an operator it does not allow", () => {
  const d = withOp(newDraft(["status"]), "gt");
  expect(withColumn(d, ANY_COLUMN).op).toBe("eq");
  const c = withOp(newDraft(["status"]), "contains");
  expect(withColumn(c, ANY_COLUMN).op).toBe("contains");
  expect(withColumn(c, RAW_SQL).op).toBe("raw");
  expect(withColumn(withColumn(c, RAW_SQL), "status").op).toBe("eq");
});

test("changing the operator keeps the values that still fit", () => {
  let d = withOp(newDraft(["total"]), "between");
  d = { ...d, values: ["1", "9"] };
  expect(withOp(d, "eq").values).toEqual(["1"]);
  expect(withOp(d, "isNull").values).toEqual([]);
  expect(withOp(withOp(d, "eq"), "between").values).toEqual(["1", ""]);
  expect(withOp(d, "in").list).toBe("1, 9");
});

test("filters → drafts → filters round-trips, raw and any column included", () => {
  const filters: Filter[] = [
    { column: "status", op: "eq", values: ["paid"] },
    { column: null, op: "contains", values: ["x"] },
    { column: "id", op: "in", values: ["1", "a, b"] },
    { column: "total", op: "between", values: ["1", "9"] },
    { column: "notes", op: "isNotNull", values: [] },
    { column: null, op: "raw", values: ["total > 2 * id"] },
  ];
  const drafts = draftsFromFilters(filters);
  expect(drafts.map((d) => d.column)).toEqual(["status", ANY_COLUMN, "id", "total", "notes", RAW_SQL]);
  expect(drafts[2].list).toBe("1, 'a, b'");
  expect(filtersFromDrafts(drafts)).toEqual({ filters, errors: {} });
});

test("invalid drafts give per-row errors and no filters", () => {
  const list = { ...withOp(newDraft(["id"]), "in"), list: "1,,2" };
  const raw = { ...withColumn(newDraft(["id"]), RAW_SQL), values: ["  "] };
  const fine = { ...newDraft(["id"]), values: [""] };
  const r = filtersFromDrafts([fine, list, raw]);
  expect(r.filters).toEqual([]);
  expect(Object.keys(r.errors).sort()).toEqual([list.id, raw.id].sort());
  expect(r.errors[list.id]).toMatch(/empty value/);
});

test("an empty value is a legitimate single value", () => {
  const d = { ...newDraft(["note"]), values: [""] };
  expect(filtersFromDrafts([d]).filters).toEqual([{ column: "note", op: "eq", values: [""] }]);
});
