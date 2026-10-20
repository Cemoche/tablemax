import { describe, expect, test } from "vitest";
import type { Filter } from "./types";
import { formatQuickFilter, parseQuickFilter, readRawCondition } from "./quickFilter";
import { strings } from "./strings";

const cols = ["status", "total", "id", "name", "created_at", "notes", "order date", 'we"ird', "back`tick", "é名"];
const ok = (s: string, c = cols) => {
  const r = parseQuickFilter(s, c);
  expect(r.error).toBeNull();
  return r.filters;
};
const bad = (s: string, c = cols) => {
  const r = parseQuickFilter(s, c);
  expect(r.error).not.toBeNull();
  expect(r.filters).toEqual([]);
  return r.error as string;
};

describe("parseQuickFilter", () => {
  test("parses a compound quick filter", () => {
    expect(ok("status = paid and total > 100")).toEqual([
      { column: "status", op: "eq", values: ["paid"] },
      { column: "total", op: "gt", values: ["100"] },
    ]);
  });
  test("quoted values, IN, BETWEEN, IS NOT NULL", () => {
    expect(ok("name = 'O''Brien'")).toEqual([{ column: "name", op: "eq", values: ["O'Brien"] }]);
    expect(ok("id in (1, 2, 3)")).toEqual([{ column: "id", op: "in", values: ["1", "2", "3"] }]);
    expect(ok("created_at between '2025-01-01' and '2025-02-01'")).toEqual([
      { column: "created_at", op: "between", values: ["2025-01-01", "2025-02-01"] },
    ]);
    expect(ok("notes is not null")).toEqual([{ column: "notes", op: "isNotNull", values: [] }]);
    expect(ok("notes IS NULL")).toEqual([{ column: "notes", op: "isNull", values: [] }]);
  });
  test("unknown column and syntax errors", () => {
    expect(bad("nope = 1")).toBe('unknown column "nope"');
    bad("total >");
  });
  test("all comparison operators, <> and != both neq", () => {
    const ops = { "=": "eq", "!=": "neq", "<>": "neq", "<": "lt", ">": "gt", "<=": "lte", ">=": "gte" };
    for (const [sym, op] of Object.entries(ops)) {
      expect(ok(`total ${sym} 5`)).toEqual([{ column: "total", op, values: ["5"] }]);
      expect(ok(`total${sym}5`)).toEqual([{ column: "total", op, values: ["5"] }]);
    }
  });
  test("negation and pattern operators", () => {
    expect(ok("id not in (1)")).toEqual([{ column: "id", op: "notIn", values: ["1"] }]);
    expect(ok("id NOT BETWEEN 1 AND 5")).toEqual([{ column: "id", op: "notBetween", values: ["1", "5"] }]);
    expect(ok("name like 'a%'")).toEqual([{ column: "name", op: "like", values: ["a%"] }]);
    expect(ok("name not like 'a%'")).toEqual([{ column: "name", op: "notLike", values: ["a%"] }]);
    expect(ok("name ilike 'a%'")).toEqual([{ column: "name", op: "ilike", values: ["a%"] }]);
    expect(ok("name contains bob")).toEqual([{ column: "name", op: "contains", values: ["bob"] }]);
    expect(ok("name not contains bob")).toEqual([{ column: "name", op: "notContains", values: ["bob"] }]);
  });
  test("any column", () => {
    expect(ok("any contains foo")).toEqual([{ column: null, op: "contains", values: ["foo"] }]);
    expect(ok("ANY NOT CONTAINS foo")).toEqual([{ column: null, op: "notContains", values: ["foo"] }]);
    expect(ok("any = 5")).toEqual([{ column: null, op: "eq", values: ["5"] }]);
    expect(ok("any like 'a%'")).toEqual([{ column: null, op: "like", values: ["a%"] }]);
    bad("any > 5");
    bad("any in (1)");
    bad("any is null");
    bad("any not like x");
  });
  test('quoted "any" is a real column, bare any is the keyword', () => {
    expect(ok('"any" = 1', [...cols, "any"])).toEqual([{ column: "any", op: "eq", values: ["1"] }]);
    expect(ok("any = 1", [...cols, "any"])).toEqual([{ column: null, op: "eq", values: ["1"] }]);
  });
  test("empty and whitespace input", () => {
    expect(parseQuickFilter("", cols)).toEqual({ filters: [], error: null });
    expect(parseQuickFilter(" \n\t ", cols)).toEqual({ filters: [], error: null });
  });
  test("trailing, leading and doubled AND are errors", () => {
    bad("total > 1 and");
    bad("and total > 1");
    bad("total > 1 and and id = 2");
    bad("name = 'x' and");
  });
  test("junk after a condition is an error", () => {
    bad("total > 1 id = 2");
    bad("total > 1 or id = 2");
    bad("total = 1 2");
  });
  test("unbalanced quotes are errors", () => {
    bad("name = 'abc");
    bad("\"name = 1");
    bad("`name = 1");
    bad("name = \"abc");
  });
  test("values with spaces and whitespace/newlines", () => {
    expect(ok("name = 'John  Smith'")).toEqual([{ column: "name", op: "eq", values: ["John  Smith"] }]);
    expect(ok("  status\n=\n paid \t AND\n total   >   1  ")).toEqual([
      { column: "status", op: "eq", values: ["paid"] },
      { column: "total", op: "gt", values: ["1"] },
    ]);
    expect(ok("name = 'a\nb'")).toEqual([{ column: "name", op: "eq", values: ["a\nb"] }]);
  });
  test("double-quoted values, doubling escapes", () => {
    expect(ok('name = "say ""hi"""')).toEqual([{ column: "name", op: "eq", values: ['say "hi"'] }]);
  });
  test("negative numbers and decimals", () => {
    expect(ok("total > -5")).toEqual([{ column: "total", op: "gt", values: ["-5"] }]);
    expect(ok("total between -1.5 and 2.25")).toEqual([
      { column: "total", op: "between", values: ["-1.5", "2.25"] },
    ]);
    expect(ok("id in (-1, 2.5)")).toEqual([{ column: "id", op: "in", values: ["-1", "2.5"] }]);
  });
  test("quoted identifiers", () => {
    expect(ok('"order date" = x')).toEqual([{ column: "order date", op: "eq", values: ["x"] }]);
    expect(ok('"we""ird" = 1')).toEqual([{ column: 'we"ird', op: "eq", values: ["1"] }]);
    expect(ok("`back``tick` = 1")).toEqual([{ column: "back`tick", op: "eq", values: ["1"] }]);
    expect(ok("`order date` = 1")).toEqual([{ column: "order date", op: "eq", values: ["1"] }]);
  });
  test("unicode column names", () => {
    expect(ok("é名 = 1")).toEqual([{ column: "é名", op: "eq", values: ["1"] }]);
  });
  test("keywords case-insensitive; column match case-insensitive when unique", () => {
    expect(ok("STATUS Is Not NuLL AND Total BETWEEN 1 and 2")).toEqual([
      { column: "status", op: "isNotNull", values: [] },
      { column: "total", op: "between", values: ["1", "2"] },
    ]);
  });
  test("exact column match wins over case-insensitive", () => {
    expect(ok("Id = 1", ["id", "Id"])).toEqual([{ column: "Id", op: "eq", values: ["1"] }]);
  });
  test("ambiguous case-insensitive match is an error", () => {
    expect(bad("ID = 1", ["id", "Id"])).toMatch(/ambiguous/);
  });
  test("unknown column message keeps the written name", () => {
    expect(bad('"No Such" = 1')).toBe('unknown column "No Such"');
  });
  test("bare keywords are not values; quote them", () => {
    bad("status = and");
    expect(bad("status = null")).toMatch(/IS NULL/);
    expect(bad("status = in")).toMatch(/quote it/);
    expect(ok("status = 'and'")).toEqual([{ column: "status", op: "eq", values: ["and"] }]);
    expect(ok("status = 'null'")).toEqual([{ column: "status", op: "eq", values: ["null"] }]);
  });
  test("a quoted 'and' is not the AND keyword", () => {
    expect(bad("total > 1 'and' id = 2")).toBe("expected AND, found 'and'");
    expect(bad("status 't'")).toBe("expected an operator, found 't'");
  });
  test("malformed lists and ranges", () => {
    bad("id in ()");
    bad("id in (1,)");
    bad("id in (,1)");
    bad("id in (1 2)");
    bad("id in (1, 2");
    bad("id in 1");
    bad("id between 1");
    bad("id between 1 and");
    bad("id between 1 2");
    bad("id is 5");
    bad("id is not");
    bad("id not");
    bad("id not = 1");
    bad("id not ilike x");
    bad("id == 1");
    bad("id ! 1");
    bad("id =");
    bad("id");
    bad("= 1");
    bad("id = (1)");
  });
  test("a BETWEEN's AND does not end the condition", () => {
    expect(ok("id between 1 and 2 and total > 3")).toEqual([
      { column: "id", op: "between", values: ["1", "2"] },
      { column: "total", op: "gt", values: ["3"] },
    ]);
  });
});

describe("formatQuickFilter", () => {
  const all: Filter[] = [
    { column: "status", op: "eq", values: ["paid"] },
    { column: "total", op: "neq", values: ["5"] },
    { column: "total", op: "lt", values: ["-5.5"] },
    { column: "total", op: "gt", values: ["1"] },
    { column: "total", op: "lte", values: ["1"] },
    { column: "total", op: "gte", values: ["1"] },
    { column: "id", op: "in", values: ["1", "two words", "O'Brien"] },
    { column: "id", op: "notIn", values: ["1"] },
    { column: "id", op: "between", values: ["1", "2"] },
    { column: "id", op: "notBetween", values: ["a b", "c"] },
    { column: "name", op: "like", values: ["a%"] },
    { column: "name", op: "notLike", values: ["a%"] },
    { column: "name", op: "ilike", values: ["a%"] },
    { column: "name", op: "contains", values: ["x"] },
    { column: "name", op: "notContains", values: ["x"] },
    { column: "notes", op: "isNull", values: [] },
    { column: "notes", op: "isNotNull", values: [] },
    { column: null, op: "contains", values: ["foo bar"] },
    { column: null, op: "notContains", values: ["foo"] },
    { column: null, op: "eq", values: ["foo"] },
    { column: null, op: "like", values: ["f%"] },
    { column: "order date", op: "eq", values: ["x"] },
    { column: 'we"ird', op: "eq", values: ["1"] },
    { column: "back`tick", op: "eq", values: ["1"] },
    { column: "é名", op: "eq", values: ["1"] },
    { column: "any", op: "eq", values: ["1"] },
    { column: "and", op: "eq", values: ["1"] },
  ];
  test("round-trips every op", () => {
    const columns = [...cols, "any", "and"];
    for (const f of all) {
      const text = formatQuickFilter([f]);
      const r = parseQuickFilter(text, columns);
      expect({ text, error: r.error, filters: r.filters }).toEqual({ text, error: null, filters: [f] });
    }
    const r = parseQuickFilter(formatQuickFilter(all), columns);
    expect(r.error).toBeNull();
    expect(r.filters).toEqual(all);
  });
  test("round-trips awkward values", () => {
    const vals = ["", " ", "and", "AND", "null", "it's", 'say "hi"', "a\nb", "-5", "1.5", "1e5", "a,b", "(x)", "x=y", "é", "-", "--"];
    for (const v of vals) {
      const f: Filter = { column: "name", op: "eq", values: [v] };
      const r = parseQuickFilter(formatQuickFilter([f]), cols);
      expect({ v, error: r.error, filters: r.filters }).toEqual({ v, error: null, filters: [f] });
    }
    const f: Filter = { column: "id", op: "in", values: vals };
    expect(parseQuickFilter(formatQuickFilter([f]), cols).filters).toEqual([f]);
  });
  test("quotes only when needed", () => {
    expect(formatQuickFilter([{ column: "status", op: "eq", values: ["paid"] }])).toBe("status = paid");
    expect(formatQuickFilter([{ column: "status", op: "eq", values: ["100"] }])).toBe("status = 100");
    expect(formatQuickFilter([{ column: "status", op: "eq", values: ["a b"] }])).toBe("status = 'a b'");
    expect(formatQuickFilter([{ column: "status", op: "eq", values: [""] }])).toBe("status = ''");
    expect(formatQuickFilter([{ column: "order date", op: "eq", values: ["x"] }])).toBe('"order date" = x');
  });
  test("empty list formats to an empty string", () => {
    expect(formatQuickFilter([])).toBe("");
  });
  test("raw is shown in parentheses", () => {
    const raw: Filter = { column: null, op: "raw", values: ["a > 1 OR b"] };
    expect(formatQuickFilter([raw])).toBe("(a > 1 OR b)");
  });
  test("filters joined by OR read with OR", () => {
    const two: Filter[] = [
      { column: "status", op: "eq", values: ["paid"] },
      { column: "total", op: "gt", values: ["5"] },
    ];
    expect(formatQuickFilter(two, "or")).toBe("status = paid OR total > 5");
    expect(formatQuickFilter(two, "and")).toBe("status = paid AND total > 5");
  });
});

/** The filters a Raw SQL row gives (or its reading when it is an error). */
const rawConditionFilters = (...a: Parameters<typeof readRawCondition>) => {
  const r = readRawCondition(...a);
  return r.kind === "error" ? r : r.filters;
};

describe("readRawCondition", () => {
  const columns = ["id", "status", "total", "cost", "note"];
  const sql = (text: string): Filter[] => [{ column: null, op: "raw", values: [text] }];
  test("raw_sql_mode_uses_quick_syntax: one quick condition becomes a bound filter", () => {
    expect(rawConditionFilters("status = 'paid'", columns)).toEqual([
      { column: "status", op: "eq", values: ["paid"] },
    ]);
    expect(rawConditionFilters("note contains x", columns)).toEqual([
      { column: "note", op: "contains", values: ["x"] },
    ]);
    expect(rawConditionFilters("any contains 'foo bar'", columns)).toEqual([
      { column: null, op: "contains", values: ["foo bar"] },
    ]);
    expect(rawConditionFilters("ID IN (1, 2)", columns)).toEqual([{ column: "id", op: "in", values: ["1", "2"] }]);
    // A bare word that is not a column is a value, as in the quick filter.
    expect(rawConditionFilters("status = paid", columns)).toEqual([
      { column: "status", op: "eq", values: ["paid"] },
    ]);
    // Several conditions joined by AND are bound one by one when the filters are ANDed.
    expect(rawConditionFilters("status = 'paid' AND total > 5", columns, "and")).toEqual([
      { column: "status", op: "eq", values: ["paid"] },
      { column: "total", op: "gt", values: ["5"] },
    ]);
  });
  test("anything else is the user's SQL, as typed", () => {
    // Two columns compared: SQL, not the text "cost".
    expect(rawConditionFilters("total = cost", columns)).toEqual(sql("total = cost"));
    // "…" is an identifier in SQL (or a string, per engine): the engine decides.
    expect(rawConditionFilters('status = "paid"', columns)).toEqual(sql('status = "paid"'));
    expect(rawConditionFilters("total > 2 * cost", columns)).toEqual(sql("total > 2 * cost"));
    expect(rawConditionFilters("status NOT ILIKE 'p%'", columns)).toEqual(sql("status NOT ILIKE 'p%'"));
    expect(rawConditionFilters("created < current_date", ["created"])).toEqual(sql("created < current_date"));
    expect(rawConditionFilters("nope = 1", columns)).toEqual(sql("nope = 1"));
    // Words SQL reads as expressions or keywords are never bound as text.
    const more = ["active", "price", "x", ...columns];
    expect(rawConditionFilters("active = true", more)).toEqual(sql("active = true"));
    expect(rawConditionFilters("active = FALSE", more)).toEqual(sql("active = FALSE"));
    expect(rawConditionFilters("active = unknown", more)).toEqual(sql("active = unknown"));
    expect(rawConditionFilters("total = default", more)).toEqual(sql("total = default"));
    expect(rawConditionFilters("total > cost+1", more)).toEqual(sql("total > cost+1"));
    expect(rawConditionFilters("price > t.cost", more)).toEqual(sql("price > t.cost"));
    expect(rawConditionFilters("x > -cost", more)).toEqual(sql("x > -cost"));
    expect(rawConditionFilters("total > cost*2", more)).toEqual(sql("total > cost*2"));
    expect(rawConditionFilters("note = a||b", more)).toEqual(sql("note = a||b"));
    expect(rawConditionFilters("total > 10/2", more)).toEqual(sql("total > 10/2"));
    // A column inside a word with - or :, a cast, a hex literal.
    expect(rawConditionFilters("total > cost-1", more)).toEqual(sql("total > cost-1"));
    expect(rawConditionFilters("total > 1-COST", more)).toEqual(sql("total > 1-COST"));
    expect(rawConditionFilters("note = cost::text", more)).toEqual(sql("note = cost::text"));
    expect(rawConditionFilters("note = 'x'::text", more)).toEqual(sql("note = 'x'::text"));
    expect(rawConditionFilters("note = abc::text", more)).toEqual(sql("note = abc::text"));
    expect(rawConditionFilters("total > cost:1", more)).toEqual(sql("total > cost:1"));
    expect(rawConditionFilters("total > 0x1F", more)).toEqual(sql("total > 0x1F"));
    expect(rawConditionFilters("total > 0X1f", more)).toEqual(sql("total > 0X1f"));
    // A plain word, a number, a date or a pattern stays a bound value.
    expect(rawConditionFilters("status = paid", more)).toEqual([{ column: "status", op: "eq", values: ["paid"] }]);
    expect(rawConditionFilters("total > -5", more)).toEqual([{ column: "total", op: "gt", values: ["-5"] }]);
    expect(rawConditionFilters("note like a%", more)).toEqual([{ column: "note", op: "like", values: ["a%"] }]);
    expect(rawConditionFilters("note = 2024-01-31", more)).toEqual([
      { column: "note", op: "eq", values: ["2024-01-31"] },
    ]);
    expect(rawConditionFilters("note = 12:30", more)).toEqual([{ column: "note", op: "eq", values: ["12:30"] }]);
    expect(rawConditionFilters("note = paid-up", more)).toEqual([{ column: "note", op: "eq", values: ["paid-up"] }]);
    // Under OR the conditions of one row must stay together: the SQL keeps them so.
    expect(rawConditionFilters("status = 'paid' AND total > 5", columns, "or")).toEqual(
      sql("status = 'paid' AND total > 5"),
    );
    // SQL-compatible conditions written together stay valid SQL under OR.
    expect(readRawCondition("status = 'paid' AND total > 5", columns, "or").kind).toBe("sql");
    // One condition reads the same under OR.
    expect(rawConditionFilters("total > 5", columns, "or")).toEqual([{ column: "total", op: "gt", values: ["5"] }]);
  });
});

describe("readRawCondition: how a row is read", () => {
  const columns = ["id", "status", "notes"];
  test("bound filters, SQL as written, or an error", () => {
    expect(readRawCondition("notes contains 'x'", columns).kind).toBe("bound");
    expect(readRawCondition("id % 2 = 0", columns).kind).toBe("sql");
    expect(readRawCondition("notes contains 'x' AND id = 1", columns, "and").kind).toBe("bound");
  });
  test("under OR, several conditions only the filter syntax knows must be written as SQL", () => {
    for (const text of [
      "notes contains 'x' AND id = 1",
      "notes not contains 'x' AND id = 1",
      "any = 'x' AND id = 1",
      // A bare word is text for the filter syntax, a name for SQL.
      "status = paid AND id = 1",
      // "…" / `…` column names: not every engine reads them as names (MySQL: "…" is text).
      '"id" > 5 AND status = \'x\'',
      "`id` > 5 AND status = 'x'",
    ]) {
      expect(readRawCondition(text, columns, "or"), text).toEqual({
        kind: "error",
        message: strings.filters.rawOrNeedsSql,
      });
    }
  });
});

test("a Raw SQL row the filter syntax cannot even split (an open quote) is SQL as written", () => {
  expect(readRawCondition("note = 'it", ["note"])).toEqual({
    kind: "sql",
    filters: [{ column: null, op: "raw", values: ["note = 'it"] }],
  });
});
