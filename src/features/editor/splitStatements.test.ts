import { expect, test } from "vitest";
import { splitStatements, statementAt } from "./splitStatements";

const texts = (sql: string, d: Parameters<typeof splitStatements>[1] = "postgres") =>
  splitStatements(sql, d).map((s) => s.text);

test("splits on semicolons outside strings and comments", () => {
  expect(texts("select ';'; -- a;b\nselect 2")).toEqual(["select ';'", "-- a;b\nselect 2"]);
});

test("handles doubled quotes and quoted identifiers", () => {
  expect(texts(`select 'it''s;'; select "a;b"`)).toEqual([`select 'it''s;'`, `select "a;b"`]);
});

test("handles PG dollar quoting", () => {
  const sql = "create function f() returns int as $$ select 1; $$ language sql; select 2";
  expect(texts(sql)).toEqual([
    "create function f() returns int as $$ select 1; $$ language sql",
    "select 2",
  ]);
  expect(texts("do $fn$ begin x; $$ y; end $fn$; select 3")).toEqual([
    "do $fn$ begin x; $$ y; end $fn$",
    "select 3",
  ]);
});

test("dollar quoting is PG only and $1 params are not tags", () => {
  expect(texts("select $$a; select 2", "mySql")).toEqual(["select $$a", "select 2"]);
  expect(texts("select $1; select $2")).toEqual(["select $1", "select $2"]);
});

test("handles MySQL backticks, # comments and backslash escapes", () => {
  expect(texts("select `a;b`; select 1 # x; y\n; select 'a\\';b'", "mySql")).toEqual([
    "select `a;b`",
    "select 1 # x; y",
    "select 'a\\';b'",
  ]);
});

test("# is not a comment outside MySQL, backslash is not an escape outside MySQL", () => {
  expect(texts("select 1 # 2; select 3")).toEqual(["select 1 # 2", "select 3"]);
  expect(texts("select 'a\\'; select 2")).toEqual(["select 'a\\'", "select 2"]);
});

test("block comments hide semicolons", () => {
  expect(texts("select 1 /* ; */ ; select 2", "sqlite")).toEqual(["select 1 /* ; */", "select 2"]);
});

test("ignores empty statements, comment-only tails and empty input", () => {
  expect(texts("")).toEqual([]);
  expect(texts("  ;; ;\n")).toEqual([]);
  expect(texts("select 1; -- done")).toEqual(["select 1"]);
  expect(texts("select 1; /* x */")).toEqual(["select 1"]);
});

test("offsets point into the original string", () => {
  const sql = "  select 1 ;\n\n  select 2";
  const st = splitStatements(sql, "sqlite");
  expect(st).toEqual([
    { text: "select 1", from: 2, to: 10 },
    { text: "select 2", from: 16, to: 24 },
  ]);
  for (const s of st) expect(sql.slice(s.from, s.to)).toBe(s.text);
});

test("statementAt picks the statement under the cursor, else the previous one", () => {
  const sql = "select 1;\n\nselect 2;\n\n";
  const st = splitStatements(sql, "postgres");
  expect(statementAt(st, 3)?.text).toBe("select 1");
  expect(statementAt(st, 8)?.text).toBe("select 1"); // right before ';'
  expect(statementAt(st, 10)?.text).toBe("select 1"); // blank line between -> previous
  expect(statementAt(st, 12)?.text).toBe("select 2");
  expect(statementAt(st, sql.length)?.text).toBe("select 2");
  expect(statementAt([], 0)).toBeNull();
  expect(statementAt(splitStatements("\n\nselect 1", "postgres"), 0)).toBeNull();
});

test("MySQL executable comments are code, other block comments are not", () => {
  expect(texts("/*!40014 SET FOREIGN_KEY_CHECKS=0 */;", "mySql")).toEqual([
    "/*!40014 SET FOREIGN_KEY_CHECKS=0 */",
  ]);
  expect(texts("/*M!100101 SET x=1 */; select 1", "mySql")).toEqual([
    "/*M!100101 SET x=1 */",
    "select 1",
  ]);
  // Plain comments, and `/*!` outside MySQL, stay comment-only.
  expect(texts("/* note */; select 1", "mySql")).toEqual(["select 1"]);
  expect(texts("/*! not special */; select 1", "postgres")).toEqual(["select 1"]);
});
