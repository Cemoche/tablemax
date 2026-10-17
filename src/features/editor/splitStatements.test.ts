import { expect, test } from "vitest";
import { delimiterAt, splitStatements, statementAt } from "./splitStatements";

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

// ---- Plan 4 Task 8: DELIMITER and compound bodies ----

test("DELIMITER // procedure -> the 2 expected statements, without the DELIMITER lines", () => {
  const body = "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND";
  const sql = `DELIMITER //\n${body} //\nDELIMITER ;\nCALL p();\n`;
  const st = splitStatements(sql, "mySql");
  expect(st.map((s) => s.text)).toEqual([body, "CALL p()"]);
  for (const s of st) expect(sql.slice(s.from, s.to)).toBe(s.text);
});

test("DELIMITER is case-insensitive, may be indented and accepts any token", () => {
  const sql = "  delimiter $$\nselect 1; select 2 $$\n\tDeLiMiTeR ;\nselect 3";
  expect(texts(sql, "mySql")).toEqual(["select 1; select 2", "select 3"]);
  expect(texts("DELIMITER ;;\nselect 1;;\nselect 2;;", "mySql")).toEqual(["select 1", "select 2"]);
});

test("the custom delimiter is ignored inside strings, identifiers and comments", () => {
  const sql = "DELIMITER //\nselect '//', `a//b` /* // */ //\n-- //\nselect 2 //";
  expect(texts(sql, "mySql")).toEqual(["select '//', `a//b` /* // */", "-- //\nselect 2"]);
});

test("DELIMITER is MySQL only and only at the start of a statement", () => {
  expect(texts("DELIMITER //\nselect 1 //", "postgres")).toEqual(["DELIMITER //\nselect 1 //"]);
  // A column named `delimiter` at the start of a line is not the command.
  expect(texts("select a,\ndelimiter from t; select 2", "mySql")).toEqual([
    "select a,\ndelimiter from t",
    "select 2",
  ]);
  // Not followed by an argument: plain text.
  expect(texts("delimiter_x; select 1", "mySql")).toEqual(["delimiter_x", "select 1"]);
});

test("a compound body is kept whole with the default delimiter", () => {
  const proc =
    "CREATE DEFINER=`root`@`%` PROCEDURE p(IN n INT)\nBEGIN\n  DECLARE i INT DEFAULT 0;\n" +
    "  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN SET i = -1; END;\n" +
    "  lbl: WHILE i < n DO\n    SET i = i + 1;\n    IF i = 2 THEN ITERATE lbl; ELSEIF i > 5 THEN LEAVE lbl; ELSE SET @x = 1; END IF;\n" +
    "  END WHILE lbl;\n  REPEAT SET i = i - 1; UNTIL i <= 0 END REPEAT;\n" +
    "  CASE n WHEN 1 THEN SELECT CASE WHEN i THEN 1 ELSE 2 END; ELSE BEGIN SELECT 3; END; END CASE;\n" +
    "  inner_block: BEGIN SELECT IF(i, 1, 2), REPEAT('a', 2); END inner_block;\nEND";
  expect(texts(`${proc};\nCALL p(3);`, "mySql")).toEqual([proc, "CALL p(3)"]);
});

test("functions, triggers, events and MariaDB BEGIN NOT ATOMIC keep their bodies", () => {
  const fn = "CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC\nBEGIN\n  DECLARE y INT;\n  SET y = x * 2;\n  RETURN y;\nEND";
  const trg =
    "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW FOLLOWS other\nBEGIN\n  SET NEW.a = 1;\n  SET NEW.b = 2;\nEND";
  const ev = "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; INSERT INTO t VALUES (1); END";
  const anon = "BEGIN NOT ATOMIC\n  SELECT 1;\n  SELECT 2;\nEND";
  expect(texts([fn, trg, ev, anon, "select 9"].join(";\n"), "mySql")).toEqual([fn, trg, ev, anon, "select 9"]);
});

test("bodiless routines and other statements still split on ;", () => {
  expect(texts("CREATE PROCEDURE p() SELECT 1; SELECT 2", "mySql")).toEqual([
    "CREATE PROCEDURE p() SELECT 1",
    "SELECT 2",
  ]);
  expect(texts("BEGIN; select 1; COMMIT", "mySql")).toEqual(["BEGIN", "select 1", "COMMIT"]);
  expect(texts("create table function (begin int); select 1", "mySql")).toEqual([
    "create table function (begin int)",
    "select 1",
  ]);
});

test("SQLite triggers and PostgreSQL BEGIN ATOMIC bodies are kept whole", () => {
  const sqliteTrg =
    "CREATE TRIGGER t AFTER INSERT ON x WHEN new.a > 0 BEGIN\n  UPDATE y SET n = CASE WHEN n IS NULL THEN 1 ELSE n + 1 END;\n  DELETE FROM z;\nEND";
  expect(texts(`${sqliteTrg}; select 1`, "sqlite")).toEqual([sqliteTrg, "select 1"]);
  const pgProc = "CREATE PROCEDURE ins(a int) LANGUAGE SQL BEGIN ATOMIC INSERT INTO t VALUES (a); INSERT INTO t VALUES (a); END";
  expect(texts(`${pgProc}; select 1`)).toEqual([pgProc, "select 1"]);
});

test("compound offsets stay exact and statementAt finds the body", () => {
  const sql = "select 0;\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;\nselect 3";
  const st = splitStatements(sql, "mySql");
  expect(st).toHaveLength(3);
  for (const s of st) expect(sql.slice(s.from, s.to)).toBe(s.text);
  expect(statementAt(st, sql.indexOf("SELECT 2"))?.text).toBe(st[1].text);
});

test("delimiterAt gives the delimiter in effect at an offset", () => {
  const sql = "select 1;\nDELIMITER //\nselect 2 //\nDELIMITER ;\nselect 3;";
  expect(delimiterAt(sql, 3, "mySql")).toBe(";");
  expect(delimiterAt(sql, sql.indexOf("select 2"), "mySql")).toBe("//");
  expect(delimiterAt(sql, sql.indexOf("select 3"), "mySql")).toBe(";");
  expect(delimiterAt(sql, sql.indexOf("select 2"), "postgres")).toBe(";");
  // A selection inside the `//` region splits with that delimiter.
  const sel = sql.slice(sql.indexOf("select 2"), sql.indexOf("DELIMITER ;"));
  expect(splitStatements(sel, "mySql", { delimiter: "//" }).map((s) => s.text)).toEqual(["select 2"]);
});

// ---- Review round 1: BEGIN / CASE outside a statement start never open a body ----

test("a BEGIN or CASE that is not at a statement start never glues the next statement", () => {
  const script1 = "create procedure p() begin set @case = 1; end;\ndrop table x;\ncreate procedure q() begin select 1; end;";
  expect(texts(script1, "mySql")).toEqual([
    "create procedure p() begin set @case = 1; end",
    "drop table x",
    "create procedure q() begin select 1; end",
  ]);
  const script2 = "create procedure p() update shifts set begin = now();\ndrop table x;\ncreate procedure q() begin select 1; end;";
  expect(texts(script2, "mySql")).toEqual([
    "create procedure p() update shifts set begin = now()",
    "drop table x",
    "create procedure q() begin select 1; end",
  ]);
  // The inputs that ran `DROP TABLE x` on the servers: the DROP is never in the CREATE.
  for (const sql of [
    "create procedure p() select begin from t; drop table x; end",
    "create procedure p() update t set begin = 1; drop table x; end",
    "create procedure p() set @begin = 1; drop table x; end",
    "create trigger tr before insert on y for each row insert into l select begin from t2; drop table x; end",
    "create event e on schedule every 1 day do select begin from t; drop table x; end",
    "create procedure p() begin declare continue handler for sqlexception select begin from t; end; drop table x; end",
    "create procedure p() begin set @case = 1; end; drop table x; end",
    "create procedure p() begin select t.case from t; end; drop table x; end",
  ]) {
    const st = texts(sql, "mySql");
    expect(st, sql).toContain("drop table x");
    expect(st.find((s) => /^create/i.test(s)), sql).not.toMatch(/drop table/i);
  }
});

test("routine characteristics and non-BEGIN compound bodies", () => {
  const fn =
    "CREATE FUNCTION f(a DECIMAL(10,2)) RETURNS VARCHAR(20) CHARACTER SET utf8mb4 COMMENT 'x; y' " +
    "NOT DETERMINISTIC READS SQL DATA SQL SECURITY INVOKER BEGIN DECLARE s VARCHAR(20); SET s = 'a'; RETURN s; END";
  const loop = "CREATE PROCEDURE p() MODIFIES SQL DATA lbl: LOOP SELECT 1; LEAVE lbl; END LOOP lbl";
  const iff = "CREATE PROCEDURE p() IF @a THEN SELECT 1; ELSE SELECT 2; END IF";
  expect(texts([fn, loop, iff, "select 9"].join(";\n"), "mySql")).toEqual([fn, loop, iff, "select 9"]);
});

// ---- Review round 2: every shape the tracker knows, alone and followed by a DROP ----

const ROUND2_SINGLES = [
  "create function f() returns int return (select 1)",
  "create function f() returns decimal(10,2) deterministic return 1",
  "create function f() returns varchar(10) charset utf8mb4 collate utf8mb4_bin return 'a'",
  "create procedure p() comment 'begin' select 1",
  "create procedure p() comment 'x;y' language sql not deterministic contains sql sql security invoker select 1",
  "create definer = root@localhost procedure p() select 1",
  "create definer=current_user() procedure p() select 1",
  "create definer=`a`@`%` trigger tr before insert on y for each row set new.a = 1",
  "create procedure if not exists p() select 1",
  "create trigger tr before insert on y for each row set new.a = 1",
  "create trigger tr before insert on y for each row follows other set new.a = 1",
  "create event e on schedule every 1 day do begin select 1; end",
  "create event e on schedule every 1 day do select 1",
  "create procedure p() begin end",
  "create procedure p() l: begin select 1; end l",
  "create procedure p() begin not atomic select 1; end",
  "create procedure p() begin if x then select case when a then 1 else 2 end from t; end if; end",
  "create procedure p() begin select case `end` when 1 then 2 end from t; end",
  "create procedure p() begin select t.`end` from t; end",
  "create procedure p() begin -- end;\n select 1; end",
  "create procedure p() begin /* end; */ select 1; end",
  "create procedure p() begin # end;\n select 1; end",
  "create procedure p() begin select 'end;'; end",
  "create procedure p() begin declare c cursor for select begin from t; end",
  "create procedure p() begin declare exit handler for sqlexception begin select 1; end; end",
  "create procedure p() begin repeat set @i = @i + 1; until @i > 3 end repeat; end",
];

test("round 2: each single statement stays whole, and a following DROP is never glued to it", () => {
  for (const single of ROUND2_SINGLES) {
    expect(texts(`${single};  \n`, "mySql"), single).toEqual([single]);
    const st = texts(`${single};\ndrop table x;\ncreate procedure q() begin select 1; end;`, "mySql");
    expect(st, single).toEqual([single, "drop table x", "create procedure q() begin select 1; end"]);
  }
});
