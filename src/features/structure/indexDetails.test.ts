import { expect, test } from "vitest";
import { indexDetails } from "./indexDetails";

test("PostgreSQL: the access method and a partial index's condition", () => {
  expect(indexDetails("CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)")).toEqual({
    type: "btree",
    condition: "",
  });
  expect(
    indexDetails("CREATE INDEX open_idx ON public.orders USING hash (status) WHERE (status <> 'closed'::text)"),
  ).toEqual({ type: "hash", condition: "(status <> 'closed'::text)" });
  // INCLUDE and NULLS NOT DISTINCT sit before the condition.
  expect(
    indexDetails("CREATE UNIQUE INDEX u ON t USING btree (a) INCLUDE (b) NULLS NOT DISTINCT WHERE (a > 0)"),
  ).toEqual({ type: "btree", condition: "(a > 0)" });
});

test("SQLite: no access method; the condition as written, keywords in any case", () => {
  expect(indexDetails("CREATE INDEX note_idx ON items(note) where note IS NOT NULL")).toEqual({
    type: "",
    condition: "note IS NOT NULL",
  });
  expect(indexDetails("CREATE INDEX a ON t (a)\nWHERE\n  a > 1")).toEqual({ type: "", condition: "a > 1" });
});

test("WHERE or USING inside quotes, identifiers or the column list is not the index's", () => {
  expect(indexDetails(`CREATE INDEX "where using x" ON "where"("using", (a || ' where '))`)).toEqual({
    type: "",
    condition: "",
  });
  expect(indexDetails("CREATE INDEX i ON t USING gin ((data -> 'where')) WHERE (data ? 'using')")).toEqual({
    type: "gin",
    condition: "(data ? 'using')",
  });
});

test("no definition (MySQL, SQLite automatic indexes): nothing to show", () => {
  expect(indexDetails(null)).toEqual({ type: "", condition: "" });
  expect(indexDetails("")).toEqual({ type: "", condition: "" });
});
