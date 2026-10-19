import { describe, expect, test } from "vitest";
import type { Dialect } from "../../lib/types";
import { applyAutoLimit } from "./autoLimit";

const pg = (sql: string, limit = 1000) => applyAutoLimit(sql, "postgres", limit);

describe("applyAutoLimit adds a LIMIT to a top-level SELECT", () => {
  test("simple SELECT", () => {
    expect(pg("select * from t")).toBe("select * from t LIMIT 1000");
    expect(pg("SELECT 1", 50)).toBe("SELECT 1 LIMIT 50");
  });

  test("before a final semicolon", () => {
    expect(pg("select * from t;")).toBe("select * from t LIMIT 1000;");
    expect(pg("select * from t ;  ")).toBe("select * from t LIMIT 1000 ;  ");
  });

  test("before trailing comments, which stay in place", () => {
    expect(pg("select * from t -- note")).toBe("select * from t LIMIT 1000 -- note");
    expect(pg("select * from t /* a */ ; -- b")).toBe("select * from t LIMIT 1000 /* a */ ; -- b");
    expect(pg("select 1 -- limit 5")).toBe("select 1 LIMIT 1000 -- limit 5");
    expect(applyAutoLimit("select 1 # limit 5", "mySql", 1000)).toBe("select 1 LIMIT 1000 # limit 5");
    expect(pg("-- head\nselect 1")).toBe("-- head\nselect 1 LIMIT 1000");
  });

  test("CTE whose main statement is a SELECT", () => {
    expect(pg("with x as (select 1 limit 5) select * from x")).toBe(
      "with x as (select 1 limit 5) select * from x LIMIT 1000",
    );
    expect(pg("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r")).toBe(
      "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r LIMIT 1000",
    );
    expect(pg("with a as materialized (select 1), b as (select 2) select * from a, b")).toBe(
      "with a as materialized (select 1), b as (select 2) select * from a, b LIMIT 1000",
    );
  });

  test("a LIMIT inside a subquery does not count", () => {
    expect(pg("select * from (select * from t limit 5) s")).toBe(
      "select * from (select * from t limit 5) s LIMIT 1000",
    );
    expect(pg("select * from t where a in (select a from u fetch first 1 row only)")).toBe(
      "select * from t where a in (select a from u fetch first 1 row only) LIMIT 1000",
    );
  });

  test("a whole UNION is limited", () => {
    expect(pg("select 1 union select 2")).toBe("select 1 union select 2 LIMIT 1000");
  });

  test("before OFFSET and locking clauses", () => {
    expect(pg("select * from t offset 5")).toBe("select * from t LIMIT 1000 offset 5");
    expect(pg("select * from t for update")).toBe("select * from t LIMIT 1000 for update");
    expect(pg("select * from t for no key update of t nowait;")).toBe(
      "select * from t LIMIT 1000 for no key update of t nowait;",
    );
    expect(pg("select * from t for share")).toBe("select * from t LIMIT 1000 for share");
    expect(applyAutoLimit("select * from t lock in share mode", "mySql", 1000)).toBe(
      "select * from t LIMIT 1000 lock in share mode",
    );
  });

  test("strings, quoted identifiers and dollar quotes do not confuse the scanner", () => {
    expect(pg("select 'limit 1;' from t")).toBe("select 'limit 1;' from t LIMIT 1000");
    expect(pg('select "limit" from t')).toBe('select "limit" from t LIMIT 1000');
    expect(pg("select $$ limit 1; ) $$ as x")).toBe("select $$ limit 1; ) $$ as x LIMIT 1000");
    expect(pg("select E'it\\'s (limit' from t")).toBe("select E'it\\'s (limit' from t LIMIT 1000");
    expect(applyAutoLimit("select `limit` from t", "mySql", 1000)).toBe("select `limit` from t LIMIT 1000");
    expect(applyAutoLimit("select 'a\\' limit 1' from t", "mySql", 1000)).toBe(
      "select 'a\\' limit 1' from t LIMIT 1000",
    );
    expect(applyAutoLimit("select [limit] from t", "sqlite", 1000)).toBe("select [limit] from t LIMIT 1000");
  });

  test("same syntax for every dialect", () => {
    for (const d of ["postgres", "mySql", "sqlite"] as Dialect[]) {
      expect(applyAutoLimit("select * from t", d, 1000)).toBe("select * from t LIMIT 1000");
    }
  });
});

describe("applyAutoLimit leaves other statements unchanged", () => {
  const same = (sql: string, dialect: Dialect = "postgres") =>
    expect(applyAutoLimit(sql, dialect, 1000)).toBe(sql);

  test("already limited", () => {
    same("select * from t limit 10");
    same("select * from t LIMIT 10 OFFSET 5;");
    same("select * from t limit 5, 10", "mySql");
    same("select * from t order by a fetch first 5 rows only");
    same("select * from t offset 5 rows fetch next 5 rows only");
  });

  test("non-SELECT statements", () => {
    same("update t set a = 1");
    same("insert into t select * from u");
    same("delete from t");
    same("explain select * from t");
    same("with x as (select 1) insert into t select * from x");
    same("with x as (select 1) delete from t");
    same("create table t (a int)");
    same("values (1), (2)");
    same("(select 1) union (select 2)");
    same("");
    same("-- only a comment");
  });

  test("SELECT … INTO", () => {
    same("select a into b from t");
    same("select a from t into @x", "mySql");
    same("select * into outfile '/tmp/x' from t", "mySql");
  });

  test("anything the scanner cannot vouch for", () => {
    same("select (1 from t");
    same("select 1; select 2");
    same("select 1 /*! limit 1 */", "mySql");
    same("select 'unterminated");
  });
});

describe("applyAutoLimit never mistakes an identifier for a clause", () => {
  const al = (sql: string, dialect: Dialect) => applyAutoLimit(sql, dialect, 1000);

  test("offset used as a column is left alone (fail safe) or limited at the end", () => {
    expect(al("select offset, id from t", "mySql")).toBe("select offset, id from t");
    expect(al("select offset from t", "sqlite")).toBe("select offset from t");
    expect(al("select * from t order by offset", "mySql")).toBe("select * from t order by offset");
    expect(al("select * from t where offset = 1", "sqlite")).toBe("select * from t where offset = 1");
    for (const d of ["postgres", "mySql", "sqlite"] as Dialect[]) {
      expect(al("select t.offset from t", d)).toBe("select t.offset from t LIMIT 1000");
      expect(al("select t.limit, t.fetch, t.into from t", d)).toBe("select t.limit, t.fetch, t.into from t LIMIT 1000");
    }
  });

  test("OFFSET with a value is still a clause", () => {
    expect(al("select * from t offset $1", "postgres")).toBe("select * from t LIMIT 1000 offset $1");
    expect(al("select * from t offset (2 * 5)", "postgres")).toBe("select * from t LIMIT 1000 offset (2 * 5)");
    expect(al("select * from t offset :n", "sqlite")).toBe("select * from t LIMIT 1000 offset :n");
    expect(al("select * from t offset ?", "sqlite")).toBe("select * from t LIMIT 1000 offset ?");
  });

  test("lock and for used as identifiers", () => {
    expect(al("select * from t where lock in (1,2)", "postgres")).toBe("select * from t where lock in (1,2) LIMIT 1000");
    expect(al("select * from t where lock in (1,2)", "sqlite")).toBe("select * from t where lock in (1,2) LIMIT 1000");
    expect(al("select * from t where lock in (1,2)", "mySql")).toBe("select * from t where lock in (1,2) LIMIT 1000");
    expect(al("select t.lock, t.for from t", "mySql")).toBe("select t.lock, t.for from t LIMIT 1000");
    expect(al("select * from t for key share", "postgres")).toBe("select * from t LIMIT 1000 for key share");
  });

  test("a locking clause before OFFSET leaves the statement alone", () => {
    expect(al("select * from t for update offset 5", "postgres")).toBe("select * from t for update offset 5");
    expect(al("select * from t offset 5 for update", "postgres")).toBe("select * from t LIMIT 1000 offset 5 for update");
  });
});
