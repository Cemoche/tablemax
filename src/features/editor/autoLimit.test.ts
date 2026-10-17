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
