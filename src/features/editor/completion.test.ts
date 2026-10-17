import { type Completion, CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, test, vi } from "vitest";
import type { Catalog, CatalogTable } from "../../lib/types";
import { buildCompletionSource } from "./completion";

const table = (name: string, columns: string[], kind: CatalogTable["kind"] = "table"): CatalogTable => ({
  name,
  kind,
  columns: columns.map((c) => ({ name: c, typeName: "int4" })),
});

const pgCatalog: Catalog = {
  schema: "public",
  tables: [
    table("customers", ["id", "name"]),
    table("order", ["id", "total", "MyCol"]),
    table("orders", ["id", "customer_id"]),
    table("a\"b", ["x"]),
  ],
};

const myCatalog: Catalog = {
  schema: "shop",
  tables: [table("my table", ["id", "a b"]), table("orders", ["id", "status"])],
};

/** Runs `source` with the cursor at `|` in `doc`. */
async function complete(source: CompletionSource, doc: string, explicit = false) {
  const pos = doc.indexOf("|");
  const text = doc.slice(0, pos) + doc.slice(pos + 1);
  const state = EditorState.create({ doc: text, selection: { anchor: pos } });
  return (await source(new CompletionContext(state, pos, explicit))) as CompletionResult | null;
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];
const option = (r: CompletionResult | null, label: string): Completion => {
  const o = r?.options.find((x) => x.label === label);
  if (!o) throw new Error(`no option ${label} in ${labels(r).join(", ")}`);
  return o;
};
/** The text an option inserts. */
const inserted = (r: CompletionResult | null, label: string) => {
  const o = option(r, label);
  return typeof o.apply === "string" ? o.apply : o.label;
};

describe("completion_resolves_aliases", () => {
  const pg = buildCompletionSource(pgCatalog, "postgres");
  const my = buildCompletionSource(myCatalog, "mySql");

  test('select o.| from "order" o → the columns of "order"', async () => {
    const r = await complete(pg, 'select o.| from "order" o');
    expect(labels(r)).toEqual(["id", "total", "MyCol"]);
    expect(r?.from).toBe("select o.".length);
    expect(inserted(r, "MyCol")).toBe('"MyCol"');
    expect(inserted(r, "total")).toBe("total");
  });

  test("select t.| from `my table` t (MySQL)", async () => {
    const r = await complete(my, "select t.| from `my table` t");
    expect(labels(r)).toEqual(["id", "a b"]);
    expect(inserted(r, "a b")).toBe("`a b`");
  });

  test("JOIN … AS alias, and a typed prefix", async () => {
    const r = await complete(pg, "select c.na| from orders o join customers AS c on c.id = o.customer_id");
    expect(labels(r)).toEqual(["id", "name"]);
    expect(r?.from).toBe("select c.".length);
  });

  test("FROM t AS a, JOIN t a, comma joins and schema-qualified tables", async () => {
    expect(labels(await complete(pg, "select a.| from customers as a"))).toEqual(["id", "name"]);
    expect(labels(await complete(pg, "select * from orders o left join customers c on c.| "))).toEqual([
      "id",
      "name",
    ]);
    expect(labels(await complete(pg, "select y.| from orders x, customers y"))).toEqual(["id", "name"]);
    expect(labels(await complete(pg, "select x.| from orders x, customers y"))).toEqual(["id", "customer_id"]);
    expect(labels(await complete(pg, "select c.| from public.customers c"))).toEqual(["id", "name"]);
    expect(labels(await complete(pg, 'select c.| from "public"."customers" c'))).toEqual(["id", "name"]);
  });

  test("quoted aliases and identifiers with doubled quotes", async () => {
    expect(labels(await complete(pg, 'select "my alias".| from customers "my alias"'))).toEqual(["id", "name"]);
    expect(labels(await complete(pg, 'select z.| from "a""b" z'))).toEqual(["x"]);
    expect(labels(await complete(my, "select `t``x`.| from orders `t``x`"))).toEqual(["id", "status"]);
  });

  test("a bare table name used as a qualifier resolves to that table", async () => {
    expect(labels(await complete(pg, "select orders.| from orders"))).toEqual(["id", "customer_id"]);
    expect(labels(await complete(pg, 'select "order".| from "order"'))).toEqual(["id", "total", "MyCol"]);
    // Unquoted names fold to lower case in PostgreSQL.
    expect(labels(await complete(pg, "select ORDERS.| from ORDERS"))).toEqual(["id", "customer_id"]);
  });

  test("aliases are scoped to the current statement", async () => {
    const r = await complete(pg, "select * from orders o; select o.| from customers o; select * from \"order\" o");
    expect(labels(r)).toEqual(["id", "name"]);
    // A `;` inside a string does not end the statement.
    expect(labels(await complete(pg, "select ';', o.| from customers o"))).toEqual(["id", "name"]);
  });

  test("nothing inside strings or comments, or for an unknown qualifier", async () => {
    expect(await complete(pg, "select 'o.|' from customers o")).toBeNull();
    expect(await complete(pg, "select 1 -- o.|\nfrom customers o")).toBeNull();
    expect(await complete(pg, "select /* o.| */ 1 from customers o")).toBeNull();
    expect(labels(await complete(pg, "select nope.| from customers o"))).toEqual([]);
  });
});

describe("completion outside a qualifier", () => {
  const pg = buildCompletionSource(pgCatalog, "postgres");

  test("tables, quoted on insert when needed, and dialect keywords", async () => {
    const r = await complete(pg, "select * from ord|");
    expect(r?.from).toBe("select * from ".length);
    expect(labels(r)).toEqual(expect.arrayContaining(["order", "orders", "customers", "SELECT"]));
    expect(inserted(r, "order")).toBe('"order"');
    expect(inserted(r, "orders")).toBe("orders");
    expect(inserted(r, 'a"b')).toBe('"a""b"');
    expect(r?.validFor).toBeDefined();
  });

  test("keywords come from the dialect", async () => {
    const my = buildCompletionSource(null, "mySql");
    expect(labels(await complete(my, "sel|"))).toContain("SELECT");
    expect(labels(await complete(my, "sel|"))).toContain("STRAIGHT_JOIN");
    expect(labels(await complete(pg, "sel|"))).not.toContain("STRAIGHT_JOIN");
  });

  test("columns of the statement's tables are offered too", async () => {
    const r = await complete(pg, "select tot| from \"order\" o");
    expect(labels(r)).toContain("total");
    expect(inserted(r, "MyCol")).toBe('"MyCol"');
  });

  test("no popup on whitespace unless asked for", async () => {
    expect(await complete(pg, "select |")).toBeNull();
    expect(labels(await complete(pg, "select |", true))).toContain("customers");
  });

  test("without a catalog, keywords only", async () => {
    const r = await complete(buildCompletionSource(null, "postgres"), "sel|");
    expect(labels(r)).toContain("SELECT");
  });
});

describe("tables of other schemas", () => {
  const audit: Catalog = { schema: "audit", tables: [table("Log", ["at"]), table("events", ["id"])] };

  test("are prefixed with their schema", async () => {
    const src = buildCompletionSource(pgCatalog, "postgres", { otherCatalogs: [audit] });
    const r = await complete(src, "select * from ev|");
    expect(labels(r)).toContain("audit.events");
    expect(inserted(r, "audit.events")).toBe("audit.events");
    expect(inserted(r, "audit.Log")).toBe('audit."Log"');
    expect(labels(r)).not.toContain("events");
  });

  test("schema. offers that schema's tables, and its columns after schema.table.", async () => {
    const src = buildCompletionSource(pgCatalog, "postgres", { otherCatalogs: [audit] });
    expect(labels(await complete(src, "select * from audit.|"))).toEqual(["Log", "events"]);
    expect(labels(await complete(src, "select l.| from audit.\"Log\" l"))).toEqual(["at"]);
    expect(labels(await complete(src, "select audit.events.| from audit.events"))).toEqual(["id"]);
  });

  test("an unloaded schema is loaded when typed as a qualifier", async () => {
    const loadSchema = vi.fn().mockResolvedValue(audit);
    const src = buildCompletionSource(pgCatalog, "postgres", { schemas: ["public", "audit"], loadSchema });
    expect(labels(await complete(src, "select * from audit.|"))).toEqual(["Log", "events"]);
    expect(loadSchema).toHaveBeenCalledWith("audit");
    // Unknown schemas are never fetched.
    expect(labels(await complete(src, "select * from nope.|"))).toEqual([]);
    expect(loadSchema).toHaveBeenCalledTimes(1);
  });

  test("schema names are offered", async () => {
    const src = buildCompletionSource(pgCatalog, "postgres", { schemas: ["public", "audit"] });
    expect(labels(await complete(src, "select * from au|"))).toContain("audit");
  });
});

describe("inside a quoted identifier", () => {
  const pg = buildCompletionSource(pgCatalog, "postgres");

  test("between auto-closed quotes: the name is inserted escaped, without extra quotes", async () => {
    const r = await complete(pg, 'select * from "ord|"');
    expect(r?.from).toBe('select * from "'.length);
    expect(r?.to).toBe('select * from "ord'.length);
    expect(inserted(r, "order")).toBe("order");
    expect(inserted(r, 'a"b')).toBe('a""b');
    expect(labels(r)).not.toContain("SELECT");
  });

  test("an unclosed quote is closed on insert", async () => {
    const r = await complete(pg, 'select o."My|');
    expect(r).toBeNull(); // no FROM yet: o is unknown
    const r2 = await complete(pg, 'select * from "order" o where o."My|');
    expect(inserted(r2, "MyCol")).toBe('MyCol"');
  });
});

test("dollar quotes and semicolons inside them do not cut the statement", async () => {
  const pg = buildCompletionSource(pgCatalog, "postgres");
  const r = await complete(pg, "select $$ a; b $$, o.| from customers o");
  expect(labels(r)).toEqual(["id", "name"]);
});
